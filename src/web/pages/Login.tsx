import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { Field } from '../components/Field.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useInstanceConfig, useSetMe } from '../lib/session.tsx';
import { useTitle } from '../lib/useTitle.ts';

export function Login() {
  useTitle('Anmelden');
  const setMe = useSetMe();
  const navigate = useNavigate();
  const { data: cfg } = useInstanceConfig();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [ticket, setTicket] = useState<string>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      if (ticket) {
        setMe(await api<Me>('/auth/login/totp', { method: 'POST', body: { ticket, code: String(form.get('code') ?? '').trim().toLowerCase() } }));
        navigate('/');
        return;
      }
      const r = await api<Me | { totpRequired: true; ticket: string }>('/auth/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } });
      if ('totpRequired' in r) {
        setTicket(r.ticket);
        return;
      }
      setMe(r);
      navigate('/');
    } catch (err) {
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
    </AuthLayout>
  );
}
