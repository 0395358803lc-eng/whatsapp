import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { CheckCircle2, CircleAlert, Loader2, Search, XCircle } from 'lucide-react';
import { PageHeader } from '../components/PageHeader';
import { useDocumentTitle } from '../hooks/useDocumentTitle';
import { useSessionsQuery } from '../hooks/queries';
import { contactApi, type CheckNumberResponse } from '../services/api';
import { normalizePhoneNumber } from '../utils/phoneNumber';
import './NumberChecker.css';

type CheckState =
  | { kind: 'idle' }
  | { kind: 'checking' }
  | { kind: 'result'; data: CheckNumberResponse }
  | { kind: 'unavailable'; message: string }
  | { kind: 'error'; message: string };

export function NumberChecker() {
  useDocumentTitle('WhatsApp Number Checker');
  const { data: allSessions = [], isLoading: sessionsLoading } = useSessionsQuery();
  const readySessions = useMemo(() => allSessions.filter(item => item.status === 'ready'), [allSessions]);
  const [sessionId, setSessionId] = useState('');
  const [countryCode, setCountryCode] = useState('84');
  const [phone, setPhone] = useState('');
  const [state, setState] = useState<CheckState>({ kind: 'idle' });

  useEffect(() => {
    if (!readySessions.length) {
      setSessionId('');
      return;
    }
    if (!readySessions.some(item => item.id === sessionId)) setSessionId(readySessions[0].id);
  }, [readySessions, sessionId]);

  const normalized = normalizePhoneNumber(phone, countryCode);
  const canCheck = Boolean(sessionId && normalized.valid && state.kind !== 'checking');

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

  return (
    <div className="number-checker">
      <PageHeader
        title="WhatsApp Number Checker"
        subtitle="Verify whether a phone number is registered on WhatsApp before starting a conversation."
      />

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
                    onChange={event => setCountryCode(event.target.value.replace(/\D/g, '').slice(0, 3))}
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
                  <div><dt>Number</dt><dd>+{state.data.number}</dd></div>
                  <div><dt>WhatsApp ID</dt><dd><code>{state.data.whatsappId}</code></dd></div>
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
              <div><strong>Could not verify</strong><p>{state.message}</p></div>
            </div>
          )}
          {state.kind === 'error' && (
            <div className="number-checker__result number-checker__result--negative">
              <XCircle size={30} />
              <div><strong>Check failed</strong><p>{state.message}</p></div>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
