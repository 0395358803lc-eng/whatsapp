export interface ImportedPhoneRow {
  sourceRow: number;
  original: string;
}

export interface ExportNumberCheckRow {
  sourceRow: number;
  original: string;
  normalized: string;
  status: string;
  whatsappId?: string | null;
  details?: string;
  checkedAt?: string;
}

const PHONE_HEADERS = new Set([
  'phone',
  'phone number',
  'phonenumber',
  'number',
  'mobile',
  'mobile number',
  'mobile phone',
  'telephone',
  'tel',
  'whatsapp',
  'whatsapp number',
  'whatsapp phone',
  'msisdn',
  'so dien thoai',
  'sdt',
  'dien thoai',
]);

const MAX_XLSX_BYTES = 8 * 1024 * 1024;
export const MAX_BULK_PHONE_ROWS = 500;

function normalizeHeader(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ');
}

function xmlDecode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, entity => {
    const body = entity.slice(1, -1);
    if (body.toLowerCase() === 'amp') return '&';
    if (body.toLowerCase() === 'lt') return '<';
    if (body.toLowerCase() === 'gt') return '>';
    if (body.toLowerCase() === 'quot') return '"';
    if (body.toLowerCase() === 'apos') return "'";
    if (body.toLowerCase().startsWith('#x')) return String.fromCodePoint(parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(parseInt(body.slice(1), 10));
    return entity;
  });
}

