import test from 'node:test';
import assert from 'node:assert/strict';
import { formatDurationMinutes, withLocalDate, withLocalMinute } from '../shared/date-time-fields';
import { Temporal } from '@js-temporal/polyfill';

test('date/time controls preserve measured precision until the relevant minute changes', () => {
  const measured = '2026-10-22T19:07:43.123';
  assert.equal(withLocalMinute(measured, '19:07'), measured);
  assert.equal(withLocalDate(measured, '2026-10-23'), '2026-10-23T19:07:43.123');
  assert.equal(withLocalMinute(measured, '19:08'), '2026-10-22T19:08:00');
  assert.equal(withLocalMinute(measured, '00:00'), '2026-10-22T00:00:00');
  assert.throws(() => withLocalDate(measured, '2026-02-30'));
  assert.throws(() => withLocalMinute(measured, '25:15'));
});

test('picker values use canonical timezone conversion and reject both DST ambiguities', () => {
  const spring = withLocalDate('2026-10-03T02:30:14', '2026-10-04');
  assert.throws(() => Temporal.PlainDateTime.from(spring).toZonedDateTime('Australia/Sydney', { disambiguation: 'reject' }));
  const autumn = withLocalDate('2026-04-04T02:30:14', '2026-04-05');
  assert.throws(() => Temporal.PlainDateTime.from(autumn).toZonedDateTime('Australia/Sydney', { disambiguation: 'reject' }));
  assert.equal(Temporal.PlainDateTime.from('2026-10-22T19:07:43.123').toZonedDateTime('Australia/Sydney', { disambiguation: 'reject' }).toInstant().toString(), '2026-10-22T08:07:43.123Z');
  assert.deepEqual([0, 0.5, 30, 90, 120].map(formatDurationMinutes), ['0 min', '<1 min', '30 min', '1 h 30 min', '2 h']);
});
