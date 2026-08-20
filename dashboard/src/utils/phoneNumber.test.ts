import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizePhoneNumber } from './phoneNumber.ts';

test('normalizes Vietnamese national numbers with the default country code', () => {
  assert.deepEqual(normalizePhoneNumber('090 123 4567'), {
    normalized: '84901234567',
    valid: true,
  });
});

test('preserves explicit international numbers', () => {
  assert.equal(normalizePhoneNumber('+84 901 234 567').normalized, '84901234567');
  assert.equal(normalizePhoneNumber('0084 901 234 567').normalized, '84901234567');
  assert.equal(normalizePhoneNumber('84901234567').normalized, '84901234567');
});

test('supports a custom default country code for local numbers', () => {
  assert.deepEqual(normalizePhoneNumber('(020) 7946 0958', '44'), {
    normalized: '442079460958',
    valid: true,
  });
});

test('rejects empty, invalid country codes and implausible lengths', () => {
  assert.equal(normalizePhoneNumber('').reason, 'empty');
  assert.equal(normalizePhoneNumber('0901234567', '084').reason, 'country-code');
  assert.equal(normalizePhoneNumber('123').reason, 'length');
  assert.equal(normalizePhoneNumber('1234567890123456').reason, 'length');
});