function xmlEscape(value: string): string {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function columnIndex(reference: string): number {
  const match = reference.match(/^([A-Z]+)/i);
  if (!match) return 0;
  let result = 0;
  for (const char of match[1].toUpperCase()) result = result * 26 + (char.charCodeAt(0) - 64);
  return result - 1;
}

function columnName(index: number): string {
  let value = index + 1;
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result;
}

function extractTextRuns(xml: string): string {
  const parts: string[] = [];
  for (const match of xml.matchAll(/<t\b[^>]*>([\s\S]*?)<\/t>/gi)) parts.push(xmlDecode(match[1]));
  return parts.join('');
}

function selectPhoneRows(rows: Array<{ rowNumber: number; values: string[] }>): ImportedPhoneRow[] {
  const firstIndex = rows.findIndex(row => row.values.some(value => value.trim()));
  if (firstIndex === -1) return [];

  const first = rows[firstIndex];
  let phoneColumn = first.values.findIndex(value => PHONE_HEADERS.has(normalizeHeader(value)));
  let dataStart = firstIndex + 1;

  if (phoneColumn === -1) {
    phoneColumn = first.values.findIndex(value => value.trim());
    dataStart = firstIndex;
  }
  if (phoneColumn === -1) return [];

  const result: ImportedPhoneRow[] = [];
  for (let i = dataStart; i < rows.length; i += 1) {
    const original = (rows[i].values[phoneColumn] ?? '').trim();
    if (!original) continue;
    result.push({ sourceRow: rows[i].rowNumber, original });
    if (result.length > MAX_BULK_PHONE_ROWS) {
      throw new Error(`The file contains more than ${MAX_BULK_PHONE_ROWS} phone rows. Split it into smaller files.`);
    }
  }
  return result;
}

function detectDelimiter(text: string): string {
  const firstLine = text.replace(/^\uFEFF/, '').split(/\r?\n/, 1)[0] ?? '';
  const candidates = [',', ';', '\t'];
  let winner = ',';
  let best = -1;
  for (const candidate of candidates) {
    let count = 0;
    let quoted = false;
    for (let i = 0; i < firstLine.length; i += 1) {
      if (firstLine[i] === '"') quoted = !quoted;
      else if (!quoted && firstLine[i] === candidate) count += 1;
    }
    if (count > best) {
      winner = candidate;
      best = count;
    }
  }
  return winner;
}

export function parseDelimitedPhoneRows(text: string): ImportedPhoneRow[] {
  const clean = text.replace(/^\uFEFF/, '');
  const delimiter = detectDelimiter(clean);
  const table: string[][] = [];
  let row: string[] = [];
  let cell = '';
  let quoted = false;

  for (let i = 0; i <= clean.length; i += 1) {
    const char = clean[i] ?? '\n';
    if (quoted) {
      if (char === '"' && clean[i + 1] === '"') {
        cell += '"';
        i += 1;
      } else if (char === '"') {
        quoted = false;
      } else {
        cell += char;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === delimiter) {
      row.push(cell);
      cell = '';
    } else if (char === '\n' || char === '\r') {
      if (char === '\r' && clean[i + 1] === '\n') i += 1;
      row.push(cell);
      cell = '';
      if (row.some(value => value.trim())) table.push(row);
      row = [];
    } else {
      cell += char;
    }
  }

  return selectPhoneRows(table.map((values, index) => ({ rowNumber: index + 1, values })));
}

interface ZipEntry {
  name: string;
  method: number;
  compressedSize: number;
  uncompressedSize: number;
  localHeaderOffset: number;
}

function findZipEntries(bytes: Uint8Array): ZipEntry[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const min = Math.max(0, bytes.length - 65_557);
  let eocd = -1;
  for (let i = bytes.length - 22; i >= min; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('This .xlsx file is not a readable ZIP workbook.');

  const entriesCount = view.getUint16(eocd + 10, true);
  let offset = view.getUint32(eocd + 16, true);
  const decoder = new TextDecoder();
  const entries: ZipEntry[] = [];

  for (let i = 0; i < entriesCount; i += 1) {
    if (view.getUint32(offset, true) !== 0x02014b50) throw new Error('The .xlsx ZIP directory is malformed.');
    const flags = view.getUint16(offset + 8, true);
    if (flags & 0x1) throw new Error('Password-protected Excel files are not supported.');
    const method = view.getUint16(offset + 10, true);
    const compressedSize = view.getUint32(offset + 20, true);
    const uncompressedSize = view.getUint32(offset + 24, true);
    const nameLength = view.getUint16(offset + 28, true);
    const extraLength = view.getUint16(offset + 30, true);
    const commentLength = view.getUint16(offset + 32, true);
    const localHeaderOffset = view.getUint32(offset + 42, true);
    const name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameLength));
    entries.push({ name, method, compressedSize, uncompressedSize, localHeaderOffset });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

async function readZipEntry(bytes: Uint8Array, entry: ZipEntry): Promise<Uint8Array> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const offset = entry.localHeaderOffset;
  if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`Invalid ZIP entry: ${entry.name}`);
  const nameLength = view.getUint16(offset + 26, true);
  const extraLength = view.getUint16(offset + 28, true);
  const start = offset + 30 + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);

  if (entry.method === 0) return compressed.slice();
  if (entry.method !== 8) throw new Error(`Unsupported Excel compression method ${entry.method}.`);
  if (typeof DecompressionStream === 'undefined') throw new Error('This browser cannot decompress .xlsx files.');

  const compressedBuffer = compressed.buffer.slice(
    compressed.byteOffset,
    compressed.byteOffset + compressed.byteLength,
  ) as ArrayBuffer;
  const stream = new Blob([compressedBuffer]).stream().pipeThrough(new DecompressionStream('deflate-raw'));
  const output = new Uint8Array(await new Response(stream).arrayBuffer());
  if (entry.uncompressedSize && output.length !== entry.uncompressedSize) {
    throw new Error(`Excel entry ${entry.name} decompressed to an unexpected size.`);
  }
  return output;
}

function resolveWorksheetPath(workbookXml: string, relsXml: string, entries: ZipEntry[]): string {
  const sheetMatch = workbookXml.match(/<sheet\b[^>]*r:id=["']([^"']+)["'][^>]*>/i);
  if (sheetMatch) {
    const escapedId = sheetMatch[1].replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const relMatch = relsXml.match(
      new RegExp(`<Relationship\\b[^>]*Id=["']${escapedId}["'][^>]*Target=["']([^"']+)["'][^>]*/?>`, 'i'),
    );
    if (relMatch) {
      let target = relMatch[1].replace(/\\/g, '/');
      if (target.startsWith('/')) target = target.slice(1);
      if (!target.startsWith('xl/')) target = `xl/${target.replace(/^\.\//, '')}`;
      return target;
    }
  }
  return entries.find(entry => /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name))?.name ?? '';
}

