import { useState } from 'react';
import { api, ApiError } from '../lib/api.ts';

/** For members whose mail does not arrive: a code shown once, valid for 24 hours. */
export function PortalCode({ memberId }: { memberId: string }) {
  const [code, setCode] = useState<{ code: string; email: string }>();
  const [error, setError] = useState<string>();
  async function issue() {
    setError(undefined);
    try {
      setCode(await api<{ code: string; email: string }>(`/members/${memberId}/portal-code`, { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  }
  if (code) {
    return (
      <div className="alert alert-ok" role="status" style={{ marginTop: 'var(--s-3)' }}>
        Portal-Code für {code.email}: <strong className="token-once" style={{ display: 'inline', padding: '0 4px' }}>{code.code}</strong>
        <div className="meta">Einmal sichtbar, 24 Stunden gültig. Anmelden unter {location.origin}/portal mit dieser Adresse und dem Code.</div>
      </div>
    );
  }
  return (
    <>
      <button className="btn btn-ghost" onClick={() => void issue()}>Portal-Code ausgeben</button>
      {error && <span role="alert" className="meta" style={{ color: 'var(--danger)' }}>{error}</span>}
    </>
  );
}
