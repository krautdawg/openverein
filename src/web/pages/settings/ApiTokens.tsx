import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Role } from '../../../shared/access.ts';
import type { Me } from '../../../shared/auth.ts';
import { formatDate } from '../../../shared/dates.ts';
import { Field } from '../../components/Field.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface Token { id: string; name: string; prefix: string; roleName: string; expiresAt: string; lastUsedAt: string | null; revoked: boolean }

export function ApiTokens({ me }: { me: Me }) {
  useTitle('API-Schlüssel');
  const qc = useQueryClient();
  const canWrite = me.permissions.api === 'write' && me.permissions.settings === 'write';
  const tokens = useQuery({ queryKey: ['api-tokens'], queryFn: () => api<Token[]>('/api-tokens') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/roles') });
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<ApiError>();

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const r = await api<{ token: string }>('/api-tokens', { method: 'POST', body: { name: f.get('name'), roleId: f.get('roleId'), expiresInDays: Number(f.get('days')) } });
      setSecret(r.token);
      e.currentTarget?.reset();
      await qc.invalidateQueries({ queryKey: ['api-tokens'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  async function revoke(id: string) {
    await api(`/api-tokens/${id}/revoke`, { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['api-tokens'] });
  }

  return (
    <>
      <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h2>API-Schlüssel</h2>
          <p>Für Website, Skripte und andere Werkzeuge. Jeder Schlüssel handelt mit genau einer Rolle. Die Beschreibung aller Schnittstellen findest Du unter <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>.</p>
        </div>
      </div>
      {secret && (
        <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-4)' }}>
          <p style={{ marginBottom: 'var(--s-2)' }}>Dein neuer Schlüssel. Er wird nur dieses eine Mal angezeigt.</p>
          <div className="token-once">{secret}</div>
          <button className="btn" style={{ marginTop: 'var(--s-2)' }} onClick={() => void navigator.clipboard?.writeText(secret)}>Kopieren</button>
        </div>
      )}
      {canWrite && roles.data && (
        <form className="inline-form" style={{ marginBottom: 'var(--s-5)', marginTop: 0 }} onSubmit={create} noValidate aria-label="Neuer API-Schlüssel">
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <div className="form-row">
            <Field label="Wofür?" name="name" placeholder="Vereinswebsite" required error={error?.fieldError('name')} />
            <div className="field">
              <label htmlFor="token-role">Rolle</label>
              <select id="token-role" name="roleId" className="select" style={{ width: '100%' }}>{roles.data.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}</select>
            </div>
          </div>
          <div className="field" style={{ maxWidth: 240 }}>
            <label htmlFor="token-days">Gültig für</label>
            <select id="token-days" name="days" className="select" defaultValue="365"><option value="30">30 Tage</option><option value="90">90 Tage</option><option value="365">1 Jahr</option></select>
          </div>
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Schlüssel erstellen</button></div>
        </form>
      )}
      <div className="table-wrap">
        {tokens.data?.length === 0 ? (
          <div className="empty-state"><h3>Noch keine API-Schlüssel.</h3><p>Die Oberfläche nutzt dieselbe API. Alles, was Du hier klickst, geht also auch per Skript.</p></div>
        ) : (
          <table className="table" aria-label="API-Schlüssel">
            <thead><tr><th scope="col">Name</th><th scope="col" className="hide-sm">Kennung</th><th scope="col">Rolle</th><th scope="col" className="hide-sm">Gültig bis</th><th scope="col" className="hide-sm">Zuletzt genutzt</th><th scope="col" /></tr></thead>
            <tbody>
              {tokens.data?.map((t) => (
                <tr key={t.id}>
                  <td className="name">{t.name}</td>
                  <td className="hide-sm num">ov_{t.prefix}_…</td>
                  <td>{t.roleName}</td>
                  <td className="hide-sm num">{formatDate(t.expiresAt.slice(0, 10))}</td>
                  <td className="hide-sm num">{t.lastUsedAt ? new Date(t.lastUsedAt).toLocaleDateString('de-DE') : '—'}</td>
                  <td className="r">{t.revoked ? <span className="pill">widerrufen</span> : canWrite && <button className="btn btn-ghost btn-danger" onClick={() => void revoke(t.id)}>Widerrufen</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