function parseWorksheetRows(
  worksheetXml: string,
  sharedStrings: string[],
): Array<{ rowNumber: number; values: string[] }> {
  const rows: Array<{ rowNumber: number; values: string[] }> = [];
  let implicitRow = 0;

  for (const rowMatch of worksheetXml.matchAll(/<row\b([^>]*)>([\s\S]*?)<\/row>/gi)) {
    implicitRow += 1;
    const rowAttr = rowMatch[1];
    const rowNumber = Number(rowAttr.match(/\br=["'](\d+)["']/i)?.[1] ?? implicitRow);
    const values: string[] = [];

    for (const cellMatch of rowMatch[2].matchAll(/<c\b([^>]*?)(?:>([\s\S]*?)<\/c>|\/\s*>)/gi)) {
      const attrs = cellMatch[1] ?? '';
      const inner = cellMatch[2] ?? '';
      const ref = attrs.match(/\br=["']([^"']+)["']/i)?.[1] ?? `${columnName(values.length)}${rowNumber}`;
      const index = columnIndex(ref);
      const type = attrs.match(/\bt=["']([^"']+)["']/i)?.[1] ?? '';
      let value: string;

      if (type === 'inlineStr') {
        value = extractTextRuns(inner);
      } else {
        const rawValue = inner.match(/<v\b[^>]*>([\s\S]*?)<\/v>/i)?.[1] ?? '';
        if (type === 's') value = sharedStrings[Number(rawValue)] ?? '';
        else if (type === 'str') value = xmlDecode(rawValue);
        else value = rawValue.trim();
      }
      values[index] = value;
    }
    rows.push({ rowNumber, values });
  }
  return rows;
}

export async function parseXlsxPhoneRows(buffer: ArrayBuffer): Promise<ImportedPhoneRow[]> {
  if (buffer.byteLength > MAX_XLSX_BYTES) throw new Error('The Excel file is too large (8 MB maximum).');
  const bytes = new Uint8Array(buffer);
  const entries = findZipEntries(bytes);
  const byName = new Map(entries.map(entry => [entry.name, entry]));
  const decoder = new TextDecoder();

  const workbookEntry = byName.get('xl/workbook.xml');
  const relsEntry = byName.get('xl/_rels/workbook.xml.rels');
  if (!workbookEntry || !relsEntry) throw new Error('The Excel workbook structure is incomplete.');

  const workbookXml = decoder.decode(await readZipEntry(bytes, workbookEntry));
  const relsXml = decoder.decode(await readZipEntry(bytes, relsEntry));
  const worksheetPath = resolveWorksheetPath(workbookXml, relsXml, entries);
  const worksheetEntry = byName.get(worksheetPath);
  if (!worksheetEntry) throw new Error('The first worksheet could not be found.');

  const sharedStrings: string[] = [];
  const sharedEntry = byName.get('xl/sharedStrings.xml');
  if (sharedEntry) {
    const sharedXml = decoder.decode(await readZipEntry(bytes, sharedEntry));
    for (const match of sharedXml.matchAll(/<si\b[^>]*>([\s\S]*?)<\/si>/gi)) {
      sharedStrings.push(extractTextRuns(match[1]));
    }
  }

  const worksheetXml = decoder.decode(await readZipEntry(bytes, worksheetEntry));
  return selectPhoneRows(parseWorksheetRows(worksheetXml, sharedStrings));
}

export async function readPhoneRowsFromFile(file: File): Promise<ImportedPhoneRow[]> {
  const lower = file.name.toLowerCase();
  if (lower.endsWith('.csv')) return parseDelimitedPhoneRows(await file.text());
  if (lower.endsWith('.xlsx')) return parseXlsxPhoneRows(await file.arrayBuffer());
  throw new Error('Use an .xlsx or .csv file. Legacy .xls files are not supported.');
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(date: Date): { time: number; day: number } {
  const year = Math.max(1980, date.getFullYear());
  return {
    time: (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2),
    day: ((year - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate(),
  };
}

function write16(view: DataView, offset: number, value: number): void {
  view.setUint16(offset, value, true);
}

function write32(view: DataView, offset: number, value: number): void {
  view.setUint32(offset, value >>> 0, true);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const result = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result;
}

function zipStore(files: Array<{ name: string; data: Uint8Array }>): Uint8Array {
  const encoder = new TextEncoder();
  const now = dosDateTime(new Date());
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let localOffset = 0;

  for (const file of files) {
    const name = encoder.encode(file.name);
    const crc = crc32(file.data);
    const local = new Uint8Array(30 + name.length);
    const lv = new DataView(local.buffer);
    write32(lv, 0, 0x04034b50);
    write16(lv, 4, 20);
    write16(lv, 6, 0x0800);
    write16(lv, 8, 0);
    write16(lv, 10, now.time);
    write16(lv, 12, now.day);
    write32(lv, 14, crc);
    write32(lv, 18, file.data.length);
    write32(lv, 22, file.data.length);
    write16(lv, 26, name.length);
    write16(lv, 28, 0);
    local.set(name, 30);
    localParts.push(local, file.data);

    const central = new Uint8Array(46 + name.length);
    const cv = new DataView(central.buffer);
    write32(cv, 0, 0x02014b50);
    write16(cv, 4, 20);
    write16(cv, 6, 20);
    write16(cv, 8, 0x0800);
    write16(cv, 10, 0);
    write16(cv, 12, now.time);
    write16(cv, 14, now.day);
    write32(cv, 16, crc);
    write32(cv, 20, file.data.length);
    write32(cv, 24, file.data.length);
    write16(cv, 28, name.length);
    write16(cv, 30, 0);
    write16(cv, 32, 0);
    write16(cv, 34, 0);
    write16(cv, 36, 0);
    write32(cv, 38, 0);
    write32(cv, 42, localOffset);
    central.set(name, 46);
    centralParts.push(central);
    localOffset += local.length + file.data.length;
  }

  const central = concat(centralParts);
  const eocd = new Uint8Array(22);
  const ev = new DataView(eocd.buffer);
  write32(ev, 0, 0x06054b50);
  write16(ev, 4, 0);
  write16(ev, 6, 0);
  write16(ev, 8, files.length);
  write16(ev, 10, files.length);
  write32(ev, 12, central.length);
  write32(ev, 16, localOffset);
  write16(ev, 20, 0);
  return concat([...localParts, central, eocd]);
}

function worksheetXml(rows: string[][]): string {
  const width = Math.max(1, ...rows.map(row => row.length));
  const lastRef = `${columnName(width - 1)}${Math.max(1, rows.length)}`;
  const rowXml = rows
    .map((row, rowIndex) => {
      const cells = row
        .map((value, columnIndexValue) => {
          const ref = `${columnName(columnIndexValue)}${rowIndex + 1}`;
          const style = rowIndex === 0 ? ' s="1"' : '';
          return `<c r="${ref}" t="inlineStr"${style}><is><t xml:space="preserve">${xmlEscape(String(value ?? ''))}</t></is></c>`;
        })
        .join('');
      return `<row r="${rowIndex + 1}">${cells}</row>`;
    })
    .join('');

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:${lastRef}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="10" customWidth="1"/><col min="2" max="3" width="22" customWidth="1"/><col min="4" max="4" width="18" customWidth="1"/><col min="5" max="5" width="30" customWidth="1"/><col min="6" max="6" width="42" customWidth="1"/><col min="7" max="7" width="24" customWidth="1"/></cols><sheetData>${rowXml}</sheetData>${rows.length > 1 ? `<autoFilter ref="A1:${columnName(width - 1)}${rows.length}"/>` : ''}</worksheet>`;
}

export function buildXlsxBytes(rows: string[][], sheetName = 'Results'): Uint8Array {
  const encoder = new TextEncoder();
  const safeSheet = sheetName.replace(/[\\/*?:[\]]/g, ' ').slice(0, 31) || 'Results';
  const files = [
    {
      name: '[Content_Types].xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>',
      ),
    },
    {
      name: '_rels/.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/workbook.xml',
      data: encoder.encode(
        `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="${xmlEscape(safeSheet)}" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      ),
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>',
      ),
    },
    {
      name: 'xl/styles.xml',
      data: encoder.encode(
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><color rgb="FFFFFFFF"/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF16A34A"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>',
      ),
    },
    { name: 'xl/worksheets/sheet1.xml', data: encoder.encode(worksheetXml(rows)) },
  ];
  return zipStore(files);
}

export function buildNumberCheckResultsXlsx(rows: ExportNumberCheckRow[]): Uint8Array {
  const table = [
    ['Source row', 'Original number', 'Normalized number', 'Status', 'WhatsApp ID', 'Details', 'Checked at'],
    ...rows.map(row => [
      String(row.sourceRow),
      row.original,
      row.normalized ? `+${row.normalized}` : '',
      row.status,
      row.whatsappId ?? '',
      row.details ?? '',
      row.checkedAt ?? '',
    ]),
  ];
  return buildXlsxBytes(table, 'WhatsApp Check Results');
}

export function buildNumberCheckTemplateXlsx(): Uint8Array {
  return buildXlsxBytes([['phone_number'], ['+84901234567'], ['+14155552671']], 'Phone Numbers');
}
