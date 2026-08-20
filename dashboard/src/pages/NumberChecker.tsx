import { useEffect, useMemo, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import {
  CheckCircle2,
  CircleAlert,
  Download,
  FileSpreadsheet,
  Loader2,
  Play,
  Search,
  Square,
  Upload,
  XCircle,
} from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery } from '../hooks/queries';
import { contactApi, type CheckNumberResponse } from '../services/api';
import {
  buildNumberCheckResultsXlsx,
  buildNumberCheckTemplateXlsx,
  MAX_BULK_PHONE_ROWS,
  readPhoneRowsFromFile,
  type ExportNumberCheckRow,
  type ImportedPhoneRow,
} from '../utils/excelNumberCheck';
import { normalizePhoneNumber } from '../utils/phoneNumber';
import './NumberChecker.css';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'result'; data: CheckNumberResponse }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

type BulkStatus =
  | 'queued'
  | 'checking'
  | 'registered'
  | 'not_registered'
  | 'unavailable'
  | 'invalid'
  | 'error'
  | 'cancelled';

interface BulkRow extends ExportNumberCheckRow {
  id: string;
  status: BulkStatus;
}

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const TERMINAL_BULK_STATUSES = new Set<BulkStatus>([
  'registered',
  'not_registered',
  'unavailable',
  'invalid',
  'error',
  'cancelled',
]);

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function downloadXlsx(bytes: Uint8Array, filename: string): void {
  const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
  const url = URL.createObjectURL(new Blob([buffer], { type: XLSX_MIME }));
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

function bulkStatusLabel(status: BulkStatus): string {
  switch (status) {
    case 'registered':
      return 'Registered';
    case 'not_registered':
      return 'Not registered';
    case 'unavailable':
      return 'No response';
    case 'invalid':
      return 'Invalid';
    case 'error':
      return 'Error';
    case 'cancelled':
      return 'Stopped';
    case 'checking':
      return 'Checking';
    default:
      return 'Queued';
  }
}

function createBulkRows(imported: ImportedPhoneRow[], countryCode: string): BulkRow[] {
  return imported.map((row, index) => {
    const normalized = normalizePhoneNumber(row.original, countryCode);
    return {
      id: `${row.sourceRow}-${index}`,
      sourceRow: row.sourceRow,
      original: row.original,
      normalized: normalized.normalized,
      status: normalized.valid ? 'queued' : 'invalid',
      whatsappId: null,
      details: normalized.valid ? '' : 'Invalid phone shape after normalization (expected 7–15 digits).',
    };
  });
}

export function NumberChecker() {
  useDocumentTitle('WhatsApp Number Checker');
  const { data: allSessions = [], isLoading: sessionsLoading } = useSessionsQuery();
  const readySessions = useMemo(() => allSessions.filter(item => item.status === 'ready'), [allSessions]);
  const [mode, setMode] = useState<'single' | 'bulk'>('single');
  const [sessionId, setSessionId] = useState('');
  const [countryCode, setCountryCode] = useState('84');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<CheckState>({ kind: 'idle' });

  const [bulkRows, setBulkRows] = useState<BulkRow[]>([]);
  const [bulkFileName, setBulkFileName] = useState('');
  const [bulkFileError, setBulkFileError] = useState('');
  const [bulkRunning, setBulkRunning] = useState(false);
  const [bulkDelayMs, setBulkDelayMs] = useState(2000);
  const stopBulkRef = useRef(false);

  useEffect(() => {
    if (!readySessions.length) {
      setSessionId('');
      return;
    }
    if (!readySessions.some(item => item.id === sessionId)) setSessionId(readySessions[0].id);
  }, [readySessions, sessionId]);

  const normalized = normalizePhoneNumber(phone, countryCode);
  const canCheck = Boolean(sessionId && normalized.valid && state.kind !== 'checking');

  const bulkStats = useMemo(() => {
    const total = bulkRows.length;
    const completed = bulkRows.filter(row => TERMINAL_BULK_STATUSES.has(row.status)).length;
    return {
      total,
      completed,
      registered: bulkRows.filter(row => row.status === 'registered').length,
      notRegistered: bulkRows.filter(row => row.status === 'not_registered').length,
      unavailable: bulkRows.filter(row => row.status === 'unavailable' || row.status === 'error').length,
      invalid: bulkRows.filter(row => row.status === 'invalid').length,
      percent: total ? Math.round((completed / total) * 100) : 0,
    };
  }, [bulkRows]);

  const handleCountryCodeChange = (value: string) => {
    const next = value.replace(/\D/g, '').slice(0, 3);
    setCountryCode(next);
    setState({ kind: 'idle' });
    if (!bulkRunning && bulkRows.length) {
      setBulkRows(rows => createBulkRows(rows.map(row => ({ sourceRow: row.sourceRow, original: row.original })), next));
    }
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    if (!canCheck) return;
    setState({ kind: 'checking' });
    try {
      const data = await contactApi.checkNumber(sessionId, normalized.normalized);
      setState({ kind: 'result', data });
    } catch (error) {
      const requestError = error as Error & { status?: number };
      if (requestError.status === 503) {
        setState({
          kind: 'unavailable',
          message: 'WhatsApp did not answer this lookup. No conclusion was recorded; try again shortly.',
        });
      } else {
        setState({ kind: 'error', message: requestError.message || 'The number check failed.' });
      }
    }
  };

  const handleBulkFile = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file || bulkRunning) return;
    setBulkFileError('');
    try {
      const imported = await readPhoneRowsFromFile(file);
      if (!imported.length) throw new Error('No phone numbers were found in the first worksheet.');
      setBulkFileName(file.name);
      setBulkRows(createBulkRows(imported, countryCode));
    } catch (error) {
      setBulkFileName('');
      setBulkRows([]);
      setBulkFileError(error instanceof Error ? error.message : 'Could not read this file.');
    }
  };

  const handleDownloadTemplate = () => {
    downloadXlsx(buildNumberCheckTemplateXlsx(), 'whatsapp-number-check-template.xlsx');
  };

  const handleExportResults = () => {
    if (!bulkRows.length) return;
    const exportRows: ExportNumberCheckRow[] = bulkRows.map(row => ({
      sourceRow: row.sourceRow,
      original: row.original,
      normalized: row.normalized,
      status: bulkStatusLabel(row.status),
      whatsappId: row.whatsappId,
      details: row.details,
      checkedAt: row.checkedAt,
    }));
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    downloadXlsx(buildNumberCheckResultsXlsx(exportRows), `whatsapp-number-check-results-${timestamp}.xlsx`);
  };

  const handleStartBulk = async () => {
    if (!sessionId || bulkRunning || !bulkRows.length) return;
    stopBulkRef.current = false;
    setBulkRunning(true);
    setBulkFileError('');

    let working = bulkRows.map(row => {
      if (row.status === 'invalid') return row;
      return { ...row, status: 'queued' as const, whatsappId: null, details: '', checkedAt: undefined };
    });
    setBulkRows(working);

    type CachedResult = Pick<BulkRow, 'status' | 'whatsappId' | 'details' | 'checkedAt'>;
    const cache = new Map<string, CachedResult>();
    const publish = (index: number, patch: Partial<BulkRow>) => {
      working[index] = { ...working[index], ...patch };
      setBulkRows([...working]);
    };

    try {
      for (let index = 0; index < working.length; index += 1) {
        const row = working[index];
        if (row.status === 'invalid') continue;
        if (stopBulkRef.current) {
          working = working.map(item => (item.status === 'queued' ? { ...item, status: 'cancelled' as const } : item));
          setBulkRows([...working]);
          break;
        }

        const cached = cache.get(row.normalized);
        if (cached) {
          publish(index, {
            ...cached,
            details: cached.details
              ? `${cached.details} Duplicate number; reused earlier result.`
              : 'Duplicate number; reused earlier result.',
          });
          continue;
        }

        publish(index, { status: 'checking', details: 'Querying WhatsApp…' });
        let cachedResult: CachedResult;
        try {
          const data = await contactApi.checkNumber(sessionId, row.normalized);
          cachedResult = {
            status: data.exists ? 'registered' : 'not_registered',
            whatsappId: data.whatsappId,
            details: data.exists ? 'WhatsApp account confirmed.' : 'WhatsApp confirmed no account for this number.',
            checkedAt: new Date().toISOString(),
          };
        } catch (error) {
          const requestError = error as Error & { status?: number };
          cachedResult = {
            status: requestError.status === 503 ? 'unavailable' : 'error',
            whatsappId: null,
            details:
              requestError.status === 503
                ? 'WhatsApp did not answer; no registration conclusion was recorded.'
                : requestError.message || 'Number check failed.',
            checkedAt: new Date().toISOString(),
          };
        }
        cache.set(row.normalized, cachedResult);
        publish(index, cachedResult);

        if (!stopBulkRef.current && index < working.length - 1) await sleep(bulkDelayMs);
      }
    } finally {
      setBulkRunning(false);
    }
  };

  const handleStopBulk = () => {
    stopBulkRef.current = true;
  };

  return (
    <div className="number-checker">
      <PageHeader
        title="WhatsApp Number Checker"
        subtitle="Verify one recipient or process an authorized Excel list with live progress and exportable results."
      />

      <div className="number-checker__tabs" role="tablist" aria-label="Number checker mode">
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'single'}
          className={mode === 'single' ? 'active' : ''}
          onClick={() => setMode('single')}
        >
          <Search size={17} /> Single check
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={mode === 'bulk'}
          className={mode === 'bulk' ? 'active' : ''}
          onClick={() => setMode('bulk')}
        >
          <FileSpreadsheet size={17} /> Bulk Excel / CSV
        </button>
      </div>

      {mode === 'single' ? (
        <div className="number-checker__grid">
          <section className="number-checker__card" aria-labelledby="number-checker-form-title">
            <h2 id="number-checker-form-title">Check a number</h2>
            <form onSubmit={handleSubmit}>
              <label>
                Ready session
                <select
                  value={sessionId}
                  onChange={event => {
                    setSessionId(event.target.value);
                    setState({ kind: 'idle' });
                  }}
                  disabled={sessionsLoading || readySessions.length === 0}
                >
                  {readySessions.length === 0 && <option value="">No ready sessions</option>}
                  {readySessions.map(session => (
                    <option key={session.id} value={session.id}>
                      {session.name} {session.phone ? `(${session.phone})` : ''}
                    </option>
                  ))}
                </select>
              </label>

              <div className="number-checker__phone-row">
                <label className="number-checker__country">
                  Country code
                  <div className="number-checker__country-input">
                    <span>+</span>
                    <input
                      inputMode="numeric"
                      value={countryCode}
                      onChange={event => handleCountryCodeChange(event.target.value)}
                      aria-label="Default country code"
                    />
                  </div>
                </label>
                <label>
                  Phone number
                  <input
                    type="tel"
                    value={phone}
                    onChange={event => {
                      setPhone(event.target.value);
                      setState({ kind: 'idle' });
                    }}
                    placeholder="090 123 4567 or +84 901 234 567"
                    autoComplete="tel"
                  />
                </label>
              </div>

              <p className="number-checker__hint">
                Local numbers beginning with 0 use the selected country code. Explicit + or 00 international numbers are
                preserved.
              </p>

              {phone.trim() && !normalized.valid && (
                <div className="number-checker__validation" role="alert">
                  Enter a valid international-style phone number (7–15 digits after normalization).
                </div>
              )}

              {normalized.valid && (
                <div className="number-checker__normalized">
                  Normalized lookup: <code>+{normalized.normalized}</code>
                </div>
              )}

              <button type="submit" className="number-checker__submit" disabled={!canCheck}>
                {state.kind === 'checking' ? <Loader2 className="animate-spin" size={18} /> : <Search size={18} />}
                {state.kind === 'checking' ? 'Checking…' : 'Check WhatsApp'}
              </button>
            </form>
          </section>

          <section className="number-checker__card" aria-live="polite">
            <h2>Result</h2>
            {state.kind === 'idle' && <div className="number-checker__empty">Enter a phone number to verify it.</div>}
            {state.kind === 'checking' && (
              <div className="number-checker__empty">
                <Loader2 className="animate-spin" size={28} /> Contacting WhatsApp…
              </div>
            )}
            {state.kind === 'result' && state.data.exists && (
              <div className="number-checker__result number-checker__result--success">
                <CheckCircle2 size={30} />
                <div>
                  <strong>WhatsApp account found</strong>
                  <p>This number is registered and can be addressed by the selected session.</p>
                  <dl>
                    <div>
                      <dt>Number</dt>
                      <dd>+{state.data.number}</dd>
                    </div>
                    <div>
                      <dt>WhatsApp ID</dt>
                      <dd>
                        <code>{state.data.whatsappId}</code>
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            )}
            {state.kind === 'result' && !state.data.exists && (
              <div className="number-checker__result number-checker__result--negative">
                <XCircle size={30} />
                <div>
                  <strong>No WhatsApp account found</strong>
                  <p>WhatsApp confirmed that this number is not currently registered.</p>
                </div>
              </div>
            )}
            {state.kind === 'unavailable' && (
              <div className="number-checker__result number-checker__result--warning">
                <CircleAlert size={30} />
                <div>
                  <strong>Could not verify</strong>
                  <p>{state.message}</p>
                </div>
              </div>
            )}
            {state.kind === 'error' && (
              <div className="number-checker__result number-checker__result--negative">
                <XCircle size={30} />
                <div>
                  <strong>Check failed</strong>
                  <p>{state.message}</p>
                </div>
              </div>
            )}
          </section>
        </div>
      ) : (
        <div className="number-checker__bulk">
          <div className="number-checker__bulk-grid">
            <section className="number-checker__card">
              <h2>1. Import recipients</h2>
              <div className="number-checker__bulk-controls">
                <label>
                  Ready session
                  <select
                    value={sessionId}
                    onChange={event => setSessionId(event.target.value)}
                    disabled={sessionsLoading || readySessions.length === 0 || bulkRunning}
                  >
                    {readySessions.length === 0 && <option value="">No ready sessions</option>}
                    {readySessions.map(session => (
                      <option key={session.id} value={session.id}>
                        {session.name} {session.phone ? `(${session.phone})` : ''}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="number-checker__bulk-row">
                  <label>
                    Default country code
                    <div className="number-checker__country-input">
                      <span>+</span>
                      <input
                        inputMode="numeric"
                        value={countryCode}
                        onChange={event => handleCountryCodeChange(event.target.value)}
                        disabled={bulkRunning}
                      />
                    </div>
                  </label>
                  <label>
                    Delay between checks
                    <select
                      value={bulkDelayMs}
                      onChange={event => setBulkDelayMs(Number(event.target.value))}
                      disabled={bulkRunning}
                    >
                      <option value={1500}>1.5 seconds</option>
                      <option value={2000}>2 seconds (recommended)</option>
                      <option value={3000}>3 seconds</option>
                      <option value={5000}>5 seconds</option>
                    </select>
                  </label>
                </div>
              </div>

              <div className="number-checker__file-actions">
                <label className={`number-checker__file-pick ${bulkRunning ? 'disabled' : ''}`}>
                  <Upload size={18} />
                  <span>{bulkFileName || 'Choose .xlsx or .csv file'}</span>
                  <input type="file" accept=".xlsx,.csv" onChange={handleBulkFile} disabled={bulkRunning} />
                </label>
                <button type="button" className="number-checker__secondary" onClick={handleDownloadTemplate}>
                  <Download size={17} /> Download template
                </button>
              </div>

              <p className="number-checker__hint">
                The first worksheet is read. Use a column named <code>phone_number</code>, <code>phone</code>,{' '}
                <code>mobile</code>, <code>msisdn</code>, or <code>Số điện thoại</code>. Maximum {MAX_BULK_PHONE_ROWS}{' '}
                non-empty rows per file.
              </p>
              <div className="number-checker__bulk-notice">
                <CircleAlert size={18} />
                <span>
                  Bulk checks run one at a time with a delay. Only check numbers you are authorized to contact; high-rate
                  account enumeration can trigger WhatsApp restrictions.
                </span>
              </div>
              {bulkFileError && (
                <div className="number-checker__validation" role="alert">
                  {bulkFileError}
                </div>
              )}
            </section>

            <section className="number-checker__card" aria-live="polite">
              <h2>2. Live progress</h2>
              {bulkRows.length === 0 ? (
                <div className="number-checker__empty">Import an Excel or CSV file to prepare the batch.</div>
              ) : (
                <>
                  <div className="number-checker__stats">
                    <div>
                      <strong>{bulkStats.total}</strong>
                      <span>Total</span>
                    </div>
                    <div>
                      <strong>{bulkStats.completed}</strong>
                      <span>Processed</span>
                    </div>
                    <div>
                      <strong>{bulkStats.registered}</strong>
                      <span>Registered</span>
                    </div>
                    <div>
                      <strong>{bulkStats.notRegistered}</strong>
                      <span>Not registered</span>
                    </div>
                    <div>
                      <strong>{bulkStats.unavailable}</strong>
                      <span>No response / error</span>
                    </div>
                    <div>
                      <strong>{bulkStats.invalid}</strong>
                      <span>Invalid</span>
                    </div>
                  </div>
                  <div className="number-checker__progress" aria-label={`${bulkStats.percent}% processed`}>
                    <div style={{ width: `${bulkStats.percent}%` }} />
                  </div>
                  <div className="number-checker__progress-caption">
                    <span>{bulkRunning ? 'Running in real time…' : 'Ready'}</span>
                    <strong>{bulkStats.percent}%</strong>
                  </div>
                  <div className="number-checker__run-actions">
                    <button
                      type="button"
                      className="number-checker__submit"
                      onClick={handleStartBulk}
                      disabled={bulkRunning || !sessionId || bulkRows.every(row => row.status === 'invalid')}
                    >
                      {bulkRunning ? <Loader2 className="animate-spin" size={18} /> : <Play size={18} />}
                      {bulkRunning ? 'Checking…' : 'Start bulk check'}
                    </button>
                    <button
                      type="button"
                      className="number-checker__secondary"
                      onClick={handleStopBulk}
                      disabled={!bulkRunning}
                    >
                      <Square size={16} /> Stop
                    </button>
                    <button
                      type="button"
                      className="number-checker__secondary"
                      onClick={handleExportResults}
                      disabled={!bulkRows.length}
                    >
                      <Download size={17} /> Export Excel
                    </button>
                  </div>
                </>
              )}
            </section>
          </div>

          {bulkRows.length > 0 && (
            <section className="number-checker__card number-checker__table-card">
              <div className="number-checker__table-heading">
                <div>
                  <h2>Realtime result table</h2>
                  <p>{bulkFileName}</p>
                </div>
                <button type="button" className="number-checker__secondary" onClick={handleExportResults}>
                  <Download size={17} /> Export current results
                </button>
              </div>
              <div className="number-checker__table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Row</th>
                      <th>Original</th>
                      <th>Normalized</th>
                      <th>Status</th>
                      <th>WhatsApp ID</th>
                      <th>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {bulkRows.map(row => (
                      <tr key={row.id}>
                        <td>{row.sourceRow}</td>
                        <td className="mono">{row.original}</td>
                        <td className="mono">{row.normalized ? `+${row.normalized}` : '—'}</td>
                        <td>
                          <span className={`number-checker__status number-checker__status--${row.status}`}>
                            {row.status === 'checking' && <Loader2 className="animate-spin" size={13} />}
                            {bulkStatusLabel(row.status)}
                          </span>
                        </td>
                        <td className="mono">{row.whatsappId || '—'}</td>
                        <td>{row.details || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}
        </div>
      )}
    </div>
  );
}
