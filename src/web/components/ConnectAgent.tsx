import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link, Navigate } from 'react-router';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';
import { AuthLayout } from './AuthLayout.tsx';

const RETURN_KEY = 'ov-return';

/** Remembers the consent page across a sign-in (also a code from the mail opened in another tab), for ten minutes. */
export function rememberReturn(path: string) {
  try {
    localStorage.setItem(RETURN_KEY, JSON.stringify({ path, at: Date.now() }));
  } catch {
    // storage blocked: the person starts the connection again after signing in
  }
}

/** Where to go right after signing in: the remembered consent page (read once), else the overview. */
export function AfterSignIn() {
  // Read on mount, cleared after: a second render reads the same target.
  const [to] = useState(() => peekReturn() ?? '/');
  useEffect(() => clearReturn(), []);
  return <Navigate to={to} replace />;
}

const clearReturn = () => {
  try {
    localStorage.removeItem(RETURN_KEY);
  } catch {
    // storage blocked: nothing to clear
  }
};

/** The remembered consent page, once; only our own consent paths. */
export function takeReturn(): string | null {
  const r = peekReturn();
  clearReturn();
  return r;
}

function peekReturn(): string | null {
  try {
    const raw = localStorage.getItem(RETURN_KEY);
    const r = raw ? (JSON.parse(raw) as { path: string; at: number }) : null;
    return r && Date.now() - r.at < 600_000 && /^\/(portal\/)?verbinden\?/.test(r.path) ? r.path : null;
  } catch {
    return null;
  }
}

interface View { clientName: string; redirectUri: string; requestedAccess: 'read' | 'write' | null; days: number[] }

/** Before anyone is signed in: who are you, member or club administration? */
export function ConnectChooser() {
  useTitle('KI-Client verbinden');
  const search = location.search;
  return (
    <AuthLayout>
      <h1>KI-Client verbinden</h1>
      <p>Ein KI-Client (zum Beispiel Claude oder ChatGPT) möchte für Dich auf OpenVerein zugreifen. Melde Dich an. Danach entscheidest Du, was er darf.</p>
      <div className="connect-choices">
        <a className="btn btn-primary btn-block" href={`/portal/verbinden${search}`} onClick={() => rememberReturn(`/portal/verbinden${search}`)}>Ich bin Mitglied</a>
        <Link className="btn btn-block" to="/anmelden" onClick={() => rememberReturn(`/verbinden${search}`)}>Ich arbeite in der Vereinsverwaltung</Link>
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
