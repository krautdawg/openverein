import { useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { FileText, Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro } from '../../shared/fees.ts';
import { RECEIPT_STATUS_LABEL, type Receipt } from '../../shared/receipts.ts';
import { Field } from '../components/Field.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError, uploadFile } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { parseEuro } from '../lib/money.ts';
import { useTitle } from '../lib/useTitle.ts';
import { AccountSelect, LedgerLayout, RangePicker, useAccounts, type Settings, type TaxRate } from './Ledger.tsx';

const problemText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');
const useSettings = () => useQuery({ queryKey: ['ledger-settings'], queryFn: () => api<Settings>('/ledger/settings') });

export function Receipts({ me }: { me: Me }) {
  useTitle('Belege');
  const [params, setParams] = useSearchParams();
  const status = params.get('status') ?? 'open';
  const list = useQuery({ queryKey: ['receipts', status], queryFn: () => api<Receipt[]>(`/receipts${status === 'all' ? '' : `?status=${status}`}`) });
  const [sheet, setSheet] = useState<'new' | 'self' | null>(null);
  const [paying, setPaying] = useState<Receipt | null>(null);
  const [voiding, setVoiding] = useState<Receipt | null>(null);
  const canWrite = me.permissions.ledger === 'write';

  return (
    <LedgerLayout me={me} action={<span style={{ display: 'inline-flex', gap: 'var(--s-2)' }}><button className="btn" onClick={() => setSheet('self')}>Eigenbeleg</button><button className="btn btn-primary" onClick={() => setSheet('new')}><Plus size={16} aria-hidden /> Beleg erfassen</button></span>}>
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Status">
          {(['open', 'paid', 'void', 'all'] as const).map((s) => <button key={s} aria-pressed={status === s} onClick={() => setParams({ status: s })}>{s === 'all' ? 'alle' : RECEIPT_STATUS_LABEL[s]}</button>)}
        </div>
      </div>
      {list.error && <div className="alert alert-error" role="alert">{problemText(list.error)}</div>}
      <div className="table-wrap">
        {list.data?.length === 0 ? (
          <p className="empty">{status === 'open' ? 'Keine offenen Belege. Erfasse Rechnungen von Lieferanten hier; gebucht wird, wenn Du bezahlst.' : 'Keine Belege.'}</p>
        ) : (
          <table className="table" aria-label="Belege">
            <thead><tr><th scope="col" className="num">Datum</th><th scope="col">Von</th><th scope="col" className="hide-sm">Konto</th><th scope="col" className="num">Betrag</th><th scope="col">Stand</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
            <tbody>
              {list.data?.map((r) => (
                <tr key={r.id}>
                  <td className="num">{formatDate(r.receiptDate)}</td>
                  <td><span className="name">{r.supplier}</span>{r.number && <span className="meta"> · {r.number}</span>}{r.hasFile && <a href={`/api/v1/receipts/${r.id}/file`} target="_blank" rel="noreferrer" aria-label={`Beleg von ${r.supplier} öffnen`} style={{ marginLeft: 6 }}><FileText size={14} aria-hidden style={{ verticalAlign: '-2px' }} /></a>}</td>
                  <td className="hide-sm">{[...new Set(r.lines.map((l) => `${l.accountNumber} ${l.accountName}`))].join(', ')}</td>
                  <td className="num">{euro(r.totalCents)}</td>
                  <td>{r.status === 'paid' ? <span className="meta">bezahlt {formatDate(r.paidOn!)} · Nr. {r.journalNumber}</span> : r.status === 'void' ? <span className="meta">ungültig</span> : r.dueDate ? <span className="meta">fällig {formatDate(r.dueDate)}</span> : <span className="meta">offen</span>}</td>
                  <td>
                    {canWrite && r.status !== 'void' && (
                      <span style={{ display: 'inline-flex', gap: 'var(--s-1)' }}>
                        {r.status === 'open' && <button className="btn btn-ghost" aria-label={`Beleg von ${r.supplier} bezahlen`} onClick={() => setPaying(r)}>Bezahlt …</button>}
                        <button className="btn btn-ghost" aria-label={`Beleg von ${r.supplier} ungültig machen`} onClick={() => setVoiding(r)}>Ungültig …</button>
                      </span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {sheet === 'new' && <ReceiptSheet onClose={() => setSheet(null)} />}
      {sheet === 'self' && <SelfIssuedSheet onClose={() => setSheet(null)} />}
      {paying && <PaySheet r={paying} onClose={() => setPaying(null)} />}
      {voiding && <VoidSheet r={voiding} onClose={() => setVoiding(null)} />}
    </LedgerLayout>
  );
}

function PayFields({ prefix = 'pay' }: { prefix?: string }) {
  const { data: accounts } = useAccounts();
  const settings = useSettings();
  const money = (accounts ?? []).filter((a) => a.kind === 'money' && !a.retired && !a.hidden);
  return (
    <div className="form-row">
      <Field label="Bezahlt am" name={`${prefix}-date`} type="date" defaultValue={todayLocal()} max={todayLocal()} />
      <AccountSelect label="Bezahlt von" name={`${prefix}-money`} accounts={money} defaultValue={settings.data?.bankAccountId ?? undefined} />
    </div>
  );
}

function ReceiptSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const rates = useQuery({ queryKey: ['tax-rates'], queryFn: () => api<TaxRate[]>('/ledger/tax-rates') });
  const [date, setDate] = useState(todayLocal());
  const [lines, setLines] = useState([0]);
  const [paid, setPaid] = useState(false);
  const [file, setFile] = useState<{ id: string; name: string; duplicateOf: string | null }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [warnings, setWarnings] = useState<string[]>();
  const input = useRef<HTMLInputElement>(null);
  const expense = (accounts ?? []).filter((a) => a.kind === 'expense' && !a.retired && !a.hidden);
  const validRates = (rates.data ?? []).filter((r) => r.rateBp > 0 && r.validFrom <= date && (!r.validTo || r.validTo >= date));

  async function attach(f: File) {
    setBusy(true);
    setError(undefined);
    try {
      const r = await uploadFile<{ id: string; duplicateOf: string | null }>('/receipts/files', f, { name: f.name });
      setFile({ id: r.id, name: f.name, duplicateOf: r.duplicateOf });
    } catch (err) {
      setError(problemText(err));
    } finally {
      setBusy(false);
    }
  }
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => ((f.get(k) as string | null) ?? '').trim();
    setError(undefined);
    try {
      const r = await api<{ receipt: Receipt; warnings: string[] }>('/receipts', {
        method: 'POST',
        body: {
          supplier: s('supplier'), number: s('number') || null, receiptDate: date, dueDate: s('due') || null, fileId: file?.id ?? null, note: s('note') || null,
          lines: lines.map((i) => ({ text: s(`text-${i}`) || undefined, grossCents: parseEuro(s(`amount-${i}`)) ?? NaN, accountId: s(`account-${i}`), taxRateId: s(`rate-${i}`) || null })),
          pay: paid ? { date: s('pay-date'), moneyAccountId: s('pay-money') } : null,
        },
      });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['journal'] });
      if (r.warnings.length) setWarnings(r.warnings);
      else onClose();
    } catch (err) {
      setError(problemText(err));
    }
  }

  return (
    <Sheet title="Beleg erfassen" open onClose={onClose}>
      {warnings ? (
        <div className="form">
          <div className="alert alert-warn" role="status">Gespeichert. Bitte prüfen: {warnings.join(' ')}</div>
          <div className="actions-row"><button className="btn btn-primary" onClick={onClose}>Verstanden</button></div>
        </div>
      ) : (
        <form className="form" noValidate onSubmit={(e) => void submit(e)}>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <div
            className="dropzone"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const f = e.dataTransfer.files[0]; if (f) void attach(f); }}
          >
            {file ? <p>{file.name}{file.duplicateOf && <span className="error"> · Dieselbe Datei gehört schon zu: {file.duplicateOf}</span>}</p> : <p className="muted">PDF, Foto oder E-Rechnung (ZUGFeRD, XRechnung) hierher ziehen</p>}
            <button type="button" className="btn" aria-busy={busy} disabled={busy} onClick={() => input.current?.click()}>{file ? 'Andere Datei' : 'Datei wählen oder fotografieren'}</button>
            <input ref={input} type="file" accept="application/pdf,image/*,.xml" hidden onChange={(e) => { const f = e.target.files?.[0]; if (f) void attach(f); e.target.value = ''; }} />
          </div>
          <div className="form-row">
            <Field label="Von (Lieferant)" name="supplier" placeholder="z. B. Stadt Musterstadt" autoComplete="off" />
            <Field label="Rechnungsnummer" name="number" autoComplete="off" />
          </div>
          <div className="form-row">
            <Field label="Belegdatum" name="date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />
            <Field label="Fällig am (optional)" name="due" type="date" />
          </div>
          {lines.map((i, n) => (
            <fieldset key={i} className="booking-line" aria-label={`Position ${n + 1}`}>
              <div className="form-row">
                <div className="field"><label htmlFor={`amount-${i}`}>Betrag brutto</label><input id={`amount-${i}`} name={`amount-${i}`} className="input num" inputMode="decimal" /></div>
                <AccountSelect label="Ausgabenkonto" name={`account-${i}`} accounts={expense} />
              </div>
              <div className="form-row">
                <div className="field"><label htmlFor={`rate-${i}`}>Umsatzsteuer</label><select id={`rate-${i}`} name={`rate-${i}`} className="select" defaultValue=""><option value="">keine</option>{validRates.map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}</select></div>
                <div className="field"><label htmlFor={`text-${i}`}>Text (optional)</label><input id={`text-${i}`} name={`text-${i}`} className="input" /></div>
              </div>
            </fieldset>
          ))}
          <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start' }} onClick={() => setLines([...lines, Math.max(...lines) + 1])}><Plus size={16} aria-hidden /> Weitere Position</button>
          <label className="check"><input type="checkbox" checked={paid} onChange={(e) => setPaid(e.target.checked)} /> Schon bezahlt (wird dann gleich gebucht)</label>
          {paid && <PayFields />}
          <div className="field"><label htmlFor="note">Notiz (optional)</label><textarea id="note" name="note" className="textarea" /></div>
          <div className="actions-row"><button className="btn btn-primary">Speichern</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
        </form>
      )}
    </Sheet>
  );
}

function SelfIssuedSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const [error, setError] = useState<string>();
  const expense = (accounts ?? []).filter((a) => a.kind === 'expense' && !a.retired && !a.hidden);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => ((f.get(k) as string | null) ?? '').trim();
    setError(undefined);
    try {
      await api('/receipts/self-issued', { method: 'POST', body: { date: s('date'), payee: s('payee'), text: s('text'), reason: s('reason'), amountCents: parseEuro(s('amount')) ?? NaN, accountId: s('account'), signer: s('signer'), pay: { date: s('date'), moneyAccountId: s('pay-money') } } });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['journal'] });
      onClose();
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <Sheet title="Eigenbeleg" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <p className="muted" style={{ margin: 0 }}>Für Ausgaben ohne fremden Beleg, etwa Parkautomaten oder Trinkgeld. Das PDF wird erzeugt, aufbewahrt und gleich gebucht.</p>
        <div className="form-row">
          <Field label="Datum" name="date" type="date" defaultValue={todayLocal()} max={todayLocal()} />
          <div className="field"><label htmlFor="se-amount">Betrag</label><input id="se-amount" name="amount" className="input num" inputMode="decimal" /></div>
        </div>
        <div className="form-row">
          <Field label="Wofür" name="text" placeholder="Parken beim Turnier" />
          <Field label="An wen gezahlt" name="payee" placeholder="Parkhaus am Markt" />
        </div>
        <div className="field"><label htmlFor="se-reason">Warum es keinen Beleg gibt</label><textarea id="se-reason" name="reason" className="textarea" /></div>
        <div className="form-row">
          <AccountSelect label="Ausgabenkonto" name="account" accounts={expense} />
          <Field label="Unterschrift (Name)" name="signer" />
        </div>
        <PayFieldsMoneyOnly />
        <div className="actions-row"><button className="btn btn-primary">Eigenbeleg erstellen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function PayFieldsMoneyOnly() {
  const { data: accounts } = useAccounts();
  const settings = useSettings();
  const money = (accounts ?? []).filter((a) => a.kind === 'money' && !a.retired && !a.hidden);
  return <AccountSelect label="Bezahlt von" name="pay-money" accounts={money} defaultValue={settings.data?.cashAccountId ?? undefined} />;
}

function PaySheet({ r, onClose }: { r: Receipt; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api(`/receipts/${r.id}/pay`, { method: 'POST', body: { date: f.get('pay-date'), moneyAccountId: f.get('pay-money') } });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['journal'] });
      onClose();
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <Sheet title={`Bezahlt: ${r.supplier}`} open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <p style={{ margin: 0 }}>{euro(r.totalCents)} vom {formatDate(r.receiptDate)}. Gebucht wird am Zahltag (Abflussprinzip).</p>
        <PayFields />
        <div className="actions-row"><button className="btn btn-primary">Buchen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function VoidSheet({ r, onClose }: { r: Receipt; onClose: () => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      await api(`/receipts/${r.id}/void`, { method: 'POST', body: { reason } });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['journal'] });
      onClose();
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <Sheet title={`Beleg ungültig machen: ${r.supplier}`} open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <p style={{ margin: 0 }}>Der Beleg bleibt gespeichert.{r.status === 'paid' ? ` Die Buchung Nr. ${r.journalNumber} wird mit einer Gegenbuchung storniert.` : ''}</p>
        <div className="field"><label htmlFor="v-reason">Grund</label><textarea id="v-reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <div className="actions-row"><button className="btn btn-danger" disabled={reason.trim().length < 5}>Ungültig machen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

interface CashBook { account: { id: string; number: string; name: string }; from: string; to: string; openingCents: number; rows: { entryNumber: number; date: string; text: string; inCents: number; outCents: number; balanceCents: number; receiptId: string | null; receiptHasFile: boolean }[]; closingCents: number }

export function CashBookPage({ me }: { me: Me }) {
  useTitle('Kassenbuch');
  const { data: accounts } = useAccounts();
  const settings = useSettings();
  const [params, setParams] = useSearchParams();
  const year = todayLocal().slice(0, 4);
  const from = params.get('von') ?? `${year}-01-01`;
  const to = params.get('bis') ?? `${year}-12-31`;
  const money = (accounts ?? []).filter((a) => a.kind === 'money');
  const accountId = params.get('konto') ?? settings.data?.cashAccountId ?? money[0]?.id ?? '';
  const book = useQuery({ queryKey: ['cash-book', accountId, from, to], queryFn: () => api<CashBook>(`/ledger/cash-book?accountId=${accountId}&from=${from}&to=${to}`), enabled: !!accountId });
  const set = (k: string, v: string) => setParams({ ...Object.fromEntries(params), [k]: v });

  return (
    <LedgerLayout me={me}>
      <div className="toolbar">
        <label className="sr-only" htmlFor="cb-account">Konto</label>
        <select id="cb-account" className="select" style={{ width: 'auto' }} value={accountId} onChange={(e) => set('konto', e.target.value)}>
          {money.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
        </select>
        <a className="btn" href={`/api/v1/ledger/cash-book.pdf?accountId=${accountId}&from=${from}&to=${to}`}>Als PDF</a>
      </div>
      <RangePicker from={from} to={to} onChange={(f, t) => setParams({ ...Object.fromEntries(params), von: f, bis: t })} />
      {book.data && (
        <div className="table-wrap">
          <table className="table" aria-label="Kassenbuch">
            <thead><tr><th scope="col" className="num hide-sm">Nr.</th><th scope="col" className="num">Datum</th><th scope="col">Text</th><th scope="col" className="num hide-sm">Einnahme</th><th scope="col" className="num hide-sm">Ausgabe</th><th scope="col" className="num show-sm">Betrag</th><th scope="col" className="num">Bestand</th></tr></thead>
            <tbody>
              <tr><td className="hide-sm" /><td className="num">{formatDate(book.data.from)}</td><td className="muted">Anfangsbestand</td><td className="hide-sm" /><td className="hide-sm" /><td className="show-sm" /><td className="num">{euro(book.data.openingCents)}</td></tr>
              {book.data.rows.map((r) => (
                <tr key={r.entryNumber}>
                  <td className="num hide-sm">{r.entryNumber}</td>
                  <td className="num">{formatDate(r.date)}</td>
                  <td>{r.text}{r.receiptId && r.receiptHasFile && <a href={`/api/v1/receipts/${r.receiptId}/file`} target="_blank" rel="noreferrer" aria-label="Beleg öffnen" style={{ marginLeft: 6 }}><FileText size={14} aria-hidden style={{ verticalAlign: '-2px' }} /></a>}</td>
                  <td className="num hide-sm">{r.inCents ? euro(r.inCents) : ''}</td>
                  <td className="num hide-sm">{r.outCents ? euro(r.outCents) : ''}</td>
                  <td className="num show-sm">{euro(r.inCents - r.outCents)}</td>
                  <td className="num">{euro(r.balanceCents)}</td>
                </tr>
              ))}
              <tr><td className="hide-sm" /><td className="num">{formatDate(book.data.to)}</td><td><strong>Endbestand</strong></td><td className="hide-sm" /><td className="hide-sm" /><td className="show-sm" /><td className="num"><strong>{euro(book.data.closingCents)}</strong></td></tr>
            </tbody>
          </table>
        </div>
      )}
    </LedgerLayout>
  );
}
