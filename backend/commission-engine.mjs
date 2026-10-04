import { amount, invalid } from './recovery-domain.mjs';

export const restaurantKey = value => String(value ?? '').trim().replace(/\s+/g, ' ').toLowerCase();
const validDay = value => /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value;
const isoDay = value => value instanceof Date ? value.toISOString().slice(0, 10) : String(value ?? '').slice(0, 10);

export function percentUnits(value) {
  const text = String(value ?? '').trim();
  if (!/^\d+(?:\.\d{1,4})?$/.test(text) || Number(text) > 100)
    throw invalid('Commission percentage must be 0–100 with at most four decimal places');
  const [whole, fraction = ''] = text.split('.');
  return Number(BigInt(whole) * 10000n + BigInt(fraction.padEnd(4, '0')));
}
export function termDate(value, label) {
  const date = String(value ?? '');
  if (!validDay(date)) throw invalid(`${label} must be a valid YYYY-MM-DD date`);
  return date;
}

export function assessCommissionLine(term, line) {
  const date = String(line.statement_date ?? '');
  if (!validDay(date) || date < isoDay(term.effective_on) || date > isoDay(term.expires_on))
    throw invalid('Settlement line is outside the approved fee-term date window', 409);
  if (line.currency !== 'USD') throw invalid('Commission assessment currently supports USD settlement lines only', 409);
  if (restaurantKey(line.provenance?.feeType) !== 'commission')
    throw invalid('Only an explicit commission settlement line can be assessed', 409);
  if (Number(line.amount) < 0) throw invalid('A credit line is not a commission exception candidate', 409);
  const observed = amount(line.amount, 'Commission charged');
  const subtotalRaw = line.provenance?.orderSubtotal;
  const orderId = String(line.provenance?.orderId ?? '').trim();
  if (subtotalRaw === undefined || subtotalRaw === null || String(subtotalRaw).trim() === '' || !orderId)
    return { observedCents: observed, expectedCents: null, varianceCents: null, status: 'INSUFFICIENT',
      calculation: { reason: !orderId ? 'Order ID missing from imported settlement line' : 'Commissionable order subtotal missing from imported settlement line',
        termId: term.id, termVersion: term.version, settlementDate: date } };
  const subtotalCents = amount(subtotalRaw, 'Commissionable order subtotal');
  const expectedCents = Number((BigInt(subtotalCents) * BigInt(term.percent_units) + 500000n) / 1000000n);
  if (!Number.isSafeInteger(expectedCents)) throw invalid('Calculated commission exceeds supported precision');
  const varianceCents = observed - expectedCents;
  return {
    observedCents: observed, expectedCents, varianceCents,
    status: varianceCents > 0 ? 'CANDIDATE' : 'NO_VARIANCE',
    calculation: {
      method: 'order-subtotal-times-approved-commission-percent-v1', termId: term.id, termVersion: term.version,
      settlementDate: date, statementChecksum: line.checksum, statementLine: line.line_number,
      orderId, subtotalCents, percentUnits: term.percent_units, observedCents: observed,
      expectedCents, signedVarianceCents: varianceCents,
      scope: 'Candidate commission exception from an imported platform line and independently approved operator-supplied terms; signed agreement authenticity, dispute filing and credit receipt are not verified',
    },
  };
}
