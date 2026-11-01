import { useEffect, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { Me } from '../../shared/auth.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { Field } from '../components/Field.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useInstanceConfig, useSetMe } from '../lib/session.tsx';
import { useTitle } from '../lib/useTitle.ts';

export function Login() {
  useTitle('Anmelden');
  const setMe = useSetMe();
  const { data: cfg } = useInstanceConfig();
  const [busy, setBusy] = useState(false);
  // Back from the club's identity provider: a ticket for the code step, or the reason it failed (in the fragment, not the URL).
  const hash = new URLSearchParams(window.location.hash.slice(1));
  const [ticket, setTicket] = useState<string | undefined>(hash.get('ticket') ?? undefined);
  const [error, setError] = useState<string | undefined>(OIDC_ERRORS[hash.get('fehler') ?? '']);
  const oidc = useQuery({ queryKey: ['oidc'], queryFn: () => api<{ enabled: boolean; label: string }>('/auth/oidc') });
  // The fragment is read once; it should not come back on reload.
  useEffect(() => {
    if (window.location.hash) history.replaceState(null, '', window.location.pathname);
  }, []);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      if (ticket) {
        // The signed-in app takes over on /anmelden and goes on from there (AfterSignIn).
        setMe(await api<Me>('/auth/login/totp', { method: 'POST', body: { ticket, code: String(form.get('code') ?? '').trim().toLowerCase() } }));
        return;
      }
      const r = await api<Me | { totpRequired: true; ticket: string }>('/auth/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } });
      if ('totpRequired' in r) {
        setTicket(r.ticket);
        return;
      }
      setMe(r);
    } catch (err) {
      // An expired ticket means: start again with the password.
      if (err instanceof ApiError && err.problem.type.endsWith('/ticket-expired')) setTicket(undefined);
      setError(err instanceof ApiError ? err.problem.title : 'Keine Verbindung zum Server.');
    } finally {
      setBusy(false);
    }
  }

  if (ticket) {
    return (
      <AuthLayout>
        <h1>Bestätigen</h1>
        <p>Gib den Code aus Deiner Authenticator-App ein. Ohne Handy geht auch einer Deiner Wiederherstellungscodes.</p>
        <form className="form" onSubmit={submit} noValidate>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <Field label="Code" name="code" inputMode="numeric" autoComplete="one-time-code" autoFocus required />
          <button className="btn btn-primary btn-block" aria-busy={busy} disabled={busy}>Anmelden</button>
          <button type="button" className="btn btn-ghost btn-block" onClick={() => { setTicket(undefined); setError(undefined); }}>Zurück</button>
        </form>
      </AuthLayout>
    );
  }

  return (
    <AuthLayout>
      <h1>Anmelden</h1>
      <p>Schön, dass Du da bist.</p>
      {cfg?.demoLogin && (
        <div className="alert alert-warn" style={{ marginBottom: 'var(--s-5)' }}>
          Demo-Zugang: <strong>{cfg.demoLogin.email}</strong> mit Passwort <strong>{cfg.demoLogin.password}</strong>. Alle Daten sind erfunden und werden regelmäßig zurückgesetzt.
        </div>
      )}
      <form className="form" onSubmit={submit} noValidate>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <Field label="E-Mail" name="email" type="email" autoComplete="username" required defaultValue={cfg?.demoLogin?.email} />
        <Field label="Passwort" name="password" type="password" autoComplete="current-password" required defaultValue={cfg?.demoLogin?.password} />
        <button className="btn btn-primary btn-block" aria-busy={busy} disabled={busy}>Anmelden</button>
      </form>
      {oidc.data?.enabled && (
        <>
          <p className="meta auth-or">oder</p>
          <a className="btn btn-block" href="/api/v1/auth/oidc/start">Mit {oidc.data.label} anmelden</a>
        </>
      )}
    </AuthLayout>
  );
}

const OIDC_ERRORS: Record<string, string> = {
  abgelaufen: 'Die Anmeldung hat zu lange gedauert. Bitte versuch es noch einmal.',
  'nicht-eingerichtet': 'Die Anmeldung über das Vereins-Konto ist nicht mehr eingerichtet.',
  anbieter: 'Der Anbieter hat die Anmeldung nicht bestätigt.',
  unbekannt: 'Zu diesem Konto gibt es hier keinen Zugang (oder die E-Mail-Adresse ist beim Anbieter nicht bestätigt). Bitte den Verein um eine Einladung.',
};
