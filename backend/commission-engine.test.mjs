import test from 'node:test';
import assert from 'node:assert/strict';
import { assessCommissionLine, percentUnits, termDate } from './commission-engine.mjs';

const term = { id: 1, version: 1, effective_on: '2026-01-01', expires_on: '2026-12-31', percent_units: percentUnits('15') };
const line = { amount: '18.00', currency: 'USD', statement_date: '2026-07-18', checksum: 'abc',
  line_number: 2, provenance: { feeType: 'commission', orderId: 'ORDER-1', orderSubtotal: '100.00' } };

test('commission uses exact cents on the imported order subtotal', () => {
  const result = assessCommissionLine(term, line);
  assert.equal(result.expectedCents, 1500);
  assert.equal(result.varianceCents, 300);
  assert.equal(result.status, 'CANDIDATE');
  assert.equal(result.calculation.orderId, 'ORDER-1');
  assert.match(result.calculation.scope, /authenticity/);
  assert.equal(assessCommissionLine(term, { ...line, amount: '15.00' }).status, 'NO_VARIANCE');
});

test('commission rounds half up and requires an order ID and subtotal', () => {
  const rounded = assessCommissionLine({ ...term, percent_units: percentUnits('5') },
    { ...line, amount: '1.00', provenance: { feeType: 'commission', orderId: 'ORDER-2', orderSubtotal: '9.99' } });
  assert.equal(rounded.expectedCents, 50);
  assert.equal(assessCommissionLine(term, { ...line, provenance: { feeType: 'commission', orderId: 'ORDER-1' } }).status, 'INSUFFICIENT');
  assert.equal(assessCommissionLine(term, { ...line, provenance: { feeType: 'commission', orderSubtotal: '100.00' } }).status, 'INSUFFICIENT');
  assert.throws(() => assessCommissionLine(term, { ...line, statement_date: '2027-01-01' }), /date window/);
  assert.throws(() => assessCommissionLine(term, { ...line, provenance: { feeType: 'delivery', orderId: 'ORDER-1', orderSubtotal: '100.00' } }), /explicit commission/);
  assert.throws(() => assessCommissionLine(term, { ...line, provenance: { feeType: 'commission', orderId: 'ORDER-1', orderSubtotal: '100.001' } }), /two decimal/);
});

test('term inputs reject invalid dates and excessive percentage precision', () => {
  assert.equal(percentUnits('2.1250'), 21250);
  assert.throws(() => percentUnits('2.12501'), /four decimal/);
  assert.throws(() => termDate('2026-02-30', 'Effective date'), /valid/);
});
