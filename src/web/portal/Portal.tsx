import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Navigate, NavLink, Route, Routes, useNavigate, useParams } from 'react-router';
import { FileText, Home, LogOut, Receipt } from 'lucide-react';
import { formatDate } from '../../shared/dates.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { Field } from '../components/Field.tsx';
import { GroupBadge } from '../components/GroupBadge.tsx';
import { api, ApiError } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useTitle } from '../lib/useTitle.ts';

interface PortalMember {
  memberId: string;
  name: string;
  firstName: string | null;
  lastName: string | null;
  number: string;
  status: 'active' | 'future' | 'resigned';
  joinDate: string | null;
  exitDate: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  postalCode: string | null;
  city: string | null;
  groups: { name: string; color: string }[];
  mandate: { reference: string; ibanLast4: string; signedOn: string; status: string } | null;
  pending: { field: string; value: string; requestedAt: string }[];
  resignationProposal: string | null;
}
interface PortalMe { email: string; club: { name: string; email: string | null }; members: PortalMember[] }
interface PortalInvoice { id: string; number: string; kind: string; status: string; issueDate: string; dueDate: string | null; totalCents: number; openCents: number; directDebit: boolean }

const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const STATUS = { active: 'Mitglied', future: 'Mitglied ab', resigned: 'Gekündigt zum' } as const;

export function PortalApp() {
  const me = useQuery({ queryKey: ['portal-me'], queryFn: () => api<PortalMe>('/portal/me').catch((err) => (err instanceof ApiError && err.problem.status === 401 ? null : Promise.reject(err))), retry: false });
  useOfflineServiceWorker();
  if (me.isPending) return null;
  if (!me.data) {
    return (
      <Routes>
        <Route path="/portal/anmelden" element={<PortalLogin />} />
        <Route path="*" element={<Navigate to="/portal/anmelden" replace />} />
      </Routes>
    );
  }
  return (
    <PortalShell me={me.data}>
      <Routes>
        <Route path="/portal" element={<PortalHome me={me.data} />} />
        <Route path="/portal/daten/:id" element={<PortalData me={me.data} />} />
        <Route path="/portal/rechnungen" element={<PortalInvoices />} />
        <Route path="/portal/dokumente" element={<PortalDocuments />} />
        <Route path="*" element={<Navigate to="/portal" replace />} />
      </Routes>
    </PortalShell>
  );
}

/** Registers the tiny service worker that serves an offline page; the portal never writes offline. */
function useOfflineServiceWorker() {
  useEffect(() => {
    // Only the portal is installable; the admin app stays a normal web page.
    if (!document.querySelector('link[rel="manifest"]')) document.head.append(Object.assign(document.createElement('link'), { rel: 'manifest', href: '/portal.webmanifest' }));
    if ('serviceWorker' in navigator && location.protocol === 'https:') void navigator.serviceWorker.register('/portal-sw.js', { scope: '/portal' }).catch(() => undefined);
  }, []);
}

function useOnline() {
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    addEventListener('online', on);
    addEventListener('offline', off);
    return () => { removeEventListener('online', on); removeEventListener('offline', off); };
  }, []);
  return online;
}

function PortalShell({ me, children }: { me: PortalMe; children: ReactNode }) {
  const qc = useQueryClient();
  const online = useOnline();
  async function logout() {
    await api('/portal/auth/logout', { method: 'POST' });
    qc.setQueryData(['portal-me'], null);
  }
  return (
    <div className="portal">
      <header className="portal-top">
        <span className="portal-club">{me.club.name}</span>
        <button className="portal-logout" onClick={() => void logout()}><LogOut size={16} aria-hidden /> <span>Abmelden</span></button>
      </header>
      {!online && <div className="portal-offline" role="status">Keine Verbindung. Änderungen und neue Daten gibt es erst wieder, wenn Du online bist.</div>}
      <main className="portal-main" id="main">{children}</main>
      <nav className="portal-tabs" aria-label="Mitgliederportal">
        <NavLink to="/portal" end><Home size={20} aria-hidden /><span>Übersicht</span></NavLink>
        <NavLink to="/portal/rechnungen"><Receipt size={20} aria-hidden /><span>Rechnungen</span></NavLink>
        <NavLink to="/portal/dokumente"><FileText size={20} aria-hidden /><span>Dokumente</span></NavLink>
      </nav>
    </div>
  );
}

