import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNumberCheckTemplateXlsx,
  buildXlsxBytes,
  parseDelimitedPhoneRows,
  parseXlsxPhoneRows,
} from './excelNumberCheck.ts';

test('CSV import detects a phone header and keeps source row numbers', () => {
  const rows = parseDelimitedPhoneRows('name,phone_number\nAlice,+84901234567\nBob,+14155552671\n');
  assert.deepEqual(rows, [
    { sourceRow: 2, original: '+84901234567' },
    { sourceRow: 3, original: '+14155552671' },
  ]);
});

test('CSV import supports semicolon files and Vietnamese headers', () => {
  const rows = parseDelimitedPhoneRows('Tên;Số điện thoại\nAn;84901234567\n');
  assert.deepEqual(rows, [{ sourceRow: 2, original: '84901234567' }]);
});

test('XLSX writer produces a workbook the importer can read', async () => {
  const bytes = buildXlsxBytes(
    [
      ['name', 'phone'],
      ['Alice', '+84901234567'],
      ['Bob', '+14155552671'],
    ],
    'Input',
  );
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const rows = await parseXlsxPhoneRows(buffer);
  assert.deepEqual(rows, [
    { sourceRow: 2, original: '+84901234567' },
    { sourceRow: 3, original: '+14155552671' },
  ]);
});

test('download template contains international example numbers', async () => {
  const bytes = buildNumberCheckTemplateXlsx();
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const rows = await parseXlsxPhoneRows(buffer);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].original, '+84901234567');
});
