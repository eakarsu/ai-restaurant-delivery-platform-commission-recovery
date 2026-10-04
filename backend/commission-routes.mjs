import { createHash } from 'node:crypto';
import { invalid } from './recovery-domain.mjs';
import { assessCommissionLine, percentUnits, restaurantKey, termDate } from './commission-engine.mjs';

const id = value => {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 1) throw invalid('Invalid agreement source or commission term id', 400);
  return number;
};
const valueText = (value, label, min, max) => {
  if (typeof value !== 'string' || value.trim().length < min || value.length > max)
    throw invalid(`${label} must contain ${min}–${max} characters`);
  return value.trim();
};
const role = (user, allowed) => { if (!allowed.includes(user.role)) throw invalid('This role cannot change commission terms', 403); };
async function audit(client, user, action, reference, detail) {
  await client.query('INSERT INTO audit_events(account_id,actor,action,object_type,object_reference,detail) VALUES($1,$2,$3,$4,$5,$6)',
    [user.account_id, user.email, action, 'commission_term', String(reference), JSON.stringify(detail)]);
}
function citedPercent(quote, value) {
  const rates = [...quote.matchAll(/\b(\d+(?:\.\d{1,4})?)\s*(?:%|percent\b)/gi)];
  if (!rates.some(match => Math.abs(Number(match[1]) - value) < 0.000001))
    throw invalid('Commission percentage and its percent sign or word must appear in the exact cited agreement quote');
  if (!/commission/i.test(quote) || !/subtotal/i.test(quote))
    throw invalid('Cited agreement quote must define commission on the order subtotal');
}