function PortalLogin() {
  useTitle('Mitgliederportal');
  const qc = useQueryClient();
  // The link in the mail only fills in the form; signing in always needs a click, so mail scanners cannot use the code.
  const fromLink = new URLSearchParams(location.hash.slice(1));
  const [email, setEmail] = useState(fromLink.get('email') ?? '');
  const [step, setStep] = useState<'email' | 'code'>(fromLink.get('code') ? 'code' : 'email');
  const [code, setCode] = useState(fromLink.get('code') ?? '');
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);

  async function requestCode(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await api('/portal/auth/request-code', { method: 'POST', body: { email } });
      setStep('code');
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    setBusy(true);
    try {
      await api('/portal/auth/verify', { method: 'POST', body: { email, code } });
      history.replaceState(null, '', '/portal');
      await qc.invalidateQueries({ queryKey: ['portal-me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <h1>Mitgliederportal</h1>
      {step === 'email' ? (
        <>
          <p>Gib die E-Mail-Adresse ein, die der Verein von Dir hat. Wir schicken Dir einen Code.</p>
          <form className="form" onSubmit={requestCode} noValidate>
            {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.title} {error.problem.detail}</div>}
            <Field label="E-Mail" name="email" type="email" autoComplete="email" value={email} onChange={(e) => setEmail(e.target.value)} error={error?.fieldError('email')} required />
            <button className="btn btn-primary btn-block" aria-busy={busy} disabled={busy}>Code schicken</button>
          </form>
        </>
      ) : (
        <>
          <p>Wenn {email} beim Verein hinterlegt ist, ist jetzt ein sechsstelliger Code unterwegs. Er gilt 10 Minuten.</p>
          <form className="form" onSubmit={verify} noValidate>
            {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.title} {error.problem.detail}</div>}
            <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} error={error?.fieldError('code')} required />
            <button className="btn btn-primary btn-block" aria-busy={busy} disabled={busy || code.length !== 6}>Anmelden</button>
            <button type="button" className="btn btn-ghost btn-block" onClick={() => { setStep('email'); setCode(''); setError(undefined); }}>Andere Adresse oder neuer Code</button>
          </form>
        </>
      )}
    </AuthLayout>
  );
}

function PortalHome({ me }: { me: PortalMe }) {
  useTitle('Mitgliederportal');
  const invoices = useQuery({ queryKey: ['portal-invoices'], queryFn: () => api<PortalInvoice[]>('/portal/invoices') });
  const open = invoices.data?.filter((i) => i.openCents > 0) ?? [];
  return (
    <>
      <h1 className="portal-h1">{me.members.length === 1 && me.members[0]!.firstName ? `Hallo ${me.members[0]!.firstName}` : 'Hallo'}</h1>
      {me.members.length > 1 && <p className="muted" style={{ marginTop: 'calc(-1 * var(--s-2))', marginBottom: 'var(--s-4)' }}>Unter {me.email} sind {me.members.length} Mitgliedschaften hinterlegt.</p>}
      {me.members.length === 0 && <p className="muted">Unter {me.email} ist gerade keine Mitgliedschaft hinterlegt.</p>}
      {open.length > 0 && (
        <NavLink to="/portal/rechnungen" className="portal-due">
          <span>{open.length === 1 ? 'Eine Rechnung ist offen' : `${open.length} Rechnungen sind offen`}</span>
          <strong className="num">{euro(open.reduce((s, i) => s + i.openCents, 0))}</strong>
        </NavLink>
      )}
      {me.members.map((m) => <MembershipCard key={m.memberId} m={m} several={me.members.length > 1} />)}
      {me.club.email && <p className="meta portal-contact">Fragen? Schreib an <a href={`mailto:${me.club.email}`}>{me.club.email}</a>.</p>}
    </>
  );
}

