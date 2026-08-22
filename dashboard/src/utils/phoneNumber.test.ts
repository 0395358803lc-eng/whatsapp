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
  assert.equal(normalizePhoneNumber('442079460958').normalized, '442079460958');
});

test('prefixes national numbers that do not use a trunk zero', () => {
  assert.equal(normalizePhoneNumber('415 555 2671', '1').normalized, '14155552671');
  assert.equal(normalizePhoneNumber('98765 43210', '91').normalized, '919876543210');
});

test('normalizes common national trunk-zero formats across selected countries', () => {
  const cases = [
    ['(020) 7946 0958', '44', '442079460958'],
    ['0151 23456789', '49', '4915123456789'],
    ['06 12 34 56 78', '33', '33612345678'],
    ['081 234 5678', '66', '66812345678'],
    ['0812 3456 7890', '62', '6281234567890'],
    ['0412 345 678', '61', '61412345678'],
    ['090-1234-5678', '81', '819012345678'],
  ] as const;

  for (const [input, countryCode, expected] of cases) {
    assert.equal(normalizePhoneNumber(input, countryCode).normalized, expected, `${countryCode}: ${input}`);
  }
});

test('rejects letters and unsupported punctuation instead of silently stripping them', () => {
  assert.equal(normalizePhoneNumber('090abc1234567').reason, 'format');
  assert.equal(normalizePhoneNumber('090/123/4567').reason, 'format');
  assert.equal(normalizePhoneNumber('84+901234567').reason, 'format');
  assert.equal(normalizePhoneNumber('++84901234567').reason, 'format');
});

test('rejects empty, invalid country codes and implausible lengths', () => {
  assert.equal(normalizePhoneNumber('').reason, 'empty');
  assert.equal(normalizePhoneNumber('0901234567', '084').reason, 'country-code');
  assert.equal(normalizePhoneNumber('123', '84').reason, 'length');
  assert.equal(normalizePhoneNumber('+1234567890123456').reason, 'length');
});
