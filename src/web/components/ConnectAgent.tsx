import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate, useNavigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';
import { AuthLayout } from './AuthLayout.tsx';

const RETURN_KEY = 'ov-returns';
type Returns = Record<string, { path: string; at: number }>;

/** Pending consents by continuation id, young and pointing at our own consent pages only. */
function readReturns(): Returns {
  try {
    const all = JSON.parse(localStorage.getItem(RETURN_KEY) ?? '{}') as Returns;
    return Object.fromEntries(Object.entries(all).filter(([, r]) => Date.now() - r.at >= 0 && Date.now() - r.at < 600_000 && /^\/(portal\/)?verbinden\?/.test(r.path)));
  } catch {
    return {};
  }
}

function writeReturns(r: Returns) {
  try {
    localStorage.setItem(RETURN_KEY, JSON.stringify(r));
  } catch {
    // storage blocked: the person starts the connection again after signing in
  }
}

/**
 * Remembers a consent page for the sign-in that follows, under an id that travels in that sign-in's address
 * (`?weiter=`): only that sign-in goes on there, never a later or parallel one. Ten minutes.
 */
export function rememberReturn(path: string) {
  const id = (crypto.randomUUID?.() ?? `${Date.now()}${Math.random()}`).replace(/[^A-Za-z0-9]/g, '').slice(0, 32);
  writeReturns({ ...readReturns(), [id]: { path, at: Date.now() } });
  return id;
}

/** The consent page of this sign-in (its `weiter` id), once. */
export function takeReturn(id: string | null) {
  const all = readReturns();
  const path = id ? (all[id]?.path ?? null) : null;
  if (id) delete all[id];
  writeReturns(all);
  return path;
}

const continuation = () => new URLSearchParams(location.search).get('weiter');

/** Where to go right after signing in: this sign-in's consent page, else the overview. */
export function AfterSignIn() {
  // Read on mount and cleared after: a second render (StrictMode) reads the same target.
  const [id] = useState(continuation);
  const [to] = useState(() => (id && readReturns()[id]?.path) || '/');
  useEffect(() => void takeReturn(id), [id]);
  return <Navigate to={to} replace />;
}

interface View { clientName: string; redirectUri: string; requestedAccess: 'read' | 'write' | null; days: number[] }

/** Before anyone is signed in: who are you, member or club administration? */
export function ConnectChooser() {
  useTitle('KI-Client verbinden');
  const search = location.search;
  const navigate = useNavigate();
  return (
    <AuthLayout>
      <h1>KI-Client verbinden</h1>
      <p>Ein KI-Client (zum Beispiel Claude oder ChatGPT) möchte für Dich auf OpenVerein zugreifen. Melde Dich an. Danach entscheidest Du, was er darf.</p>
      <div className="connect-choices">
        <a className="btn btn-primary btn-block" href={`/portal/verbinden${search}`}>Ich bin Mitglied</a>
        <Link className="btn btn-block" to="/anmelden" onClick={(e) => { e.preventDefault(); navigate(`/anmelden?weiter=${rememberReturn(`/verbinden${search}`)}`); }}>Ich arbeite in der Vereinsverwaltung</Link>
      </div>
    </AuthLayout>
  );
}

/** The consent itself, for an admin access (`/oauth`) or a member (`/portal/oauth`). */
export function ConnectConsent({ base, who, other }: { base: '/oauth' | '/portal/oauth'; who: string; other?: { label: string; href: string } }) {
  useTitle('KI-Client verbinden');
  const query = Object.fromEntries(new URLSearchParams(location.search));
  const view = useQuery({ queryKey: ['oauth-request', location.search], queryFn: () => api<View>(`${base}/request?${new URLSearchParams(query)}`), retry: false });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(allow: boolean, e?: FormEvent<HTMLFormElement>) {
    e?.preventDefault();
    const f = e ? new FormData(e.currentTarget) : null;
    setBusy(true);
    setError(undefined);
    try {
      const r = await api<{ redirect: string }>(`${base}/consent`, { method: 'POST', body: { query, allow, access: f?.get('access') ?? 'read', days: Number(f?.get('days') ?? 30) } });
      window.location.assign(r.redirect);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : 'Keine Verbindung zum Server.');
      setBusy(false);
    }
  }

  if (view.isPending) return null;
  if (view.isError) {
    return (
      <AuthLayout>
        <h1>Verbindung nicht möglich</h1>
        <p>{view.error instanceof ApiError ? view.error.problem.detail ?? view.error.problem.title : 'Keine Verbindung zum Server.'} Starte die Verbindung bitte noch einmal in Deinem KI-Client.</p>
      </AuthLayout>
    );
  }
  const v = view.data;
  const writeOk = v.requestedAccess !== 'read';
  return (
    <AuthLayout>
      <h1>{v.clientName} verbinden?</h1>
      <p className="meta">Der Name stammt vom Client selbst und ist nicht geprüft. Nach Deiner Entscheidung geht es zurück zu <strong className="connect-uri">{new URL(v.redirectUri).host}</strong> (<span className="connect-uri">{v.redirectUri}</span>).</p>
      <p>Der Client handelt dann als <strong>{who}</strong> und sieht nur, was Du siehst. Widerrufen kannst Du ihn jederzeit unter Agenten.</p>
      <form className="form" onSubmit={(e) => void decide(true, e)}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <fieldset className="agents-access">
          <legend>Was darf er?</legend>
          <label className="radio-row"><input type="radio" name="access" value="read" defaultChecked /><span><strong>Nur lesen</strong></span></label>
          {writeOk && <label className="radio-row"><input type="radio" name="access" value="write" /><span><strong>Lesen und ändern</strong><span className="meta"> was Du ändern darfst</span></span></label>}
        </fieldset>
        <div className="field">
          <label htmlFor="connect-days">Gültig für</label>
          <select id="connect-days" name="days" className="select" defaultValue="30">{v.days.map((d) => <option key={d} value={d}>{d} Tage</option>)}</select>
        </div>
        <button className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>Erlauben</button>
        <button type="button" className="btn btn-ghost btn-block" disabled={busy} onClick={() => void decide(false)}>Ablehnen</button>
        {other && <p className="meta" style={{ textAlign: 'center' }}><a href={other.href}>{other.label}</a></p>}
      </form>
    </AuthLayout>
  );
}
