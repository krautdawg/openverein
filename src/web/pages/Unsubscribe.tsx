import { useState } from 'react';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

/** Public page behind the link in newsletters. Asks once before acting, so link scanners cannot unsubscribe anyone. */
export function Unsubscribe() {
  useTitle('Rundschreiben abbestellen');
  const [state, setState] = useState<'ask' | 'done' | 'busy'>('ask');
  const [error, setError] = useState<string>();
  const token = window.location.hash.slice(1);

  async function confirm() {
    setState('busy');
    try {
      await api('/unsubscribe', { method: 'POST', body: { token } });
      setState('done');
    } catch (err) {
      setError(err instanceof ApiError ? err.problem.title : 'Das hat nicht geklappt.');
      setState('ask');
    }
  }

  return (
    <AuthLayout>
      {state === 'done' ? (
        <>
          <h1>Abbestellt</h1>
          <p>Du bekommst keine Rundschreiben mehr. Wichtige Vereinspost wie Rechnungen oder Einladungen zur Mitgliederversammlung erreicht Dich weiterhin.</p>
        </>
      ) : (
        <>
          <h1>Rundschreiben abbestellen?</h1>
          <p>Rechnungen und Einladungen zur Mitgliederversammlung bekommst Du weiterhin.</p>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <button className="btn btn-primary btn-block" aria-busy={state === 'busy'} disabled={state === 'busy' || !token} onClick={() => void confirm()}>Ja, abbestellen</button>
        </>
      )}
    </AuthLayout>
  );
}
