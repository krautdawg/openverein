import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useSearchParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import type { Donation, DonationSettings, Receipt } from '../../shared/donations.ts';
import { euro } from '../../shared/fees.ts';
import { Field } from '../components/Field.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

interface Donor { personId: string; name: string; city: string | null; membershipNumber: string | null }
interface Account { id: string; number: string; name: string; kind: string; retired: boolean; hidden: boolean }

const problemText = (e: ApiError) => e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ');

function useYear() {
  const [params, setParams] = useSearchParams();
  const now = Number(todayLocal().slice(0, 4));
  const year = Number(params.get('jahr') ?? now);
  const picker = (
    <div className="segmented" role="group" aria-label="Jahr">
      {[now - 2, now - 1, now].map((y) => <button key={y} aria-pressed={y === year} onClick={() => setParams({ jahr: String(y) })}>{y}</button>)}
    </div>
  );
  return { year, picker };
}

function DonationsLayout({ me, children, action }: { me: Me; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className="page">
      <PageHead title="Spenden" intro="Geldspenden erfassen und Zuwendungsbestätigungen nach dem amtlichen Muster ausstellen. Ausgestellte Bestätigungen bleiben unverändert; Fehler werden storniert und neu ausgestellt." actions={me.permissions.donations === 'write' ? action : undefined} />
      <nav className="subnav" aria-label="Spenden">
        <NavLink to="/spenden" end>Spenden</NavLink>
        <NavLink to="/spenden/bestaetigungen">Bestätigungen</NavLink>
        <NavLink to="/spenden/einstellungen">Einstellungen</NavLink>
      </nav>
      {children}
    </div>
  );
}

