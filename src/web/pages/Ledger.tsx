import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro } from '../../shared/fees.ts';
import { ACCOUNT_KIND_LABEL, SPHERE_LABEL, SPHERES } from '../../shared/ledger.ts';
import { Field } from '../components/Field.tsx';
import { InlineEdit } from '../components/InlineEdit.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { parseEuro } from '../lib/money.ts';
import { useTitle } from '../lib/useTitle.ts';

type Sphere = (typeof SPHERES)[number];
interface Account { id: string; number: string; name: string; kind: keyof typeof ACCOUNT_KIND_LABEL; defaultSphere: Sphere; datevNumber: string | null; hidden: boolean; retired: boolean; used: boolean }
interface TaxRate { id: string; label: string; rateBp: number; validFrom: string; validTo: string | null }
interface Entry { id: string; number: number; date: string; text: string; source: string; reversesNumber: number | null; reversedBy: number | null; createdBy: string | null; lines: { accountId: string; accountNumber: string; accountName: string; debitCents: number; creditCents: number; sphere: Sphere; costCenter: string | null; taxRate: string | null; text: string | null }[] }
interface Euer { from: string; to: string; rows: { accountId: string; number: string; name: string; kind: 'income' | 'expense'; sphere: Sphere; netCents: number }[]; spheres: { sphere: Sphere; incomeCents: number; expenseCents: number; resultCents: number }[]; vat: { outputCents: number; inputCents: number }; totals: { incomeCents: number; expenseCents: number; resultCents: number }; warnings: { kind: string; message: string; href: string | null }[] }
interface Settings { bankAccountId: string | null; cashAccountId: string | null; feeAccountId: string | null; otherIncomeAccountId: string | null; dunningAccountId: string | null; lockDate: string | null; bankAccounts: { id: string; name: string; ibanLast4: string; ledgerAccountId: string | null }[] }

const SOURCE_LABEL: Record<string, string> = { manual: 'Buchung', allocation: 'Zahlung', allocation_reversal: 'Zahlung zurückgenommen', reversal: 'Storno', receipt: 'Beleg', import: 'Import' };
const useAccounts = () => useQuery({ queryKey: ['ledger-accounts'], queryFn: () => api<Account[]>('/ledger/accounts') });
const year = () => todayLocal().slice(0, 4);

function LedgerLayout({ me, children, action }: { me: Me; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="page">
      <PageHead title="Buchhaltung" intro="Einnahmen-Überschuss-Rechnung nach Zufluss: Zahlungen auf Rechnungen werden automatisch gebucht, alles andere buchst Du hier. Gebuchtes wird nie geändert, nur storniert." actions={me.permissions.ledger === 'write' ? action : undefined} />
      <nav className="subnav" aria-label="Buchhaltung">
        <NavLink to="/buchhaltung" end>Journal</NavLink>
        <NavLink to="/buchhaltung/euer">EÜR</NavLink>
        <NavLink to="/buchhaltung/konten">Konten</NavLink>
        <NavLink to="/buchhaltung/export">Export</NavLink>
        <NavLink to="/buchhaltung/einstellungen">Einstellungen</NavLink>
      </nav>
      {children}
    </div>
  );
}

