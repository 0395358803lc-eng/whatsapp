import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNumberCheckTemplateXlsx,
  buildXlsxBytes,
  parseDelimitedPhoneRows,
  parseXlsxPhoneRows,
  readPhoneRowsFromFile,
} from './excelNumberCheck.ts';

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

function findSignature(bytes: Uint8Array, signature: number, fromEnd = false): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (fromEnd) {
    for (let offset = bytes.length - 4; offset >= 0; offset -= 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
  } else {
    for (let offset = 0; offset <= bytes.length - 4; offset += 1) {
      if (view.getUint32(offset, true) === signature) return offset;
    }
  }
  return -1;
}

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

test('rejects oversized CSV before materializing its text', async () => {
  let textCalled = false;
  const file = {
    name: 'numbers.csv',
    size: 4 * 1024 * 1024 + 1,
    text: async () => {
      textCalled = true;
      return '';
    },
  } as File;

  await assert.rejects(readPhoneRowsFromFile(file), /CSV file is too large/);
  assert.equal(textCalled, false);
});

test('rejects oversized XLSX before materializing its array buffer', async () => {
  let arrayBufferCalled = false;
  const file = {
    name: 'numbers.xlsx',
    size: 8 * 1024 * 1024 + 1,
    arrayBuffer: async () => {
      arrayBufferCalled = true;
      return new ArrayBuffer(0);
    },
  } as File;

  await assert.rejects(readPhoneRowsFromFile(file), /Excel file is too large/);
  assert.equal(arrayBufferCalled, false);
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
  const rows = await parseXlsxPhoneRows(toArrayBuffer(bytes));
  assert.deepEqual(rows, [
    { sourceRow: 2, original: '+84901234567' },
    { sourceRow: 3, original: '+14155552671' },
  ]);
});

test('rejects malformed and truncated XLSX ZIP data', async () => {
  await assert.rejects(parseXlsxPhoneRows(new Uint8Array([0x50, 0x4b, 0x03, 0x04]).buffer), /readable ZIP workbook/);
});

test('rejects XLSX archives with excessive declared entry counts', async () => {
  const bytes = buildNumberCheckTemplateXlsx().slice();
  const eocd = findSignature(bytes, 0x06054b50, true);
  assert.ok(eocd >= 0);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint16(eocd + 10, 257, true);

  await assert.rejects(parseXlsxPhoneRows(toArrayBuffer(bytes)), /too many ZIP entries/);
});

test('rejects XLSX entries with unsafe declared expansion before decompression', async () => {
  const bytes = buildNumberCheckTemplateXlsx().slice();
  const central = findSignature(bytes, 0x02014b50);
  assert.ok(central >= 0);
  new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(central + 24, 17 * 1024 * 1024, true);

  await assert.rejects(parseXlsxPhoneRows(toArrayBuffer(bytes)), /too large after decompression/);
});

test('download template contains international example numbers', async () => {
  const bytes = buildNumberCheckTemplateXlsx();
  const rows = await parseXlsxPhoneRows(toArrayBuffer(bytes));
  assert.equal(rows.length, 2);
  assert.equal(rows[0].original, '+84901234567');
});
