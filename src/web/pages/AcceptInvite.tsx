import { useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { Field } from '../components/Field.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useSetMe } from '../lib/session.tsx';
import { useTitle } from '../lib/useTitle.ts';

/** The token travels in the URL fragment, so it never reaches server logs or Referer headers. */
export function AcceptInvite() {
  useTitle('Einladung annehmen');
  const setMe = useSetMe();
  const navigate = useNavigate();
  const [error, setError] = useState<ApiError>();
  const token = window.location.hash.slice(1);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      setMe(await api<Me>('/auth/accept-invite', { method: 'POST', body: { token, password: new FormData(e.currentTarget).get('password') } }));
      history.replaceState(null, '', '/');
      navigate('/');
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <AuthLayout>
      <h1>Willkommen</h1>
      <p>Du wurdest eingeladen. Leg Dein Passwort fest, dann geht es los.</p>
      <form className="form" onSubmit={submit} noValidate>
        {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.title}</div>}
        <Field label="Neues Passwort" name="password" type="password" autoComplete="new-password" required hint="Mindestens 12 Zeichen." error={error?.fieldError('password')} />
        <button className="btn btn-primary btn-block">Passwort setzen und anmelden</button>
      </form>
    </AuthLayout>
  );
}
