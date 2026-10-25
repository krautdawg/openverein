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

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      setMe(await api<Me>('/auth/login', { method: 'POST', body: { email: form.get('email'), password: form.get('password') } }));
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.title : 'Keine Verbindung zum Server.');
    } finally {
      setBusy(false);
    }
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
