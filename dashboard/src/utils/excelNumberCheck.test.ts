import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildNumberCheckTemplateXlsx,
  buildXlsxBytes,
  parseDelimitedPhoneRows,
  parseXlsxPhoneRows,
  PhoneColumnRequiredError,
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

function findBytes(bytes: Uint8Array, needle: Uint8Array): number {
  outer: for (let offset = 0; offset <= bytes.length - needle.length; offset += 1) {
    for (let index = 0; index < needle.length; index += 1) {
      if (bytes[offset + index] !== needle[index]) continue outer;
    }
    return offset;
  }
  return -1;
}

function replaceAsciiSameLength(bytes: Uint8Array, from: string, to: string): Uint8Array {
  assert.ok(to.length <= from.length, 'replacement must fit without changing ZIP entry sizes');
  const encoder = new TextEncoder();
  const needle = encoder.encode(from);
  const offset = findBytes(bytes, needle);
  assert.ok(offset >= 0, `could not find ${from}`);
  bytes.set(encoder.encode(to.padEnd(from.length, ' ')), offset);
  return bytes;
}

function numericPhoneWorkbook(): Uint8Array {
  const bytes = buildXlsxBytes([['phone_number'], ['901234567']], 'Input').slice();
  return replaceAsciiSameLength(
    bytes,
    't="inlineStr"><is><t xml:space="preserve">901234567</t></is>',
    't="n"><v>901234567</v>',
  );
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

test('CSV import requires explicit column selection when no phone header is recognized', () => {
  const csv = 'customer,contact_value\nAlice,+84901234567\nBob,+14155552671\n';
  assert.throws(
    () => parseDelimitedPhoneRows(csv),
    error =>
      error instanceof PhoneColumnRequiredError &&
      error.columns.length === 2 &&
      error.columns[1].label === 'B — contact_value',
  );

  assert.deepEqual(parseDelimitedPhoneRows(csv, 1), [
    { sourceRow: 2, original: '+84901234567' },
    { sourceRow: 3, original: '+14155552671' },
  ]);
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

test('XLSX import requires explicit column selection when no phone header is recognized', async () => {
  const bytes = buildXlsxBytes(
    [
      ['customer', 'contact_value'],
      ['Alice', '+84901234567'],
      ['Bob', '+14155552671'],
    ],
    'Input',
  );

  await assert.rejects(
    parseXlsxPhoneRows(toArrayBuffer(bytes)),
    error => error instanceof PhoneColumnRequiredError && error.columns[1].label === 'B — contact_value',
  );
  assert.deepEqual(await parseXlsxPhoneRows(toArrayBuffer(bytes), 1), [
    { sourceRow: 2, original: '+84901234567' },
    { sourceRow: 3, original: '+14155552671' },
  ]);
});

test('XLSX parser flags numeric phone cells as unsafe instead of guessing lost formatting', async () => {
  const rows = await parseXlsxPhoneRows(toArrayBuffer(numericPhoneWorkbook()));
  assert.deepEqual(rows, [{ sourceRow: 2, original: '901234567', unsafeNumeric: true }]);
});

test('file import blocks unsafe numeric phone cells and tells the operator to use Text format', async () => {
  const bytes = numericPhoneWorkbook();
  const file = {
    name: 'numeric-phones.xlsx',
    size: bytes.byteLength,
    arrayBuffer: async () => toArrayBuffer(bytes),
  } as File;

  await assert.rejects(readPhoneRowsFromFile(file), /Format the phone column as Text and re-import it/);
});

test('generated template keeps phone examples as text cells', async () => {
  const rows = await parseXlsxPhoneRows(toArrayBuffer(buildNumberCheckTemplateXlsx()));
  assert.equal(rows.some(row => row.unsafeNumeric), false);
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