export function Journal({ me }: { me: Me }) {
  useTitle('Journal');
  const navigate = useNavigate();
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const from = params.get('von') ?? `${year()}-01-01`;
  const to = params.get('bis') ?? `${year()}-12-31`;
  const entries = useQuery({ queryKey: ['journal', from, to], queryFn: () => api<Entry[]>(`/ledger/entries?from=${from}&to=${to}`) });
  const [booking, setBooking] = useState(false);
  const selected = entries.data?.find((e) => e.id === id) ?? null;

  return (
    <LedgerLayout me={me} action={<button className="btn btn-primary" onClick={() => setBooking(true)}><Plus size={16} aria-hidden /> Buchen</button>}>
      <RangePicker from={from} to={to} onChange={(f, t) => setParams({ von: f, bis: t })} />
      <div className="table-wrap">
        {entries.data?.length === 0 ? (
          <div className="empty-state"><h3>Keine Buchungen im Zeitraum.</h3><p>Zahlungen auf Rechnungen erscheinen hier von selbst. Spenden, Zuschüsse und Ausgaben buchst Du mit „Buchen“.</p></div>
        ) : (
          <table className="table" aria-label="Journal">
            <thead><tr><th scope="col" className="num">Nr.</th><th scope="col" className="num">Datum</th><th scope="col">Text</th><th scope="col" className="hide-sm">Konten</th><th scope="col" className="num">Betrag</th></tr></thead>
            <tbody>
              {entries.data?.map((e) => {
                const amount = e.lines.reduce((s, l) => s + l.debitCents, 0);
                const debit = e.lines.filter((l) => l.debitCents).map((l) => l.accountNumber);
                const credit = e.lines.filter((l) => l.creditCents).map((l) => l.accountNumber);
                return (
                  <tr key={e.id} data-href tabIndex={0} aria-selected={e.id === id} onClick={() => navigate(`/buchhaltung/${e.id}?${params}`)} onKeyDown={(k) => k.key === 'Enter' && navigate(`/buchhaltung/${e.id}?${params}`)}>
                    <td className="num">{e.number}</td>
                    <td className="num">{formatDate(e.date)}</td>
                    <td><span className="name">{e.text}</span>{e.source !== 'manual' && <span className="pill hide-sm" style={{ marginLeft: 8 }}>{SOURCE_LABEL[e.source]}</span>}{e.reversedBy && <span className="meta"> · storniert</span>}</td>
                    <td className="hide-sm num">{[...new Set(debit)].join(', ')} an {[...new Set(credit)].join(', ')}</td>
                    <td className="num">{euro(amount)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      {booking && <BookingSheet onClose={() => setBooking(false)} />}
      <EntrySheet entry={selected} canWrite={me.permissions.ledger === 'write'} onClose={() => navigate(`/buchhaltung?${params}`)} />
    </LedgerLayout>
  );
}

function RangePicker({ from, to, onChange }: { from: string; to: string; onChange: (from: string, to: string) => void }) {
  const y = Number(from.slice(0, 4));
  return (
    <div className="toolbar">
      <div className="segmented" role="group" aria-label="Jahr">
        {[y - 1, y, y + 1].map((x) => <button key={x} aria-pressed={from === `${x}-01-01` && to === `${x}-12-31`} onClick={() => onChange(`${x}-01-01`, `${x}-12-31`)}>{x}</button>)}
      </div>
      <input type="date" className="input" style={{ width: 'auto' }} aria-label="Von" value={from} onChange={(e) => e.target.value && onChange(e.target.value, to)} />
      <input type="date" className="input" style={{ width: 'auto' }} aria-label="Bis" value={to} onChange={(e) => e.target.value && onChange(from, e.target.value)} />
    </div>
  );
}

function EntrySheet({ entry, canWrite, onClose }: { entry: Entry | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  async function reverse() {
    setError(undefined);
    try {
      await api(`/ledger/entries/${entry!.id}/reverse`, { method: 'POST', body: {} });
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: ['journal'] });
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    }
  }
  return (
    <Sheet title={entry ? `Buchung ${entry.number}` : 'Buchung'} open={!!entry} onClose={() => { setConfirm(false); setError(undefined); onClose(); }}>
      {entry && (
        <>
          <p className="meta" style={{ marginTop: 'calc(-1 * var(--s-3))', marginBottom: 'var(--s-4)' }}>{formatDate(entry.date)} · {SOURCE_LABEL[entry.source]}{entry.createdBy && ` · ${entry.createdBy}`}{entry.reversesNumber && ` · storniert Nr. ${entry.reversesNumber}`}{entry.reversedBy && ` · storniert durch Nr. ${entry.reversedBy}`}</p>
          <p style={{ marginBottom: 'var(--s-4)' }}>{entry.text}</p>
          <table className="table" aria-label="Buchungszeilen">
            <thead><tr><th scope="col">Konto</th><th scope="col" className="hide-sm">Sphäre</th><th scope="col" className="num">Soll</th><th scope="col" className="num">Haben</th></tr></thead>
            <tbody>
              {entry.lines.map((l, i) => (
                <tr key={i}>
                  <td><span className="num">{l.accountNumber}</span> {l.accountName}{l.taxRate && <span className="meta"> · {l.taxRate}</span>}{l.text && <div className="meta">{l.text}</div>}</td>
                  <td className="hide-sm">{SPHERE_LABEL[l.sphere]}</td>
                  <td className="num">{l.debitCents ? euro(l.debitCents) : ''}</td>
                  <td className="num">{l.creditCents ? euro(l.creditCents) : ''}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {error && <div className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-3)' }}>{error}</div>}
          {canWrite && !entry.reversedBy && !entry.reversesNumber && (
            <div className="actions-row">
              {entry.source.startsWith('allocation') ? (
                <p className="meta">Diese Buchung folgt einer Zahlung. Korrigiere die Zahlung bei der Rechnung oder im Kontoabgleich.</p>
              ) : confirm ? (
                <><span>Gegenbuchung mit heutigem Datum anlegen?</span><button className="btn btn-danger" onClick={() => void reverse()}>Ja, stornieren</button><button className="btn btn-ghost" onClick={() => setConfirm(false)}>Abbrechen</button></>
              ) : (
                <button className="btn" onClick={() => setConfirm(true)}>Stornieren …</button>
              )}
            </div>
          )}
        </>
      )}
    </Sheet>
  );
}

function BookingSheet({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const rates = useQuery({ queryKey: ['tax-rates'], queryFn: () => api<TaxRate[]>('/ledger/tax-rates') });
  const settings = useQuery({ queryKey: ['ledger-settings'], queryFn: () => api<Settings>('/ledger/settings') });
  const [kind, setKind] = useState<'income' | 'expense' | 'transfer'>('income');
  const [date, setDate] = useState(todayLocal());
  const [lines, setLines] = useState([0]);
  const [error, setError] = useState<ApiError>();
  const usable = (accounts ?? []).filter((a) => !a.retired && !a.hidden);
  const money = usable.filter((a) => a.kind === 'money');
  const targets = usable.filter((a) => a.kind === kind);
  const validRates = (rates.data ?? []).filter((r) => r.validFrom <= date && (!r.validTo || r.validTo >= date)).sort((a, b) => a.rateBp - b.rateBp);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    const body = kind === 'transfer'
      ? { kind, date, text: f.get('text'), fromAccountId: f.get('from'), toAccountId: f.get('to'), amountCents: parseEuro(String(f.get('amount') ?? '')) ?? NaN }
      : {
          kind, date, text: f.get('text'), moneyAccountId: f.get('money'),
          lines: lines.map((i) => ({ text: (f.get(`text-${i}`) as string) || undefined, grossCents: parseEuro(String(f.get(`amount-${i}`) ?? '')) ?? NaN, accountId: f.get(`account-${i}`), taxRateId: (f.get(`rate-${i}`) as string) || null, sphere: (f.get(`sphere-${i}`) as string) || undefined })),
        };
    try {
      await api('/ledger/bookings', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['journal'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <Sheet title="Buchen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={submit}>
        {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? [error.problem.title, error.problem.detail].filter(Boolean).join(' ')}</div>}
        <div className="segmented" role="group" aria-label="Art">
          <button type="button" aria-pressed={kind === 'income'} onClick={() => setKind('income')}>Einnahme</button>
          <button type="button" aria-pressed={kind === 'expense'} onClick={() => setKind('expense')}>Ausgabe</button>
          <button type="button" aria-pressed={kind === 'transfer'} onClick={() => setKind('transfer')}>Umbuchung</button>
        </div>
        <div className="form-row">
          <Field label="Datum" name="date" type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} error={error?.fieldError('date')} />
          <Field label="Buchungstext" name="text" placeholder={kind === 'income' ? 'Spende Bäckerei Krause' : kind === 'expense' ? 'Hallenmiete Oktober' : 'Einzahlung Kasse auf Bank'} error={error?.fieldError('text')} />
        </div>
        {kind === 'transfer' ? (
          <>
            <div className="form-row">
              <AccountSelect label="Von" name="from" accounts={money} defaultValue={settings.data?.cashAccountId ?? undefined} />
              <AccountSelect label="Nach" name="to" accounts={money} defaultValue={settings.data?.bankAccountId ?? undefined} />
            </div>
            <div className="field"><label htmlFor="tr-amount">Betrag</label><input id="tr-amount" name="amount" className="input num" inputMode="decimal" /></div>
            <p className="meta">Geld zwischen eigenen Konten: über Geldtransit gebucht, keine Einnahme.</p>
          </>
        ) : (
          <>
            <AccountSelect label={kind === 'income' ? 'Eingegangen auf' : 'Bezahlt von'} name="money" accounts={money} defaultValue={settings.data?.bankAccountId ?? undefined} />
            {lines.map((i, n) => (
              <fieldset key={i} className="booking-line" aria-label={`Position ${n + 1}`}>
                <div className="form-row">
                  <div className="field"><label htmlFor={`amount-${i}`}>Betrag brutto</label><input id={`amount-${i}`} name={`amount-${i}`} className="input num" inputMode="decimal" aria-invalid={!!error?.fieldError(`lines.${n}.grossCents`)} /></div>
                  <AccountSelect label={kind === 'income' ? 'Einnahmenkonto' : 'Ausgabenkonto'} name={`account-${i}`} accounts={targets} error={error?.fieldError(`lines.${n}.accountId`)} />
                </div>
                <div className="form-row">
                  <div className="field">
                    <label htmlFor={`rate-${i}`}>Umsatzsteuer</label>
                    <select id={`rate-${i}`} name={`rate-${i}`} className="select" defaultValue="">
                      <option value="">keine</option>
                      {validRates.filter((r) => r.rateBp > 0).map((r) => <option key={r.id} value={r.id}>{r.label}</option>)}
                    </select>
                  </div>
                  <div className="field">
                    <label htmlFor={`sphere-${i}`}>Sphäre</label>
                    <select id={`sphere-${i}`} name={`sphere-${i}`} className="select" defaultValue="">
                      <option value="">wie das Konto</option>
                      {SPHERES.map((s) => <option key={s} value={s}>{SPHERE_LABEL[s]}</option>)}
                    </select>
                  </div>
                </div>
                <Field label="Text der Position (optional)" name={`text-${i}`} />
                {lines.length > 1 && <button type="button" className="linklike" onClick={() => setLines(lines.filter((x) => x !== i))}>Position entfernen</button>}
              </fieldset>
            ))}
            <button type="button" className="btn btn-ghost" onClick={() => setLines([...lines, Math.max(...lines) + 1])}><Plus size={16} aria-hidden /> Weitere Position (anderer Steuersatz oder Konto)</button>
          </>
        )}
        <div className="actions-row"><button className="btn btn-primary">Buchen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function AccountSelect({ label, name, accounts, defaultValue, error }: { label: string; name: string; accounts: Account[]; defaultValue?: string; error?: string }) {
  return (
    <div className="field">
      <label htmlFor={name}>{label}</label>
      <select id={name} name={name} className="select" defaultValue={defaultValue ?? ''} key={`${defaultValue}-${accounts.length}`} aria-invalid={!!error}>
        <option value="" disabled>Konto wählen</option>
        {accounts.map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
      </select>
      {error && <span className="error">{error}</span>}
    </div>
  );
}

export function EuerReport({ me }: { me: Me }) {
  useTitle('EÜR');
  const [params, setParams] = useSearchParams();
  const from = params.get('von') ?? `${year()}-01-01`;
  const to = params.get('bis') ?? `${year()}-12-31`;
  const { data } = useQuery({ queryKey: ['euer', from, to], queryFn: () => api<Euer>(`/ledger/reports/euer?from=${from}&to=${to}`) });
  const csv = useMemo(() => {
    if (!data) return '';
    const rows = [['Konto', 'Name', 'Art', 'Sphäre', 'Netto EUR'], ...data.rows.map((r) => [r.number, r.name, r.kind === 'income' ? 'Einnahme' : 'Ausgabe', SPHERE_LABEL[r.sphere], (r.netCents / 100).toFixed(2).replace('.', ',')])];
    return URL.createObjectURL(new Blob(['﻿' + rows.map((r) => r.map((c) => `"${c.replace(/"/g, '""')}"`).join(';')).join('\r\n')], { type: 'text/csv' }));
  }, [data]);
  return (
    <LedgerLayout me={me}>
      <RangePicker from={from} to={to} onChange={(f, t) => setParams({ von: f, bis: t })} />
      {data && (
        <>
          {data.warnings.length > 0 && (
            <ul className="warnings" aria-label="Hinweise">
              {data.warnings.map((w) => <li key={w.kind + w.message}>{w.href ? <Link to={w.href}>{w.message}</Link> : w.message}</li>)}
            </ul>
          )}
          <dl className="figures">
            <div><dt>Einnahmen</dt><dd className="num">{euro(data.totals.incomeCents)}</dd></div>
            <div><dt>Ausgaben</dt><dd className="num">{euro(data.totals.expenseCents)}</dd></div>
            <div><dt>Überschuss</dt><dd className="num">{euro(data.totals.resultCents)}</dd></div>
          </dl>
          <section className="section" aria-labelledby="spheres">
            <h2 id="spheres">Nach Sphären</h2>
            <div className="table-wrap">
              <table className="table" aria-label="Ergebnis nach Sphären">
                <thead><tr><th scope="col">Sphäre</th><th scope="col" className="num">Einnahmen</th><th scope="col" className="num">Ausgaben</th><th scope="col" className="num">Ergebnis</th></tr></thead>
                <tbody>
                  {data.spheres.map((s) => (
                    <tr key={s.sphere}><td>{SPHERE_LABEL[s.sphere]}</td><td className="num">{euro(s.incomeCents)}</td><td className="num">{euro(s.expenseCents)}</td><td className="num">{euro(s.resultCents)}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            {(data.vat.outputCents > 0 || data.vat.inputCents > 0) && <p className="meta" style={{ marginTop: 'var(--s-3)' }}>Umsatzsteuer eingenommen {euro(data.vat.outputCents)}, Vorsteuer bezahlt {euro(data.vat.inputCents)} (nicht in den Beträgen oben).</p>}
          </section>
          <section className="section" aria-labelledby="accts">
            <h2 id="accts">Nach Konten</h2>
            <div className="table-wrap">
              <table className="table" aria-label="Ergebnis nach Konten">
                <thead><tr><th scope="col" className="num">Konto</th><th scope="col">Name</th><th scope="col" className="hide-sm">Sphäre</th><th scope="col" className="num">Einnahmen</th><th scope="col" className="num">Ausgaben</th></tr></thead>
                <tbody>
                  {data.rows.map((r) => (
                    <tr key={r.accountId + r.sphere}><td className="num"><Link to={`/buchhaltung?von=${from}&bis=${to}`}>{r.number}</Link></td><td>{r.name}</td><td className="hide-sm">{SPHERE_LABEL[r.sphere]}</td><td className="num">{r.kind === 'income' ? euro(r.netCents) : ''}</td><td className="num">{r.kind === 'expense' ? euro(r.netCents) : ''}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="actions-row"><a className="btn" href={csv} download={`EUER_${from}_${to}.csv`}>Als CSV</a></div>
          </section>
        </>
      )}
    </LedgerLayout>
  );
}

export function Accounts({ me }: { me: Me }) {
  useTitle('Konten');
  const qc = useQueryClient();
  const { data } = useAccounts();
  const canWrite = me.permissions.ledger === 'write';
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError>();
  const patch = async (id: string, body: Partial<{ datevNumber: string | null; hidden: boolean; retired: boolean; name: string }>) => {
    await api(`/ledger/accounts/${id}`, { method: 'PATCH', body });
    await qc.invalidateQueries({ queryKey: ['ledger-accounts'] });
  };
  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/ledger/accounts', { method: 'POST', body: { number: f.get('number'), name: f.get('name'), kind: f.get('kind'), defaultSphere: f.get('sphere'), datevNumber: f.get('datev') || null } });
      setAdding(false);
      await qc.invalidateQueries({ queryKey: ['ledger-accounts'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  return (
    <LedgerLayout me={me} action={<button className="btn" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Konto anlegen</button>}>
      <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '72ch' }}>Ein schlanker Kontenplan für Vereine. Trag in der Spalte DATEV die Kontonummer aus dem Kontenrahmen Deiner Steuerberatung ein (zum Beispiel SKR 42 oder SKR 49); ohne sie geht kein DATEV-Export. Benutzte Konten werden nie gelöscht, nur stillgelegt.</p>
      {adding && (
        <form className="inline-form" noValidate onSubmit={add} style={{ maxWidth: 720, marginBottom: 'var(--s-4)' }}>
          {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.title}</div>}
          <div className="form-row">
            <Field label="Nummer" name="number" inputMode="numeric" error={error?.fieldError('number')} />
            <Field label="Name" name="name" error={error?.fieldError('name')} />
          </div>
          <div className="form-row">
            <div className="field"><label htmlFor="kind">Art</label><select id="kind" name="kind" className="select"><option value="income">Einnahmen</option><option value="expense">Ausgaben</option><option value="money">Geldkonto</option><option value="other">Sonstiges</option></select></div>
            <div className="field"><label htmlFor="sphere">Sphäre</label><select id="sphere" name="sphere" className="select">{SPHERES.map((s) => <option key={s} value={s}>{SPHERE_LABEL[s]}</option>)}</select></div>
            <Field label="DATEV-Konto" name="datev" inputMode="numeric" error={error?.fieldError('datevNumber')} />
          </div>
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Anlegen</button><button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button></div>
        </form>
      )}
      <div className="table-wrap">
        <table className="table" aria-label="Kontenplan">
          <thead><tr><th scope="col" className="num">Nr.</th><th scope="col">Name</th><th scope="col" className="hide-sm">Art</th><th scope="col" className="hide-sm">Sphäre</th><th scope="col" className="num">DATEV</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
          <tbody>
            {data?.map((a) => (
              <tr key={a.id} style={a.retired ? { opacity: 0.6 } : undefined}>
                <td className="num">{a.number}</td>
                <td>{canWrite ? <InlineEdit label={`Name von ${a.number}`} value={a.name} onSave={(name) => patch(a.id, { name })} /> : a.name}{a.retired && <span className="pill" style={{ marginLeft: 8 }}>stillgelegt</span>}{a.hidden && <span className="pill" style={{ marginLeft: 8 }}>ausgeblendet</span>}</td>
                <td className="hide-sm">{ACCOUNT_KIND_LABEL[a.kind]}</td>
                <td className="hide-sm">{SPHERE_LABEL[a.defaultSphere]}</td>
                <td className="num">{canWrite ? <InlineEdit label={`DATEV-Konto für ${a.number}`} value={a.datevNumber ?? ''} onSave={(v) => patch(a.id, { datevNumber: v || null })} /> : (a.datevNumber ?? '—')}</td>
                <td className="num">{canWrite && <button className="linklike" onClick={() => void patch(a.id, a.used ? { retired: !a.retired } : { hidden: !a.hidden })}>{a.used ? (a.retired ? 'reaktivieren' : 'stilllegen') : a.hidden ? 'einblenden' : 'ausblenden'}</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </LedgerLayout>
  );
}

export function LedgerSettings({ me }: { me: Me }) {
  useTitle('Buchhaltung · Einstellungen');
  const qc = useQueryClient();
  const { data: accounts } = useAccounts();
  const { data: s } = useQuery({ queryKey: ['ledger-settings'], queryFn: () => api<Settings>('/ledger/settings') });
  const canWrite = me.permissions.ledger === 'write';
  const [error, setError] = useState<string>();
  const [lockDate, setLockDate] = useState('');
  const [reason, setReason] = useState('');
  const save = async (body: Record<string, unknown>) => {
    setError(undefined);
    try {
      qc.setQueryData(['ledger-settings'], await api<Settings>('/ledger/settings', { method: 'PATCH', body }));
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  };
  async function lock(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      qc.setQueryData(['ledger-settings'], await api<Settings>('/ledger/lock', { method: 'POST', body: { lockDate: lockDate || null, reason: reason || undefined } }));
      setReason('');
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? [err.problem.title, err.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');
    }
  }
  if (!s || !accounts) return <LedgerLayout me={me}><div className="skeleton" style={{ width: 280 }} /></LedgerLayout>;
  const pick = (label: string, key: keyof Settings, kind: Account['kind']) => (
    <>
      <dt>{label}</dt>
      <dd>
        <select className="select" aria-label={label} disabled={!canWrite} value={(s[key] as string | null) ?? ''} onChange={(e) => void save({ [key]: e.target.value || null })}>
          <option value="">nicht buchen</option>
          {accounts.filter((a) => a.kind === kind && !a.retired).map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
        </select>
      </dd>
    </>
  );
  const backwards = !!s.lockDate && (!lockDate || lockDate < s.lockDate);
  return (
    <LedgerLayout me={me}>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <section aria-labelledby="map">
        <h2 id="map" style={{ marginBottom: 'var(--s-2)' }}>Zahlungen automatisch buchen</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Sobald eine Rechnung bezahlt ist, bucht OpenVerein den Betrag. Hier legst Du fest, auf welche Konten.</p>
        <dl className="facts">
          {pick('Bank (Standard)', 'bankAccountId', 'money')}
          {pick('Kasse (Barzahlungen)', 'cashAccountId', 'money')}
          {pick('Mitgliedsbeiträge', 'feeAccountId', 'income')}
          {pick('Sonstige Rechnungen', 'otherIncomeAccountId', 'income')}
          {pick('Mahngebühren', 'dunningAccountId', 'income')}
          {s.bankAccounts.map((b) => (
            <div key={b.id} style={{ display: 'contents' }}>
              <dt>{b.name} (•••• {b.ibanLast4})</dt>
              <dd>
                <select className="select" aria-label={`Buchungskonto für ${b.name}`} disabled={!canWrite} value={b.ledgerAccountId ?? ''} onChange={(e) => void save({ bankAccounts: [{ id: b.id, ledgerAccountId: e.target.value || null }] })}>
                  <option value="">wie Bank (Standard)</option>
                  {accounts.filter((a) => a.kind === 'money' && !a.retired).map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
                </select>
              </dd>
            </div>
          ))}
        </dl>
      </section>
      <section className="section" aria-labelledby="lock">
        <h2 id="lock" style={{ marginBottom: 'var(--s-2)' }}>Zeitraum abschließen</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Nach GoBD bleibt Abgeschlossenes unverändert: Bis zum Sperrdatum nimmt OpenVerein keine Buchung und keine Zahlung mehr an. {s.lockDate ? `Gesperrt bis einschließlich ${formatDate(s.lockDate)}.` : 'Noch nichts gesperrt.'}</p>
        {canWrite && (
          <form className="inline-form" noValidate onSubmit={lock} style={{ maxWidth: 560 }}>
            <Field label="Sperren bis einschließlich" name="lockDate" type="date" value={lockDate} onChange={(e) => setLockDate(e.target.value)} />
            {backwards && <Field label="Begründung (der Zeitraum war schon abgeschlossen)" name="reason" value={reason} onChange={(e) => setReason(e.target.value)} hint="Wird mit Deinem Namen protokolliert. Du bestätigst zusätzlich mit Deinem Code." />}
            <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">{backwards ? 'Zeitraum wieder öffnen' : 'Sperren'}</button></div>
          </form>
        )}
      </section>
    </LedgerLayout>
  );
}

interface DatevSettings { consultant: number | null; client: number | null; accountLength: number; fiscalYearStartMonth: number }
interface DatevExport { id: string; mode: 'delta' | 'full'; from: string; to: string; entryCount: number; sha256: string; createdAt: string }

export function LedgerExports({ me }: { me: Me }) {
  useTitle('Buchhaltung · Export');
  const qc = useQueryClient();
  const canWrite = me.permissions.ledger === 'write';
  const settings = useQuery({ queryKey: ['datev-settings'], queryFn: () => api<DatevSettings>('/ledger/datev-settings') });
  const exports = useQuery({ queryKey: ['datev-exports'], queryFn: () => api<DatevExport[]>('/ledger/exports') });
  const y = Number(year());
  const [from, setFrom] = useState(`${y}-01-01`);
  const [to, setTo] = useState(todayLocal());
  const [mode, setMode] = useState<'delta' | 'full'>('delta');
  const [error, setError] = useState<ApiError>();
  const [done, setDone] = useState<DatevExport>();

  async function saveSettings(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (f.get(k) ? Number(f.get(k)) : null);
    setError(undefined);
    try {
      qc.setQueryData(['datev-settings'], await api<DatevSettings>('/ledger/datev-settings', { method: 'PUT', body: { consultant: num('consultant'), client: num('client'), accountLength: num('accountLength') ?? 4, fiscalYearStartMonth: num('fy') ?? 1 } }));
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function run() {
    setError(undefined);
    setDone(undefined);
    try {
      setDone(await api<DatevExport>('/ledger/exports/datev', { method: 'POST', body: { from, to, mode } }));
      await qc.invalidateQueries({ queryKey: ['datev-exports'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  const s = settings.data;
  return (
    <LedgerLayout me={me}>
      {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-5)' }}>{error.problem.errors?.map((x) => x.message).join(' ') ?? [error.problem.title, error.problem.detail].filter(Boolean).join(' ')}{error.problem.type.endsWith('/datev-mapping') && <> <Link to="/buchhaltung/konten">Zum Kontenplan</Link></>}</div>}
      <section aria-labelledby="datev">
        <h2 id="datev" style={{ marginBottom: 'var(--s-2)' }}>DATEV für die Steuerberatung</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '72ch' }}>Buchungsstapel im DATEV-Format (EXTF 700). Sphäre geht als KOST1 (1 ideell, 2 Vermögensverwaltung, 3 Zweckbetrieb, 4 wirtschaftlich) mit, die Kostenstelle als KOST2. Mach mit Deiner Steuerberatung vor dem ersten echten Export eine Test-Übernahme.</p>
        {s && canWrite && (
          <form className="inline-form" noValidate onSubmit={saveSettings} style={{ maxWidth: 720, marginBottom: 'var(--s-4)' }}>
            <div className="form-row">
              <Field label="Beraternummer" name="consultant" inputMode="numeric" defaultValue={s.consultant ?? ''} />
              <Field label="Mandantennummer" name="client" inputMode="numeric" defaultValue={s.client ?? ''} />
            </div>
            <div className="form-row">
              <Field label="Länge der Sachkonten" name="accountLength" inputMode="numeric" defaultValue={s.accountLength} />
              <Field label="Wirtschaftsjahr beginnt im Monat" name="fy" inputMode="numeric" defaultValue={s.fiscalYearStartMonth} />
            </div>
            <div className="actions-row" style={{ marginTop: 0 }}><button className="btn">Speichern</button></div>
          </form>
        )}
        {canWrite && (
          <div className="toolbar">
            <input type="date" className="input" style={{ width: 'auto' }} aria-label="Von" value={from} onChange={(e) => e.target.value && setFrom(e.target.value)} />
            <input type="date" className="input" style={{ width: 'auto' }} aria-label="Bis" value={to} onChange={(e) => e.target.value && setTo(e.target.value)} />
            <div className="segmented" role="group" aria-label="Umfang">
              <button aria-pressed={mode === 'delta'} onClick={() => setMode('delta')}>Nur Neues</button>
              <button aria-pressed={mode === 'full'} onClick={() => setMode('full')}>Alles im Zeitraum</button>
            </div>
            <button className="btn btn-primary" onClick={() => void run()}>Exportieren</button>
          </div>
        )}
        {done && (
          <div className="alert alert-ok" role="status" style={{ marginTop: 'var(--s-4)' }}>
            {done.entryCount} Buchungen exportiert. <a href={`/api/v1/ledger/exports/${done.id}/file`}>ZIP herunterladen</a>. Zeitraum jetzt abschließen? <Link to="/buchhaltung/einstellungen">Sperrdatum auf {formatDate(done.to)} setzen</Link>
          </div>
        )}
        <ul className="timeline" style={{ maxWidth: 720 }}>
          {exports.data?.map((x) => (
            <li key={x.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <span>{formatDate(x.from)} bis {formatDate(x.to)} <span className="meta">· {x.entryCount} Buchungen · {x.mode === 'delta' ? 'nur Neues' : 'vollständig'} · {new Date(x.createdAt).toLocaleString('de-DE')}</span></span>
              <a href={`/api/v1/ledger/exports/${x.id}/file`}>Herunterladen</a>
            </li>
          ))}
        </ul>
      </section>
      <section className="section" aria-labelledby="z3">
        <h2 id="z3" style={{ marginBottom: 'var(--s-2)' }}>Betriebsprüfung</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '72ch' }}>Datenträgerüberlassung nach GoBD (Z3) für ein Geschäftsjahr: index.xml im Beschreibungsstandard und Tabellen für Buchungen, Buchungszeilen, Konten, Rechnungen und Debitoren. Jeder Abruf wird protokolliert.</p>
        <div className="actions-row" style={{ marginTop: 0 }}>{[y - 1, y].map((x) => <a key={x} className="btn" href={`/api/v1/ledger/exports/z3?year=${x}`}>Paket {x}</a>)}</div>
      </section>
    </LedgerLayout>
  );
}
