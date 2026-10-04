import { createHash } from 'node:crypto';
import { invalid } from './recovery-domain.mjs';

const id = (value) => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid('Invalid claim or statement line id', 400);
  return number;
};
const cents = (value) => {
  const amount = Number(value);
  const result = Math.round(amount * 100);
  if (!Number.isFinite(amount) || !Number.isSafeInteger(result) || Math.abs(amount * 100 - result) > 0.00001)
    throw invalid('Statement amount is not a valid cent amount', 422);
  return result;
};
const text = (value, label, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw invalid(`${label} must contain ${min}–${max} characters`, 422);
  return value.trim();
};
function role(user, allowed) { if (!allowed.includes(user.role)) throw invalid('This role cannot change claims', 403); }
async function log(client, user, action, reference, detail) {
  await client.query('INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [user.account_id, user.email, action, 'recovery_claim', String(reference), JSON.stringify(detail)]);
}

export function validateCreditEvidence(claim, source, credit) {
  if (claim.account_id !== source.account_id || claim.account_id !== credit.account_id ||
      claim.feature_id !== source.feature_id || claim.feature_id !== credit.feature_id ||
      claim.record_reference !== source.record_reference || claim.record_reference !== credit.record_reference)
    throw invalid('Credit evidence must belong to the same customer, capability and case', 409);
  if (credit.reconciliation_status !== 'credit_line' || cents(credit.amount) >= 0 ||
      (source.reconciliation_status !== 'recovery_supported' && !claim.delivery_assessment_id))
    throw invalid('Only an imported negative credit line can support this claim', 409);
  if (credit.ingest_id <= source.ingest_id) throw invalid('Credit evidence must come from a later imported statement', 409);
  if (credit.currency !== source.currency) throw invalid('Credit and claim currencies differ', 409);
  if (claim.delivery_assessment_id &&
      String(credit.provenance?.orderId ?? '').trim().toLowerCase() !== String(source.provenance?.orderId ?? '').trim().toLowerCase())
    throw invalid('Delivery platform credit must identify the same order ID as the assessed commission line', 409);
  const creditCents = -cents(credit.amount);
  if (creditCents > Number(claim.requested_cents) - Number(claim.credit_cents))
    throw invalid('Credit line exceeds the remaining claim amount', 409);
  return creditCents;
}

export function mountClaimRoutes(app, { pool, auth }) {
  app.get('/api/claims/candidates', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT line.id,line.feature_id,line.reference,line.record_reference,line.source_file,line.line_number,
          line.amount,line.currency,line.checksum,assessment.id AS delivery_assessment_id,
          assessment.variance_cents::numeric/100 AS delta,policy.id AS policy_id,policy.version AS policy_version,
          policy.restaurant_label
        FROM delivery_commission_assessments assessment
        JOIN delivery_commission_terms policy ON policy.id=assessment.term_id AND policy.account_id=assessment.account_id AND policy.status='APPROVED'
        JOIN statement_lines line ON line.id=assessment.statement_line_id AND line.account_id=assessment.account_id
        JOIN feature_records record ON record.account_id=line.account_id AND record.reference=line.record_reference
          AND record.feature_id='commission-rate-validation' AND coalesce(record.payload->>'__example','false')<>'true'
        LEFT JOIN recovery_claims claim ON claim.statement_line_id=line.id AND claim.account_id=line.account_id
        WHERE assessment.account_id=$1 AND assessment.status='CANDIDATE' AND claim.id IS NULL
          AND NOT EXISTS (
            SELECT 1 FROM statement_lines duplicate
            JOIN feature_records duplicate_record ON duplicate_record.account_id=duplicate.account_id
              AND duplicate_record.reference=duplicate.record_reference AND duplicate_record.feature_id='commission-rate-validation'
            WHERE duplicate.account_id=line.account_id AND duplicate.id<>line.id
              AND duplicate.feature_id='commission-rate-validation'
              AND lower(trim(coalesce(duplicate.provenance->>'orderId','')))=lower(trim(coalesce(line.provenance->>'orderId','')))
              AND lower(trim(regexp_replace(coalesce(duplicate_record.payload->>'platformLocation',''),'[[:space:]]+',' ','g')))=policy.restaurant_key
              AND lower(trim(coalesce(duplicate.provenance->>'feeType','')))='commission'
              AND duplicate.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored')
          )
        ORDER BY assessment.id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });

  app.get('/api/claims', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT claim.*,source.source_file,source.line_number,source.currency,source.checksum,
          policy.version AS policy_version,policy.restaurant_label
        FROM recovery_claims claim JOIN statement_lines source ON source.id=claim.statement_line_id AND source.account_id=claim.account_id
        LEFT JOIN delivery_commission_assessments assessment ON assessment.id=claim.delivery_assessment_id AND assessment.account_id=claim.account_id
        LEFT JOIN delivery_commission_terms policy ON policy.id=assessment.term_id AND policy.account_id=claim.account_id
        WHERE claim.account_id=$1 ORDER BY claim.updated_at DESC,claim.id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });

  app.get('/api/claims/credit-lines', auth, async (req, res, next) => {
    try {
      const claimId = id(req.query.claimId);
      const claim = (await pool.query('SELECT * FROM recovery_claims WHERE account_id=$1 AND id=$2', [req.user.account_id, claimId])).rows[0];
      if (!claim) throw invalid('Claim not found', 404);
      const items = (await pool.query(`SELECT credit.id,credit.source_file,credit.line_number,credit.amount,credit.currency,credit.checksum,credit.reference
        FROM statement_lines credit JOIN statement_lines source ON source.id=$2 AND source.account_id=credit.account_id
        LEFT JOIN claim_credit_evidence used ON used.credit_line_id=credit.id
        WHERE credit.account_id=$1 AND credit.feature_id=$3 AND credit.record_reference=$4
          AND credit.reconciliation_status='credit_line' AND credit.currency=source.currency
          AND credit.ingest_id>source.ingest_id AND used.id IS NULL
          AND ($5::boolean=false OR lower(trim(coalesce(credit.provenance->>'orderId','')))=lower(trim(coalesce(source.provenance->>'orderId',''))))
        ORDER BY credit.id DESC LIMIT 100`, [req.user.account_id, claim.statement_line_id, claim.feature_id, claim.record_reference, Boolean(claim.delivery_assessment_id)])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });

  app.get('/api/claims/:id', auth, async (req, res, next) => {
    try {
      const claimId = id(req.params.id);
      const claim = (await pool.query('SELECT * FROM recovery_claims WHERE account_id=$1 AND id=$2', [req.user.account_id, claimId])).rows[0];
      if (!claim) throw invalid('Claim not found', 404);
      const [events, credits] = await Promise.all([
        pool.query('SELECT * FROM claim_events WHERE account_id=$1 AND claim_id=$2 ORDER BY recorded_at,id', [req.user.account_id, claimId]),
        pool.query(`SELECT evidence.*,line.source_file,line.line_number,line.checksum,line.amount,line.currency FROM claim_credit_evidence evidence
          JOIN statement_lines line ON line.id=evidence.credit_line_id AND line.account_id=evidence.account_id
          WHERE evidence.account_id=$1 AND evidence.claim_id=$2 ORDER BY evidence.recorded_at,evidence.id`, [req.user.account_id, claimId]),
      ]);
      res.json({ claim, events: events.rows, credits: credits.rows });
    } catch (error) { next(error); }
  });

  app.post('/api/claims', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const lineId = id(req.body?.statementLineId);
      const assessmentId = id(req.body?.deliveryAssessmentId);
      client = await pool.connect(); await client.query('BEGIN');
      const line = (await client.query('SELECT * FROM statement_lines WHERE account_id=$1 AND id=$2 FOR UPDATE', [req.user.account_id, lineId])).rows[0];
      if (!line || line.feature_id !== 'commission-rate-validation' || !line.record_reference)
        throw invalid('Select an imported delivery platform settlement line in this customer account', 409);
      const caseRecord = (await client.query(`SELECT id,payload->>'platformLocation' AS restaurant FROM feature_records WHERE account_id=$1 AND reference=$2
        AND feature_id='commission-rate-validation' AND coalesce(payload->>'__example','false')<>'true'`,
      [req.user.account_id, line.record_reference])).rows[0];
      if (!caseRecord) throw invalid('Example cases cannot support a delivery platform fee claim', 409);
      const assessment = (await client.query(`SELECT assessment.*,policy.status AS policy_status,policy.version,
          policy.restaurant_key,policy.effective_on,policy.expires_on,policy.source_id
        FROM delivery_commission_assessments assessment
        JOIN delivery_commission_terms policy ON policy.id=assessment.term_id AND policy.account_id=assessment.account_id
        WHERE assessment.account_id=$1 AND assessment.id=$2 AND assessment.statement_line_id=$3
        FOR UPDATE OF assessment,policy`, [req.user.account_id, assessmentId, lineId])).rows[0];
      if (!assessment || assessment.policy_status !== 'APPROVED' || assessment.status !== 'CANDIDATE')
        throw invalid('A current approved commission-term assessment is required for this claim', 409);
      if (String(caseRecord.restaurant ?? '').trim().replace(/\s+/g, ' ').toLowerCase() !== assessment.restaurant_key)
        throw invalid('Commission term does not match the restaurant on this case', 409);
      const duplicate = (await client.query(`SELECT duplicate.id FROM statement_lines duplicate
        JOIN feature_records other_case ON other_case.account_id=duplicate.account_id
          AND other_case.reference=duplicate.record_reference AND other_case.feature_id='commission-rate-validation'
        WHERE duplicate.account_id=$1 AND duplicate.id<>$2 AND duplicate.feature_id='commission-rate-validation'
          AND lower(trim(coalesce(duplicate.provenance->>'orderId','')))=$3
          AND lower(trim(regexp_replace(coalesce(other_case.payload->>'platformLocation',''),'[[:space:]]+',' ','g')))=$4
          AND lower(trim(coalesce(duplicate.provenance->>'feeType','')))='commission'
          AND duplicate.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored') LIMIT 1`,
      [req.user.account_id, line.id, String(line.provenance?.orderId ?? '').trim().toLowerCase(), assessment.restaurant_key])).rows[0];
      if (duplicate) throw invalid('Multiple imported commission rows share this restaurant and order ID; resolve duplication before claiming', 409);
      const requestedCents = Number(assessment.variance_cents);
      if (!Number.isSafeInteger(requestedCents) || requestedCents <= 0)
        throw invalid('Assessment has no positive fee exception', 409);
      const existing = (await client.query('SELECT * FROM recovery_claims WHERE account_id=$1 AND statement_line_id=$2', [req.user.account_id, lineId])).rows[0];
      if (existing) { await client.query('COMMIT'); return res.json({ claim: existing, alreadyExists: true }); }
      const claim = (await client.query(`INSERT INTO recovery_claims(account_id,feature_id,record_reference,statement_line_id,requested_cents,created_by,delivery_assessment_id)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.user.account_id, line.feature_id, line.record_reference, line.id, requestedCents, req.user.email, assessment.id])).rows[0];
      await log(client, req.user, 'claim_created', claim.id, { sourceLineId: line.id, sourceChecksum: line.checksum,
        assessmentId: assessment.id, policyId: assessment.term_id, policyVersion: assessment.version,
        policySourceId: assessment.source_id, requestedCents,
        scope: 'Candidate variance from an approved operator-supplied commission term; no external claim sent' });
      await client.query('COMMIT'); res.status(201).json({ claim });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });

  app.post('/api/claims/:id/events', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator', 'reviewer']);
      const claimId = id(req.params.id);
      const eventType = String(req.body?.eventType || '').toUpperCase();
      const externalReference = text(req.body?.externalReference, 'External reference', 5, 200);
      const evidenceText = text(req.body?.evidenceText, 'Copied portal or correspondence evidence', 20, 10000);
      client = await pool.connect(); await client.query('BEGIN');
      const claim = (await client.query('SELECT * FROM recovery_claims WHERE account_id=$1 AND id=$2 FOR UPDATE', [req.user.account_id, claimId])).rows[0];
      if (!claim) throw invalid('Claim not found', 404);
      const allowed = { DRAFT: ['SUBMITTED'], SUBMITTED: ['ACKNOWLEDGED', 'REJECTED'] };
      if (!allowed[claim.status]?.includes(eventType)) throw invalid('Claim event does not follow the current status', 409);
      if (eventType === 'SUBMITTED') role(req.user, ['admin', 'operator']);
      const evidenceHash = createHash('sha256').update(evidenceText).digest('hex');
      const event = (await client.query(`INSERT INTO claim_events(account_id,claim_id,event_type,external_reference,evidence_text,evidence_hash,recorded_by)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [req.user.account_id, claim.id, eventType, externalReference, evidenceText, evidenceHash, req.user.email])).rows[0];
      const changed = (await client.query('UPDATE recovery_claims SET status=$1,updated_at=now() WHERE id=$2 AND account_id=$3 RETURNING *', [eventType, claim.id, req.user.account_id])).rows[0];
      await log(client, req.user, 'claim_event_recorded', claim.id, { eventType, externalReference, evidenceHash, scope: 'User-provided external status; provider acceptance not independently verified' });
      await client.query('COMMIT'); res.json({ claim: changed, event });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });

  app.post('/api/claims/:id/credits', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const claimId = id(req.params.id), lineId = id(req.body?.creditLineId);
      const issuerReference = text(req.body?.issuerReference, 'Issuer credit reference', 5, 200);
      client = await pool.connect(); await client.query('BEGIN');
      const claim = (await client.query('SELECT * FROM recovery_claims WHERE account_id=$1 AND id=$2 FOR UPDATE', [req.user.account_id, claimId])).rows[0];
      if (!claim) throw invalid('Claim not found', 404);
      if (!['ACKNOWLEDGED', 'PARTIAL_CREDIT'].includes(claim.status)) throw invalid('Record claim acknowledgement before linking credit evidence', 409);
      const source = (await client.query('SELECT * FROM statement_lines WHERE account_id=$1 AND id=$2', [req.user.account_id, claim.statement_line_id])).rows[0];
      const credit = (await client.query('SELECT * FROM statement_lines WHERE account_id=$1 AND id=$2 FOR UPDATE', [req.user.account_id, lineId])).rows[0];
      if (!source || !credit) throw invalid('Claim or credit source line is missing', 404);
      const creditCents = validateCreditEvidence(claim, source, credit);
      const linked = (await client.query(`INSERT INTO claim_credit_evidence(account_id,claim_id,credit_line_id,credit_cents,issuer_reference,recorded_by)
        VALUES($1,$2,$3,$4,$5,$6) RETURNING *`, [req.user.account_id, claim.id, credit.id, creditCents, issuerReference, req.user.email])).rows[0];
      const total = Number(claim.credit_cents) + creditCents;
      const status = total === Number(claim.requested_cents) ? 'CREDIT_EVIDENCED' : 'PARTIAL_CREDIT';
      const changed = (await client.query('UPDATE recovery_claims SET credit_cents=$1,status=$2,updated_at=now() WHERE id=$3 AND account_id=$4 RETURNING *', [total, status, claim.id, req.user.account_id])).rows[0];
      await log(client, req.user, 'claim_credit_linked', claim.id, { creditLineId: credit.id, creditChecksum: credit.checksum, creditCents, issuerReference, scope: 'Imported statement credit evidence; paid settlement not verified' });
      await client.query('COMMIT'); res.json({ claim: changed, credit: linked });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('This statement credit is already linked to a claim', 409) : error); }
    finally { client?.release(); }
  });
}
