import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';

interface Result { message: { id: string; counts: { total: number } } | null; toPrint: { invoiceId: string; number: string; name: string; reason: string }[] }

/** Sends invoices (or a dunning reminder) by e-mail with the PDF; lists those who need a printed letter. */
export function SendInvoiceMail({ invoiceIds, feeRunId, template = 'invoice', label }: { invoiceIds?: string[]; feeRunId?: string; template?: 'invoice' | 'dunning'; label: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();

  async function send() {
    setBusy(true);
    setError(undefined);
    try {
      setResult(await api<Result>('/invoices/send-mail', { method: 'POST', body: { invoiceIds, feeRunId, template } }));
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    } finally {
      setBusy(false);
    }
  }

  if (result) {
    const sent = result.message ? result.message.counts.total : 0;
    return (
      <div role="status">
        <span>{sent > 0 ? <>{sent === 1 ? 'Eine E-Mail ist' : `${sent} E-Mails sind`} unterwegs (<Link to={`/kommunikation/${result.message!.id}`}>Zustellung</Link>).</> : 'Keine E-Mail verschickt.'}</span>
        {result.toPrint.length > 0 && (
          <div className="meta" style={{ marginTop: 'var(--s-1)' }}>
            Als Brief drucken: {result.toPrint.map((p, i) => <span key={p.invoiceId}>{i > 0 && ', '}<a href={`/api/v1/invoices/${p.invoiceId}/pdf`} target="_blank" rel="noreferrer">{p.number}</a> {p.name} ({p.reason})</span>)}
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      <button className="btn" aria-busy={busy} disabled={busy} onClick={() => void send()}>{label}</button>
      {error && <span role="alert" className="meta" style={{ color: 'var(--danger)' }}>{error}</span>}
    </>
  );
}