export function mountCommissionRoutes(app, { pool, auth }) {
  app.get('/api/delivery/cases', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,reference,title,payload->>'platformLocation' AS restaurant
        FROM feature_records WHERE account_id=$1 AND feature_id='commission-rate-validation'
        AND coalesce(payload->>'__example','false')<>'true' ORDER BY updated_at DESC,id DESC LIMIT 200`,
      [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/delivery/sources', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT id,title,content_hash,created_by_id,created_at FROM delivery_agreement_sources
        WHERE account_id=$1 ORDER BY id DESC LIMIT 200`, [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.get('/api/delivery/sources/:id', auth, async (req, res, next) => {
    try {
      const source = (await pool.query('SELECT * FROM delivery_agreement_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, id(req.params.id)])).rows[0];
      if (!source) throw invalid('Agreement source not found', 404);
      res.json({ source });
    } catch (error) { next(error); }
  });
  app.post('/api/delivery/sources', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const title = valueText(req.body?.title, 'Agreement title', 3, 200);
      const content = valueText(req.body?.content, 'Operator-entered agreement text', 30, 500000);
      const hash = createHash('sha256').update(content).digest('hex');
      client = await pool.connect(); await client.query('BEGIN');
      const source = (await client.query(`INSERT INTO delivery_agreement_sources(account_id,title,content,content_hash,created_by_id)
        VALUES($1,$2,$3,$4,$5) RETURNING id,title,content_hash,created_by_id,created_at`,
      [req.user.account_id, title, content, hash, req.user.id])).rows[0];
      await audit(client, req.user, 'agreement_text_saved', source.id, { title, hash,
        scope: 'Operator-entered source text; original signed agreement authenticity not verified' });
      await client.query('COMMIT'); res.status(201).json({ source });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });

  app.get('/api/delivery/terms', auth, async (req, res, next) => {
    try {
      const items = (await pool.query(`SELECT term.*,source.title AS source_title,source.content_hash AS source_hash
        FROM delivery_commission_terms term
        JOIN delivery_agreement_sources source ON source.id=term.source_id AND source.account_id=term.account_id
        WHERE term.account_id=$1 ORDER BY term.created_at DESC,term.id DESC LIMIT 200`,
      [req.user.account_id])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/delivery/terms', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator']);
      const body = req.body || {};
      const restaurantLabel = valueText(body.restaurant, 'Platform / restaurant', 2, 200);
      const restaurant = restaurantKey(restaurantLabel);
      const effectiveOn = termDate(body.effectiveOn, 'Term effective date');
      const expiresOn = termDate(body.expiresOn, 'Term expiry date');
      if (effectiveOn > expiresOn) throw invalid('Term expiry must be on or after the effective date');
      const units = percentUnits(body.percent);
      const sourceId = id(body.sourceId);
      const locator = valueText(body.clauseLocator, 'Agreement page or section', 2, 200);
      client = await pool.connect(); await client.query('BEGIN');
      const caseRow = (await client.query(`SELECT id FROM feature_records WHERE account_id=$1 AND feature_id='commission-rate-validation'
        AND lower(trim(regexp_replace(coalesce(payload->>'platformLocation',''),'[[:space:]]+',' ','g')))=$2
        AND coalesce(payload->>'__example','false')<>'true' LIMIT 1`, [req.user.account_id, restaurant])).rows[0];
      if (!caseRow) throw invalid('Create a real commission-rate case for this restaurant first', 409);
      const source = (await client.query('SELECT * FROM delivery_agreement_sources WHERE account_id=$1 AND id=$2',
        [req.user.account_id, sourceId])).rows[0];
      if (!source) throw invalid('Select saved agreement text in this customer account', 409);
      const quote = valueText(body.sourceQuote, 'Exact agreement quote', 12, 5000);
      if (!source.content.includes(quote)) throw invalid('Agreement quote must be an exact excerpt of saved source text');
      citedPercent(quote, units / 10000);
      if (!quote.includes(effectiveOn) || !quote.includes(expiresOn))
        throw invalid('Effective and expiry dates must appear in YYYY-MM-DD form in the exact cited agreement quote');
      const version = Number((await client.query(`SELECT coalesce(max(version),0)+1 AS version FROM delivery_commission_terms
        WHERE account_id=$1 AND restaurant_key=$2`, [req.user.account_id, restaurant])).rows[0].version);
      const term = (await client.query(`INSERT INTO delivery_commission_terms(account_id,restaurant_key,restaurant_label,
        effective_on,expires_on,percent_units,source_id,source_quote,clause_locator,version,created_by_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [req.user.account_id, restaurant, restaurantLabel, effectiveOn, expiresOn,
        units, sourceId, quote, locator, version, req.user.id])).rows[0];
      await audit(client, req.user, 'commission_term_drafted', term.id, { restaurant, version, effectiveOn,
        expiresOn, percentUnits: units, sourceHash: source.content_hash });
      await client.query('COMMIT'); res.status(201).json({ term });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('This term version was created concurrently; reload and retry', 409) : error); }
    finally { client?.release(); }
  });

  app.post('/api/delivery/terms/:id/approve', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'reviewer']);
      const termId = id(req.params.id);
      const rationale = valueText(req.body?.rationale, 'Independent review rationale', 20, 2000);
      client = await pool.connect(); await client.query('BEGIN');
      const term = (await client.query('SELECT * FROM delivery_commission_terms WHERE account_id=$1 AND id=$2 FOR UPDATE',
        [req.user.account_id, termId])).rows[0];
      if (!term) throw invalid('Commission term not found', 404);
      if (term.status !== 'DRAFT') throw invalid('Only draft commission terms can be approved', 409);
      if (String(term.created_by_id) === String(req.user.id)) throw invalid('The term creator cannot approve their own rule', 403);
      await client.query(`UPDATE delivery_commission_terms SET status='SUPERSEDED' WHERE account_id=$1
        AND restaurant_key=$2 AND status='APPROVED'`, [req.user.account_id, term.restaurant_key]);
      const approved = (await client.query(`UPDATE delivery_commission_terms SET status='APPROVED',approved_by_id=$1,
        approved_at=now() WHERE account_id=$2 AND id=$3 RETURNING *`, [req.user.id, req.user.account_id, termId])).rows[0];
      await audit(client, req.user, 'commission_term_approved', termId, { version: term.version, rationale,
        scope: 'Independent review of operator-entered terms; original signed agreement authenticity not verified' });
      await client.query('COMMIT'); res.json({ term: approved });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error.code === '23505' ? invalid('Another term version was approved concurrently; reload', 409) : error); }
    finally { client?.release(); }
  });

  app.get('/api/delivery/terms/:id/assessments', auth, async (req, res, next) => {
    try {
      const termId = id(req.params.id);
      const term = (await pool.query('SELECT id FROM delivery_commission_terms WHERE account_id=$1 AND id=$2',
        [req.user.account_id, termId])).rows[0];
      if (!term) throw invalid('Commission term not found', 404);
      const items = (await pool.query(`SELECT assessment.*,line.source_file,line.line_number,line.checksum,line.description,
        line.amount,line.statement_date,line.currency FROM delivery_commission_assessments assessment
        JOIN statement_lines line ON line.id=assessment.statement_line_id AND line.account_id=assessment.account_id
        WHERE assessment.account_id=$1 AND assessment.term_id=$2 ORDER BY assessment.id DESC LIMIT 500`,
      [req.user.account_id, termId])).rows;
      res.json({ items });
    } catch (error) { next(error); }
  });
  app.post('/api/delivery/terms/:id/assess', auth, async (req, res, next) => {
    let client;
    try {
      role(req.user, ['admin', 'operator', 'reviewer']);
      const termId = id(req.params.id);
      client = await pool.connect(); await client.query('BEGIN');
      const term = (await client.query(`SELECT term.*,source.content_hash AS source_hash
        FROM delivery_commission_terms term
        JOIN delivery_agreement_sources source ON source.id=term.source_id AND source.account_id=term.account_id
        WHERE term.account_id=$1 AND term.id=$2 FOR UPDATE OF term`, [req.user.account_id, termId])).rows[0];
      if (!term) throw invalid('Commission term not found', 404);
      if (term.status !== 'APPROVED') throw invalid('Only approved commission terms can assess imported settlements', 409);
      const lines = (await client.query(`WITH eligible AS (
          SELECT line.*,count(*) OVER(PARTITION BY lower(trim(coalesce(line.provenance->>'orderId','')))) AS order_line_count
          FROM statement_lines line
          JOIN feature_records record ON record.account_id=line.account_id AND record.reference=line.record_reference
            AND record.feature_id='commission-rate-validation'
          WHERE line.account_id=$1 AND line.feature_id='commission-rate-validation'
            AND lower(trim(regexp_replace(coalesce(record.payload->>'platformLocation',''),'[[:space:]]+',' ','g')))=$2
            AND coalesce(record.payload->>'__example','false')<>'true'
            AND lower(trim(coalesce(line.provenance->>'feeType','')))='commission'
            AND line.statement_date BETWEEN $3 AND $4
            AND line.reconciliation_status NOT IN ('rejected','credit_line','seeded_example_ignored')
        ) SELECT eligible.* FROM eligible
        LEFT JOIN delivery_commission_assessments prior ON prior.statement_line_id=eligible.id
          AND prior.term_id=$5 AND prior.account_id=eligible.account_id
        WHERE prior.id IS NULL ORDER BY eligible.id LIMIT 1001`,
      [req.user.account_id, term.restaurant_key, term.effective_on, term.expires_on, term.id])).rows;
      const hasMore = lines.length > 1000;
      let assessed = 0;
      for (const line of lines.slice(0, 1000)) {
        const result = assessCommissionLine(term, line);
        if (Number(line.order_line_count) > 1 && result.status === 'CANDIDATE') {
          result.status = 'INSUFFICIENT'; result.varianceCents = null;
          result.calculation.reason = 'Multiple commission rows share this restaurant and order ID; resolve duplication before claiming';
        }
        const saved = await client.query(`INSERT INTO delivery_commission_assessments(account_id,term_id,statement_line_id,
          observed_cents,expected_cents,variance_cents,status,calculation)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(term_id,statement_line_id) DO NOTHING RETURNING id`,
        [req.user.account_id, term.id, line.id, result.observedCents, result.expectedCents,
          result.varianceCents, result.status, { ...result.calculation, termSourceId: term.source_id,
            termSourceHash: term.source_hash, clauseLocator: term.clause_locator }]);
        if (saved.rowCount) assessed++;
      }
      if (assessed) await audit(client, req.user, 'commission_lines_assessed', termId, { version: term.version,
        assessed, scope: 'Immutable calculations from imported lines; no platform dispute filed or credit verified' });
      await client.query('COMMIT'); res.json({ termId, newAssessments: assessed,
        reviewedLines: Math.min(lines.length, 1000), hasMore });
    } catch (error) { if (client) await client.query('ROLLBACK'); next(error); }
    finally { client?.release(); }
  });
}
