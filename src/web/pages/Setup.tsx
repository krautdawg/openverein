import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import { useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../shared/auth.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { Field } from '../components/Field.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

export function Setup() {
  useTitle('Verein einrichten');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    try {
      const me = await api<Me>('/setup', { method: 'POST', body: Object.fromEntries(f) });
      qc.setQueryData(['me'], me);
      qc.setQueryData(['setup'], { needsSetup: false });
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout>
      <h1>Verein einrichten</h1>
      <p>Lege Deinen Verein und Dein Admin-Konto an. Alles Weitere kannst Du danach in Ruhe einstellen.</p>
      <form className="form" onSubmit={submit} noValidate>
        {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.title}</div>}
        <Field label="Name des Vereins" name="clubName" placeholder="TSV Musterstadt 1890 e.V." required error={error?.fieldError('clubName')} />
        <Field label="Dein Name" name="name" autoComplete="name" required error={error?.fieldError('name')} />
        <Field label="E-Mail" name="email" type="email" autoComplete="username" required error={error?.fieldError('email')} />
        <Field label="Passwort" name="password" type="password" autoComplete="new-password" hint="Mindestens 12 Zeichen. Ein Satz aus mehreren Wörtern ist ideal." required error={error?.fieldError('password')} />
        <button className="btn btn-primary btn-block" aria-busy={busy} disabled={busy}>Verein anlegen</button>
      </form>
    </AuthLayout>
  );
}