function MembershipCard({ m, several }: { m: PortalMember; several: boolean }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [confirm, setConfirm] = useState(false);
  const [error, setError] = useState<string>();
  const pendingResignation = m.pending.find((p) => p.field === 'resignation');
  async function resign() {
    try {
      await api('/portal/resignation', { method: 'POST', body: { memberId: m.memberId } });
      setConfirm(false);
      await qc.invalidateQueries({ queryKey: ['portal-me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.title : 'Das hat nicht geklappt.');
    }
  }
  return (
    <section className="portal-card" aria-labelledby={`m-${m.memberId}`}>
      <div className="portal-card-head">
        <h2 id={`m-${m.memberId}`}>{several ? m.name : 'Deine Mitgliedschaft'}</h2>
        <span className="meta num">Nr. {m.number}</span>
      </div>
      <p className="portal-status">
        {m.status === 'active' ? `Mitglied seit ${formatDate(m.joinDate)}` : `${STATUS[m.status]} ${formatDate(m.status === 'future' ? m.joinDate : m.exitDate)}`}
      </p>
      {m.groups.length > 0 && <div className="portal-groups">{m.groups.map((g) => <GroupBadge key={g.name} {...g} />)}</div>}
      <dl className="facts portal-facts">
        <dt>Lastschrift</dt>
        <dd>{m.mandate ? <>Konto •••• {m.mandate.ibanLast4}<div className="meta">Mandat {m.mandate.reference} vom {formatDate(m.mandate.signedOn)}{m.mandate.status === 'pending_evidence' && ', wartet auf Unterschrift'}</div></> : <span className="muted">kein Mandat, Du überweist selbst</span>}</dd>
        <dt>Adresse</dt>
        <dd>{m.street ? <>{m.street}<br />{m.postalCode} {m.city}</> : <span className="muted">keine</span>}</dd>
      </dl>
      {m.pending.filter((p) => p.field !== 'resignation').length > 0 && <p className="meta">Änderungen warten auf den Verein: {m.pending.filter((p) => p.field !== 'resignation').map((p) => FIELD_LABEL[p.field] ?? p.field).join(', ')}.</p>}
      <div className="actions-row">
        <button className="btn" onClick={() => navigate(`/portal/daten/${m.memberId}`)}>Daten ändern</button>
        {m.status !== 'resigned' && !pendingResignation && !confirm && <button className="btn btn-ghost" onClick={() => setConfirm(true)}>Kündigen …</button>}
      </div>
      {pendingResignation && <p className="meta">Deine Kündigung zum {formatDate(pendingResignation.value)} ist eingegangen; der Vorstand bestätigt sie.</p>}
      {confirm && m.resignationProposal && (
        <div className="inline-form" role="group" aria-label="Kündigen">
          <p>Nach der Satzung endet die Mitgliedschaft frühestens am <strong>{formatDate(m.resignationProposal)}</strong>. Der Vorstand bestätigt die Kündigung.</p>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-danger" onClick={() => void resign()}>Verbindlich kündigen</button>
            <button className="btn btn-ghost" onClick={() => setConfirm(false)}>Abbrechen</button>
          </div>
        </div>
      )}
    </section>
  );
}

const FIELD_LABEL: Record<string, string> = { first_name: 'Vorname', last_name: 'Nachname', email: 'E-Mail-Adresse', phone: 'Telefon', address: 'Anschrift', iban: 'Bankverbindung' };

function PortalData({ me }: { me: PortalMe }) {
  useTitle('Daten ändern');
  const { id } = useParams();
  const m = me.members.find((x) => x.memberId === id);
  if (!m) return <Navigate to="/portal" replace />;
  const fields: [string, string | null][] = [['first_name', m.firstName], ['last_name', m.lastName], ['email', m.email], ['phone', m.phone], ['address', m.street ? `${m.street}, ${m.postalCode ?? ''} ${m.city ?? ''}` : null], ['iban', m.mandate ? `•••• ${m.mandate.ibanLast4}` : null]];
  return (
    <>
      <h1 className="portal-h1">Daten ändern</h1>
      <p className="muted" style={{ marginBottom: 'var(--s-5)' }}>Die Telefonnummer gilt sofort. Alles andere prüft der Verein und meldet sich per E-Mail.</p>
      <ul className="portal-fields">
        {fields.filter(([f]) => f !== 'iban' || m.mandate).map(([field, value]) => <FieldRow key={field} member={m} field={field} value={value} pending={m.pending.find((p) => p.field === field)?.value} />)}
      </ul>
    </>
  );
}

function FieldRow({ member, field, value, pending }: { member: PortalMember; field: string; value: string | null; pending?: string }) {
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ApiError>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    setError(undefined);
    try {
      await api('/portal/change-requests', { method: 'POST', body: { memberId: member.memberId, field, ...(field === 'address' || field === 'iban' ? f : { value: f.value }) } });
      setEditing(false);
      await qc.invalidateQueries({ queryKey: ['portal-me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  const general = error && !error.problem.errors ? error.problem.title : undefined;
  return (
    <li>
      {editing ? (
        <form onSubmit={submit} noValidate className="portal-edit">
          {general && <div className="alert alert-error" role="alert">{general}</div>}
          {field === 'address' ? (
            <>
              <Field label="Straße und Hausnummer" name="street" defaultValue={member.street ?? ''} autoComplete="street-address" error={error?.fieldError('street')} autoFocus />
              <div className="form-row">
                <Field label="Postleitzahl" name="postalCode" defaultValue={member.postalCode ?? ''} autoComplete="postal-code" inputMode="numeric" error={error?.fieldError('postalCode')} />
                <Field label="Ort" name="city" defaultValue={member.city ?? ''} autoComplete="address-level2" error={error?.fieldError('city')} />
              </div>
            </>
          ) : field === 'iban' ? (
            <>
              <Field label="Neue IBAN" name="iban" placeholder="DE.." autoComplete="off" error={error?.fieldError('iban')} autoFocus />
              <Field label="Kontoinhaber:in" name="accountHolder" defaultValue={member.name} hint="Gehört das Konto jemand anderem, braucht der Verein ein neues unterschriebenes Mandat." error={error?.fieldError('accountHolder')} />
            </>
          ) : (
            <Field label={FIELD_LABEL[field]!} name="value" defaultValue={value ?? ''} autoFocus error={error?.fieldError('value')} inputMode={field === 'phone' ? 'tel' : field === 'email' ? 'email' : undefined} />
          )}
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary">{field === 'phone' ? 'Speichern' : 'Zur Prüfung senden'}</button>
            <button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Abbrechen</button>
          </div>
        </form>
      ) : (
        <button className="portal-field" onClick={() => setEditing(true)}>
          <span className="label">{FIELD_LABEL[field]}</span>
          <span>{value ?? <span className="muted">fehlt</span>}</span>
          {pending && <span className="meta">wartet: {pending}</span>}
          <span className="portal-field-action" aria-hidden>Ändern</span>
        </button>
      )}
    </li>
  );
}

function PortalInvoices() {
  useTitle('Rechnungen');
  const { data } = useQuery({ queryKey: ['portal-invoices'], queryFn: () => api<PortalInvoice[]>('/portal/invoices') });
  const [qr, setQr] = useState<string | null>(null);
  return (
    <>
      <h1 className="portal-h1">Rechnungen</h1>
      {data?.length === 0 && <p className="muted">Noch keine Rechnungen.</p>}
      <ul className="portal-list">
        {data?.map((i) => (
          <li key={i.id}>
            <div className="portal-row">
              <span><span className="name">{i.number}</span><div className="meta">{formatDate(i.issueDate)}{i.kind === 'cancellation' && ' · Storno'}</div></span>
              <span className="num">{euro(i.totalCents)}<div className="meta">{i.openCents > 0 ? (i.directDebit ? 'wird abgebucht' : `offen: ${euro(i.openCents)}`) : i.status === 'cancelled' ? 'storniert' : 'erledigt'}</div></span>
            </div>
            <div className="actions-row" style={{ marginTop: 'var(--s-2)' }}>
              <a className="btn btn-ghost" href={`/api/v1/portal/invoices/${i.id}/pdf`} target="_blank" rel="noreferrer">PDF</a>
              {i.openCents > 0 && !i.directDebit && <button className="btn btn-ghost" aria-expanded={qr === i.id} onClick={() => setQr(qr === i.id ? null : i.id)}>Mit Banking-App bezahlen</button>}
            </div>
            {qr === i.id && (
              <figure className="portal-qr">
                <img src={`/api/v1/portal/invoices/${i.id}/qr.svg`} alt={`GiroCode für ${i.number} über ${euro(i.openCents)}`} width={200} height={200} />
                <figcaption className="meta">In der Banking-App „Foto-Überweisung“ oder „QR-Code“ wählen und scannen.</figcaption>
              </figure>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

function PortalDocuments() {
  useTitle('Dokumente');
  const { data } = useQuery({ queryKey: ['portal-docs'], queryFn: () => api<{ id: string; name: string; folder: string; sizeBytes: number }[]>('/portal/documents') });
  const folders = [...new Set(data?.map((d) => d.folder))];
  // Ids from the position, not the name: names may contain spaces.
  return (
    <>
      <h1 className="portal-h1">Dokumente</h1>
      {data?.length === 0 && <p className="muted">Der Verein hat noch keine Dokumente für Mitglieder freigegeben.</p>}
      {folders.map((f, i) => (
        <section key={f} className="portal-docs" aria-labelledby={`docs-${i}`}>
          <h2 id={`docs-${i}`}>{f}</h2>
          <ul className="portal-list">
            {data!.filter((d) => d.folder === f).map((d) => (
              <li key={d.id} className="portal-row">
                <a href={`/api/v1/portal/documents/${d.id}`} target="_blank" rel="noreferrer">{d.name}</a>
                <span className="meta num">{bytes(d.sizeBytes)}</span>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </>
  );
}