export function Donations({ me }: { me: Me }) {
  useTitle('Spenden');
  const qc = useQueryClient();
  const { year, picker } = useYear();
  const list = useQuery({ queryKey: ['donations', year], queryFn: () => api<Donation[]>(`/donations?year=${year}`) });
  const [creating, setCreating] = useState(false);
  const [voiding, setVoiding] = useState<Donation | null>(null);
  const [voidReason, setVoidReason] = useState('');
  const [message, setMessage] = useState<{ ok: boolean; text: string }>();
  const canWrite = me.permissions.donations === 'write';
  const open = list.data?.filter((d) => !d.receipt) ?? [];
  const total = list.data?.reduce((s, d) => s + d.amountCents, 0) ?? 0;

  async function annual() {
    setMessage(undefined);
    try {
      const r = await api<{ issued: number; skipped: { donorName: string; reason: string }[] }>('/donation-receipts/annual', { method: 'POST', body: { year } });
      setMessage({ ok: r.skipped.length === 0, text: `${r.issued} Bestätigung${r.issued === 1 ? '' : 'en'} ausgestellt.${r.skipped.length ? ` Übersprungen: ${r.skipped.map((s) => `${s.donorName} (${s.reason})`).join('; ')}` : ''}` });
      await qc.invalidateQueries({ queryKey: ['donations'] });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
    } catch (err) {
      if (err instanceof ApiError) setMessage({ ok: false, text: problemText(err) });
    }
  }
  async function voidDonation() {
    if (!voiding) return;
    setMessage(undefined);
    try {
      await api(`/donations/${voiding.id}/void`, { method: 'POST', body: { reason: voidReason } });
      setVoiding(null);
      setVoidReason('');
      await qc.invalidateQueries({ queryKey: ['donations'] });
    } catch (err) {
      setVoiding(null);
      if (err instanceof ApiError) setMessage({ ok: false, text: problemText(err) });
    }
  }
  async function single(d: Donation) {
    setMessage(undefined);
    try {
      const r = await api<Receipt>('/donation-receipts', { method: 'POST', body: { personId: d.personId, donationIds: [d.id] } });
      setMessage({ ok: true, text: `Bestätigung ${r.number} ausgestellt.` });
      await qc.invalidateQueries({ queryKey: ['donations'] });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
    } catch (err) {
      if (err instanceof ApiError) setMessage({ ok: false, text: problemText(err) });
    }
  }

  return (
    <DonationsLayout me={me} action={<button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden /> Spende erfassen</button>}>
      <div className="toolbar">
        {picker}
        {canWrite && open.length > 0 && <button className="btn" onClick={() => void annual()}>Jahresbestätigungen {year} ausstellen</button>}
      </div>
      {message && <div className={`alert ${message.ok ? 'alert-ok' : 'alert-error'}`} role={message.ok ? 'status' : 'alert'} style={{ marginBottom: 'var(--s-4)' }}>{message.text}</div>}
      {list.data && list.data.length > 0 && <p className="muted" style={{ marginBottom: 'var(--s-3)' }}>{list.data.length} Spenden, zusammen {euro(total)}; {open.length} noch ohne Bestätigung.</p>}
      <div className="table-wrap">
        {list.data?.length === 0 ? (
          <p className="empty">Keine Spenden in {year}.</p>
        ) : (
          <table className="table" aria-label="Spenden">
            <thead><tr><th scope="col">Datum</th><th scope="col">Spender:in</th><th scope="col" className="num">Betrag</th><th scope="col" className="hide-sm">Buchung</th><th scope="col">Bestätigung</th></tr></thead>
            <tbody>
              {list.data?.map((d) => (
                <tr key={d.id}>
                  <td className="num">{formatDate(d.date)}</td>
                  <td><span className="name">{d.donorName}</span>{d.waiver && <span className="meta"> · Aufwandsspende</span>}</td>
                  <td className="num">{euro(d.amountCents)}</td>
                  <td className="hide-sm num">{d.journalNumber ? `Nr. ${d.journalNumber}` : '–'}</td>
                  <td>{d.receipt ? <a href={`/api/v1/donation-receipts/${d.receipt.id}/pdf`} target="_blank" rel="noreferrer">{d.receipt.number}</a> : canWrite ? <span style={{ display: 'inline-flex', gap: 'var(--s-1)' }}><button className="btn btn-ghost" aria-label={`Spende von ${d.donorName} vom ${formatDate(d.date)} bestätigen`} onClick={() => void single(d)}>Bestätigen</button><button className="btn btn-ghost" aria-label={`Spende von ${d.donorName} vom ${formatDate(d.date)} ungültig machen`} onClick={() => setVoiding(d)}>Ungültig …</button></span> : <span className="muted">offen</span>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {creating && <CreateDonation onClose={() => setCreating(false)} />}
      {voiding && (
        <Sheet title="Spende ungültig machen" open onClose={() => setVoiding(null)}>
          <form className="form" noValidate onSubmit={(e) => { e.preventDefault(); void voidDonation(); }}>
            <p>{voiding.donorName}, {formatDate(voiding.date)}, {euro(voiding.amountCents)}. Die Spende bleibt zur Nachvollziehbarkeit gespeichert, erscheint aber nicht mehr in Listen und Bestätigungen.{voiding.journalNumber ? ` Buchung Nr. ${voiding.journalNumber} wird storniert.` : ''}</p>
            <div className="field"><label htmlFor="void-reason">Grund</label><textarea id="void-reason" className="textarea" value={voidReason} onChange={(e) => setVoidReason(e.target.value)} /></div>
            <div className="actions-row"><button className="btn btn-danger" disabled={voidReason.trim().length < 5}>Ungültig machen</button><button type="button" className="btn btn-ghost" onClick={() => setVoiding(null)}>Abbrechen</button></div>
          </form>
        </Sheet>
      )}
    </DonationsLayout>
  );
}

function CreateDonation({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const accounts = useQuery({ queryKey: ['ledger-accounts'], queryFn: () => api<Account[]>('/ledger/accounts') });
  const [member, setMember] = useState<Donor | null>(null);
  const [newDonor, setNewDonor] = useState(false);
  const [term, setTerm] = useState('');
  const found = useQuery({ queryKey: ['donor-pick', term], queryFn: () => api<Donor[]>(`/donations/donors?q=${encodeURIComponent(term)}`), enabled: term.trim().length >= 2 && !member });
  const [waiver, setWaiver] = useState(false);
  const [error, setError] = useState<ApiError>();
  const usable = accounts.data?.filter((a) => !a.retired && !a.hidden) ?? [];
  const fieldError = (f: string) => error?.problem.errors?.find((x) => x.field === f || x.field.startsWith(`${f}.`))?.message;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => (f.get(k) as string | null)?.trim() || null;
    setError(undefined);
    try {
      await api('/donations', {
        method: 'POST',
        body: {
          ...(member ? { personId: member.personId } : { donor: { kind: s('kind') ?? 'natural', firstName: s('firstName'), lastName: s('lastName'), companyName: s('companyName'), street: s('street'), postalCode: s('postalCode'), city: s('city'), email: s('email') } }),
          date: f.get('date'),
          amountCents: Number(f.get('amount')),
          waiver,
          note: s('note'),
          moneyAccountId: waiver ? null : s('moneyAccountId'),
          incomeAccountId: waiver ? null : s('incomeAccountId'),
        },
      });
      await qc.invalidateQueries({ queryKey: ['donations'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <Sheet title="Spende erfassen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
        {member ? (
          <div className="field"><span className="label">Spender:in</span><div className="inline-edit">{member.name} <span className="muted">{member.membershipNumber ? `Nr. ${member.membershipNumber}` : member.city}</span><button type="button" className="btn btn-ghost" onClick={() => setMember(null)}>ändern</button></div></div>
        ) : newDonor ? (
          <fieldset style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--s-3)' }}>
            <legend className="label" style={{ marginBottom: 'var(--s-1)' }}>Neue Spender:in</legend>
            <p className="muted" style={{ margin: 0 }}>Name und Anschrift stehen auf der Bestätigung. <button type="button" className="link-btn" onClick={() => setNewDonor(false)}>Doch suchen</button></p>
            <div className="field"><label htmlFor="kind">Art</label><select id="kind" name="kind" className="select"><option value="natural">Person</option><option value="organisation">Firma oder Organisation</option></select></div>
            <div className="form-row"><Field label="Vorname" name="firstName" autoComplete="off" /><Field label="Nachname" name="lastName" autoComplete="off" /></div>
            <Field label="Firma oder Organisation" name="companyName" hint="Nur bei Firmen und Organisationen." />
            <Field label="Straße und Hausnummer" name="street" error={fieldError('donor.street')} />
            <div className="form-row"><Field label="PLZ" name="postalCode" inputMode="numeric" error={fieldError('donor.postalCode')} /><Field label="Ort" name="city" error={fieldError('donor.city')} /></div>
            <Field label="E-Mail (optional)" name="email" type="email" />
          </fieldset>
        ) : (
          <div className="field">
            <label htmlFor="pick">Spender:in suchen (Mitglieder und frühere Spender:innen)</label>
            <input id="pick" className="input" autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name oder Nummer" />
            <ul className="timeline">{found.data?.map((m) => <li key={m.personId} style={{ gridTemplateColumns: '1fr auto' }}><span>{m.name} <span className="meta">{m.membershipNumber ? `Nr. ${m.membershipNumber}` : m.city}</span></span><button type="button" className="btn btn-ghost" aria-label={`${m.name} wählen`} onClick={() => setMember(m)}>wählen</button></li>)}</ul>
            <button type="button" className="btn btn-ghost" style={{ justifySelf: 'start' }} onClick={() => setNewDonor(true)}>Neu: Name und Anschrift eingeben</button>
          </div>
        )}
        <div className="form-row">
          <Field label="Datum der Zuwendung" name="date" type="date" defaultValue={todayLocal()} max={todayLocal()} error={fieldError('date')} />
          <MoneyField label="Betrag" name="amount" error={fieldError('amountCents')} />
        </div>
        <label className="check"><input type="checkbox" checked={waiver} onChange={(e) => setWaiver(e.target.checked)} /> Verzicht auf Erstattung von Aufwendungen (Aufwandsspende, es fließt kein Geld)</label>
        {!waiver && (
          <div className="form-row">
            <div className="field">
              <label htmlFor="moneyAccountId">Eingegangen auf</label>
              <select id="moneyAccountId" name="moneyAccountId" className="select" style={{ width: '100%' }} defaultValue="" key={usable.length} aria-describedby="money-hint">
                <option value="">Nicht buchen</option>
                {usable.filter((a) => a.kind === 'money').map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
              </select>
              <span className="hint" id="money-hint">„Nicht buchen“, wenn die Spende schon über den Kontoabgleich gebucht ist.</span>
            </div>
            <div className="field">
              <label htmlFor="incomeAccountId">Einnahmenkonto</label>
              <select id="incomeAccountId" name="incomeAccountId" className="select" style={{ width: '100%' }} defaultValue={usable.find((a) => a.number === '4100')?.id ?? ''} key={usable.length}>
                {usable.filter((a) => a.kind === 'income').map((a) => <option key={a.id} value={a.id}>{a.number} {a.name}</option>)}
              </select>
            </div>
          </div>
        )}
        <div className="field"><label htmlFor="note">Notiz (optional)</label><textarea id="note" name="note" className="textarea" /></div>
        <div className="actions-row"><button className="btn btn-primary">Erfassen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

export function DonationReceipts({ me }: { me: Me }) {
  useTitle('Zuwendungsbestätigungen');
  const qc = useQueryClient();
  const { year, picker } = useYear();
  const list = useQuery({ queryKey: ['receipts', year], queryFn: () => api<Receipt[]>(`/donation-receipts?year=${year}`) });
  const [cancelling, setCancelling] = useState<Receipt | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<ApiError>();

  async function cancel(e: FormEvent) {
    e.preventDefault();
    if (!cancelling) return;
    setError(undefined);
    try {
      await api(`/donation-receipts/${cancelling.id}/cancel`, { method: 'POST', body: { reason } });
      await qc.invalidateQueries({ queryKey: ['receipts'] });
      await qc.invalidateQueries({ queryKey: ['donations'] });
      setCancelling(null);
      setReason('');
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <DonationsLayout me={me}>
      <div className="toolbar">{picker}<span className="muted">Ausgestellt in {year} oder {year + 1}</span></div>
      <div className="table-wrap">
        {list.data?.length === 0 ? (
          <p className="empty">Noch keine Bestätigungen.</p>
        ) : (
          <table className="table" aria-label="Zuwendungsbestätigungen">
            <thead><tr><th scope="col">Nummer</th><th scope="col">Spender:in</th><th scope="col" className="hide-sm">Art</th><th scope="col" className="hide-sm">Ausgestellt</th><th scope="col" className="num">Betrag</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
            <tbody>
              {list.data?.map((r) => (
                <tr key={r.id}>
                  <td><a href={`/api/v1/donation-receipts/${r.id}/pdf`} target="_blank" rel="noreferrer">{r.number}</a>{r.status === 'cancelled' && <span className="pill" style={{ marginLeft: 8 }}>storniert</span>}</td>
                  <td>{r.donorName}{r.cancelReason && <div className="meta">{r.cancelReason}</div>}</td>
                  <td className="hide-sm">{r.kind === 'collective' ? `Sammelbestätigung (${r.donationCount})` : 'Einzelbestätigung'}</td>
                  <td className="hide-sm num">{formatDate(r.issuedOn)}</td>
                  <td className="num">{euro(r.totalCents)}</td>
                  <td>{me.permissions.donations === 'write' && r.status === 'issued' && <button className="btn btn-ghost" onClick={() => setCancelling(r)}>Stornieren …</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {cancelling && (
        <Sheet title={`Bestätigung ${cancelling.number} stornieren`} open onClose={() => setCancelling(null)}>
          <form className="form" noValidate onSubmit={(e) => void cancel(e)}>
            {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
            <p>Die Bestätigung bleibt gespeichert und gilt als storniert. Fordere das Original von {cancelling.donorName} zurück; die Spenden lassen sich danach neu bestätigen.</p>
            <div className="field"><label htmlFor="reason">Grund</label><textarea id="reason" className="textarea" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
            <div className="actions-row"><button className="btn btn-danger" disabled={reason.trim().length < 5}>Stornieren</button><button type="button" className="btn btn-ghost" onClick={() => setCancelling(null)}>Abbrechen</button></div>
          </form>
        </Sheet>
      )}
    </DonationsLayout>
  );
}

export function DonationSettingsPage({ me }: { me: Me }) {
  useTitle('Spenden · Einstellungen');
  const qc = useQueryClient();
  const settings = useQuery({ queryKey: ['donation-settings'], queryFn: () => api<DonationSettings>('/donations/settings') });
  const [error, setError] = useState<ApiError>();
  const [saved, setSaved] = useState(false);
  const [kind, setKind] = useState<'freistellung' | 'feststellung' | ''>('');
  const s = settings.data;
  const k = kind || s?.kind || 'freistellung';

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const v = (n: string) => (f.get(n) as string | null)?.trim() || null;
    setError(undefined);
    setSaved(false);
    try {
      qc.setQueryData(['donation-settings'], await api<DonationSettings>('/donations/settings', { method: 'PUT', body: { kind: k, office: v('office'), taxNumber: v('taxNumber'), date: v('date'), period: k === 'freistellung' ? v('period') : null, purposes: v('purposes'), signer: v('signer') } }));
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <DonationsLayout me={me}>
      {s && (
        <form className="form" noValidate onSubmit={(e) => void save(e)} style={{ maxWidth: 720 }} key={JSON.stringify(s)}>
          {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
          {saved && <div className="alert alert-ok" role="status">Gespeichert.</div>}
          <p className="muted">Diese Angaben stehen auf jeder Zuwendungsbestätigung. Ein Freistellungsbescheid gilt dafür fünf Jahre, ein Feststellungsbescheid nach § 60a AO drei Jahre.</p>
          <div className="segmented" role="group" aria-label="Grundlage">
            <button type="button" aria-pressed={k === 'freistellung'} onClick={() => setKind('freistellung')}>Freistellungsbescheid</button>
            <button type="button" aria-pressed={k === 'feststellung'} onClick={() => setKind('feststellung')}>Feststellung nach § 60a AO</button>
          </div>
          <div className="form-row">
            <Field label="Finanzamt" name="office" defaultValue={s.office ?? ''} />
            <Field label="Steuernummer" name="taxNumber" defaultValue={s.taxNumber ?? ''} />
          </div>
          <div className="form-row">
            <Field label="Datum des Bescheids" name="date" type="date" defaultValue={s.date ?? ''} />
            {k === 'freistellung' && <Field label="Veranlagungszeitraum" name="period" defaultValue={s.period ?? ''} hint="z. B. 2021–2023" />}
          </div>
          <div className="field"><label htmlFor="purposes">Begünstigte Zwecke (wie im Bescheid)</label><textarea id="purposes" name="purposes" className="textarea" defaultValue={s.purposes ?? ''} placeholder="des Sports (§ 52 Abs. 2 Satz 1 Nr. 21 AO)" /></div>
          <Field label="Unterschrift: Name und Funktion" name="signer" defaultValue={s.signer ?? ''} hint="Wird gedruckt; unterschrieben wird von Hand, oder maschinell nach Anzeige beim Finanzamt." />
          {me.permissions.donations === 'write' && <div className="actions-row"><button className="btn btn-primary">Speichern</button></div>}
        </form>
      )}
    </DonationsLayout>
  );
}
