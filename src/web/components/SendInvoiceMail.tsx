import { useState } from 'react';
import { Link } from 'react-router';
import { api, ApiError } from '../lib/api.ts';

interface Result { messages: { id: string }[]; sent: number; alreadySent: number; toPrint: { invoiceId: string; number: string; name: string; reason: string }[] }

/** Sends invoices (or a dunning reminder) by e-mail with the PDF; lists those who need a printed letter. */
export function SendInvoiceMail({ invoiceIds, feeRunId, template = 'invoice', label }: { invoiceIds?: string[]; feeRunId?: string; template?: 'invoice' | 'dunning'; label: string }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result>();
  const [error, setError] = useState<string>();
  const [confirming, setConfirming] = useState(false);
  const [printing, setPrinting] = useState(false);

  // One PDF for all letters: the stored invoice PDFs, merged on the server.
  async function printLetters(ids: string[]) {
    setPrinting(true);
    setError(undefined);
    try {
      const res = await fetch('/api/v1/invoices/letters.pdf', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceIds: ids }), credentials: 'same-origin' });
      if (!res.ok) throw new ApiError(await res.json());
      const url = URL.createObjectURL(await res.blob());
      const a = document.createElement('a');
      a.href = url;
      a.download = /filename="([^"]+)"/.exec(res.headers.get('content-disposition') ?? '')?.[1] ?? 'Briefe.pdf';
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    } finally {
      setPrinting(false);
    }
  }

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
    const sent = result.sent;
    return (
      <div role="status">
        <span>{sent > 0 ? <>{sent === 1 ? 'Eine E-Mail ist' : `${sent} E-Mails sind`} unterwegs (<Link to={`/kommunikation/${result.messages[0]!.id}`}>Zustellung</Link>).</> : 'Keine E-Mail verschickt.'}</span>
        {error && <div role="alert" className="meta" style={{ color: 'var(--danger)' }}>{error}</div>}
        {result.alreadySent > 0 && <div className="meta">{result.alreadySent} schon früher per E-Mail verschickt, diesmal ausgelassen.</div>}
        {result.toPrint.length > 0 && (
          <div className="meta" style={{ marginTop: 'var(--s-1)' }}>
            Als Brief drucken: {result.toPrint.map((p, i) => <span key={p.invoiceId}>{i > 0 && ', '}<a href={`/api/v1/invoices/${p.invoiceId}/pdf`} target="_blank" rel="noreferrer">{p.number}</a> {p.name} ({p.reason})</span>)}
            <div style={{ marginTop: 'var(--s-2)' }}>
              <button className="btn" aria-busy={printing} disabled={printing} onClick={() => void printLetters(result.toPrint.map((p) => p.invoiceId))}>
                {result.toPrint.length === 1 ? 'Brief als PDF' : `Alle ${result.toPrint.length} Briefe als ein PDF`}
              </button>
              <span className="meta"> nach Postleitzahl sortiert, für Duplexdruck</span>
            </div>
          </div>
        )}
      </div>
    );
  }
  return (
    <>
      {confirming ? (
        <span className="actions-inline">
          <span>{feeRunId ? 'Alle Rechnungen dieses Laufs per E-Mail senden?' : 'Jetzt senden?'}</span>
          <button className="btn btn-primary" aria-busy={busy} disabled={busy} onClick={() => void send()}>Ja, senden</button>
          <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Abbrechen</button>
        </span>
      ) : (
        <button className="btn" onClick={() => setConfirming(true)}>{label}</button>
      )}
      {error && <span role="alert" className="meta" style={{ color: 'var(--danger)' }}>{error}</span>}
    </>
  );
}
