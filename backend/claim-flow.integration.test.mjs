import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import bcrypt from 'bcryptjs';

test('two customers keep agreement evidence, commission assessments, claims and credits separate', {
  skip: !process.env.RECOVERY_INTEGRATION_DATABASE_URL,
}, async () => {
  process.env.DATABASE_URL = process.env.RECOVERY_INTEGRATION_DATABASE_URL;
  process.env.APP_TEST_NO_LISTEN = 'true';
  const { app, pool } = await import('./server.mjs');
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const request = async (path, token, body, method = 'GET') => {
    const response = await fetch(base + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: response.status, data: await response.json() };
  };
  try {
    const reference = `CASE-${randomUUID()}`;
    const restaurant = 'QuickDish / Harbor Kitchen #18';
    const password = `Test-${randomUUID()}`;
    const accounts = [
      { id: randomUUID(), email: `a-${randomUUID()}@example.test` },
      { id: randomUUID(), email: `b-${randomUUID()}@example.test` },
    ];
    for (const account of accounts) {
      await pool.query('INSERT INTO customer_accounts(id,name) VALUES($1,$2)', [account.id, account.email]);
      await pool.query("INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,$4,'admin')",
        [account.id, account.email, await bcrypt.hash(password, 4), account.email]);
      const reviewerEmail = `reviewer-${randomUUID()}@example.test`;
      await pool.query("INSERT INTO app_users(account_id,email,password_hash,name,role) VALUES($1,$2,$3,'Reviewer','reviewer')",
        [account.id, reviewerEmail, await bcrypt.hash(password, 4)]);
      await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
        VALUES($1,'commission-rate-validation',$2,'Settlement integration case','Open',$3,'Not assessed',current_date+30,18.00,$4)`,
      [account.id, reference, account.email, { platformLocation: restaurant }]);
      account.token = (await request('/api/auth/login', null, { email: account.email, password }, 'POST')).data.token;
      account.reviewerToken = (await request('/api/auth/login', null, { email: reviewerEmail, password }, 'POST')).data.token;
      assert.ok(account.token); assert.ok(account.reviewerToken);
    }
    const sourceFile = `reference,description,fee_type,order_id,order_subtotal,amount,date\n${reference},Commission charge,commission,ORDER-1,100.00,18.00,2026-07-18\n`;
    const path = '/api/features/commission-rate-validation/ingest';
    const importedA = await request(path, accounts[0].token, { text: sourceFile, sourceFile: 'settlement.csv' }, 'POST');
    const importedB = await request(path, accounts[1].token, { text: sourceFile, sourceFile: 'settlement.csv' }, 'POST');
    assert.equal(importedA.status, 201);
    assert.equal(importedB.status, 201, 'identical checksum is valid in another account');
    assert.equal(importedA.data.checksum, importedB.data.checksum);
    assert.equal((await request(`/api/statement-ingests/${importedB.data.ingestId}`, accounts[0].token)).status, 404);
    const exampleReference = `EXAMPLE-${randomUUID()}`;
    await pool.query(`INSERT INTO feature_records(account_id,feature_id,reference,title,status,owner,risk,due_date,amount,payload)
      VALUES($1,'commission-rate-validation',$2,'Example only','Open','system','Not assessed',current_date+30,18.00,$3)`,
    [accounts[0].id, exampleReference, { platformLocation: restaurant, __example: true }]);
    const exampleFile = `reference,description,fee_type,order_id,order_subtotal,amount,date\n${exampleReference},Example commission,commission,EXAMPLE-ORDER,100.00,18.00,2026-07-18\n`;
    assert.equal((await request(path, accounts[0].token, { text: exampleFile, sourceFile: 'example-settlement.csv' }, 'POST')).status, 201);
    assert.equal((await request('/api/claims/candidates', accounts[0].token)).data.items.length, 0,
      'typed eligible amounts and imported lines cannot bypass policy approval');

    const quote = 'Commission is 15% of the order subtotal for each order from 2026-01-01 through 2026-12-31.';
    for (const account of accounts) {
      const savedSource = await request('/api/delivery/sources', account.token,
        { title: '2026 commission schedule', content: `Section 4.2. ${quote}` }, 'POST');
      assert.equal(savedSource.status, 201);
      account.sourceId = savedSource.data.source.id;
      const input = { restaurant, effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
        percent: '15',  sourceId: account.sourceId, sourceQuote: quote, clauseLocator: '§4.2' };
      assert.equal((await request('/api/delivery/terms', account.token,
        { ...input, sourceQuote: 'Invented policy language that is not in the source.' }, 'POST')).status, 422);
      assert.equal((await request('/api/delivery/terms', account.token,
        { ...input, percent: '16' }, 'POST')).status, 422);
      const drafted = await request('/api/delivery/terms', account.token, input, 'POST');
      assert.equal(drafted.status, 201, JSON.stringify(drafted.data));
      account.policyId = drafted.data.term.id;
      assert.equal(drafted.data.term.version, 1);
      assert.equal((await request(`/api/delivery/terms/${account.policyId}/approve`, account.token,
        { rationale: 'I checked the policy quote and exact fee terms.' }, 'POST')).status, 403);
      assert.equal((await request(`/api/delivery/terms/${account.policyId}/approve`, account.reviewerToken,
        { rationale: 'I checked the policy quote and exact fee terms.' }, 'POST')).status, 200);
      const assessed = await request(`/api/delivery/terms/${account.policyId}/assess`, account.token, {}, 'POST');
      assert.equal(assessed.status, 200, JSON.stringify(assessed.data));
      assert.equal(assessed.data.newAssessments, 1);
    }
    assert.equal((await request(`/api/delivery/sources/${accounts[1].sourceId}`, accounts[0].token)).status, 404);
    const perOrderQuote = 'Commission is 15% of gross sale for each order from 2026-01-01 through 2026-12-31.';
    const unsupported = await request('/api/delivery/sources', accounts[0].token,
      { title: 'Per-order schedule requiring order grouping', content: `Section 4.3. ${perOrderQuote}` }, 'POST');
    assert.equal(unsupported.status, 201);
    assert.equal((await request('/api/delivery/terms', accounts[0].token, {
      restaurant, effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
      percent: '15',  sourceId: unsupported.data.source.id,
      sourceQuote: perOrderQuote, clauseLocator: '§4.3',
    }, 'POST')).status, 422);
    const candidatesA = (await request('/api/claims/candidates', accounts[0].token)).data.items;
    const candidatesB = (await request('/api/claims/candidates', accounts[1].token)).data.items;
    assert.equal(candidatesA.length, 1); assert.equal(candidatesB.length, 1);
    const aLine = candidatesA[0], bLine = candidatesB[0];
    assert.equal(Number(aLine.delta), 3);
    assert.notEqual(aLine.id, bLine.id);
    await assert.rejects(pool.query(`INSERT INTO recovery_claims(account_id,feature_id,record_reference,statement_line_id,requested_cents,created_by)
      VALUES($1,'commission-rate-validation',$2,$3,300,'integration')`, [accounts[0].id, reference, bLine.id]), { code: '23503' });
    assert.equal((await request('/api/claims', accounts[0].token,
      { statementLineId: bLine.id, deliveryAssessmentId: bLine.delivery_assessment_id }, 'POST')).status, 409);
    const claimA = await request('/api/claims', accounts[0].token,
      { statementLineId: aLine.id, deliveryAssessmentId: aLine.delivery_assessment_id }, 'POST');
    const claimB = await request('/api/claims', accounts[1].token,
      { statementLineId: bLine.id, deliveryAssessmentId: bLine.delivery_assessment_id }, 'POST');
    assert.equal(claimA.status, 201); assert.equal(claimB.status, 201);
    assert.equal((await request(`/api/claims/${claimB.data.claim.id}`, accounts[0].token)).status, 404);
    const eventPath = `/api/claims/${claimA.data.claim.id}/events`;
    assert.equal((await request(eventPath, accounts[0].token,
      { eventType: 'SUBMITTED', externalReference: 'PORTAL-12345', evidenceText: 'Claim entered into the delivery platform portal on the recorded date.' }, 'POST')).status, 200);
    assert.equal((await request(eventPath, accounts[0].token,
      { eventType: 'ACKNOWLEDGED', externalReference: 'ACK-12345', evidenceText: 'Delivery platform acknowledgement copied from portal message.' }, 'POST')).status, 200);
    const creditFile = `reference,description,order_id,amount,date\n${reference},First credit,ORDER-1,-1.20,2026-07-25\n${reference},Second credit,ORDER-1,-1.80,2026-07-25\n${reference},Unrelated order credit,ORDER-OTHER,-1.00,2026-07-25\n`;
    assert.equal((await request(path, accounts[0].token, { text: creditFile, sourceFile: 'settlement-credit.csv' }, 'POST')).status, 201);
    const credits = (await request(`/api/claims/credit-lines?claimId=${claimA.data.claim.id}`, accounts[0].token)).data.items;
    assert.equal(credits.length, 2);
    const wrongOrderCredit = (await pool.query(`SELECT id FROM statement_lines WHERE account_id=$1 AND amount=-1.00`, [accounts[0].id])).rows[0];
    assert.equal((await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: wrongOrderCredit.id, issuerReference: 'CREDIT-WRONG-ORDER' }, 'POST')).status, 409);
    const first = await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: credits[0].id, issuerReference: 'CREDIT-12345' }, 'POST');
    assert.equal(first.status, 200); assert.equal(first.data.claim.status, 'PARTIAL_CREDIT');
    const linked = await request(`/api/claims/${claimA.data.claim.id}/credits`, accounts[0].token,
      { creditLineId: credits[1].id, issuerReference: 'CREDIT-12346' }, 'POST');
    assert.equal(linked.status, 200); assert.equal(linked.data.claim.status, 'CREDIT_EVIDENCED');
    assert.equal(Number(linked.data.claim.credit_cents), 300);
    assert.equal((await request(`/api/claims/${claimB.data.claim.id}`, accounts[1].token)).data.claim.status, 'DRAFT');

    const revised = await request('/api/delivery/terms', accounts[0].token,
      { restaurant, effectiveOn: '2026-01-01', expiresOn: '2026-12-31',
        percent: '15',  sourceId: accounts[0].sourceId, sourceQuote: quote, clauseLocator: '§4.2 reviewed' }, 'POST');
    assert.equal(revised.status, 201); assert.equal(revised.data.term.version, 2);
    assert.equal((await request(`/api/delivery/terms/${revised.data.term.id}/approve`, accounts[0].reviewerToken,
      { rationale: 'Second reviewer pass confirms the same fee schedule.' }, 'POST')).status, 200);
    assert.equal((await request(`/api/delivery/terms/${revised.data.term.id}/assess`, accounts[0].token, {}, 'POST')).data.newAssessments, 1);
    const versions = (await request('/api/delivery/terms', accounts[0].token)).data.items;
    assert.equal(versions.find(item => item.id === accounts[0].policyId).status, 'SUPERSEDED');
    assert.equal(versions.find(item => item.id === revised.data.term.id).status, 'APPROVED');
    assert.equal((await request('/api/claims/candidates', accounts[0].token)).data.items.length, 0,
      'superseding the policy cannot duplicate a historical claim');

    const nextFile = `reference,description,fee_type,order_id,order_subtotal,amount,date\n${reference},Second commission,commission,ORDER-2,40.00,7.00,2026-08-01\n`;
    assert.equal((await request(path, accounts[0].token, { text: nextFile, sourceFile: 'settlement-next.csv' }, 'POST')).status, 201);
    assert.equal((await request(`/api/delivery/terms/${revised.data.term.id}/assess`, accounts[0].token, {}, 'POST')).data.newAssessments, 1);
    const nextCandidates = (await request('/api/claims/candidates', accounts[0].token)).data.items;
    assert.equal(nextCandidates.length, 1);
    assert.equal(Number(nextCandidates[0].delta), 1);
    assert.equal((await request('/api/dashboard', accounts[0].token)).data.totals.confirmed_recovery, 4);
    const duplicateFile = `reference,description,fee_type,order_id,order_subtotal,amount,date\n${reference},Duplicate commission,commission,ORDER-2,40.00,7.00,2026-08-02\n`;
    assert.equal((await request(path, accounts[0].token, { text: duplicateFile, sourceFile: 'duplicate-settlement.csv' }, 'POST')).status, 201);
    assert.equal((await request('/api/claims/candidates', accounts[0].token)).data.items.length, 0, 'duplicate order lines cannot remain claim candidates');
    assert.equal((await request('/api/claims', accounts[0].token,
      { statementLineId: nextCandidates[0].id, deliveryAssessmentId: nextCandidates[0].delivery_assessment_id }, 'POST')).status, 409);
    assert.equal((await request('/api/dashboard', accounts[0].token)).data.totals.confirmed_recovery, 3);
  } finally {
    await new Promise(resolve => server.close(resolve));
    await pool.end();
  }
});
