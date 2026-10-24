import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FIELD_LABEL, LEVEL_LABEL, MODULE_LABEL, type Role } from '../../../shared/access.ts';
import type { Me } from '../../../shared/auth.ts';
import { Sheet } from '../../components/Sheet.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

export function Roles({ me }: { me: Me }) {
  useTitle('Rollen');
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/roles') });
  const [open, setOpen] = useState<string | null>(null);
  const [error, setError] = useState<string>();
  const current = roles.data?.find((r) => r.id === open) ?? null;

  async function copy(r: Role) {
    setError(undefined);
    try {
      const created = await api<Role>('/roles', { method: 'POST', body: { name: `${r.name} (Kopie)`, permissions: r.permissions, restrictedFields: r.restrictedFields } });
      await qc.invalidateQueries({ queryKey: ['roles'] });
      setOpen(created.id);
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    }
  }

  async function patch(body: Partial<Role>) {
    setError(undefined);
    try {
      await api(`/roles/${current!.id}`, { method: 'PATCH', body });
      await qc.invalidateQueries({ queryKey: ['roles'] });
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    }
  }

  return (
    <>
      <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div><h2>Rollen</h2><p>Eingebaute Rollen bleiben unverändert. Für eigene Rechte kopierst Du eine und passt die Kopie an.</p></div>
      </div>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <div className="table-wrap">
        <table className="table" aria-label="Rollen">
          <thead><tr><th scope="col">Rolle</th><th scope="col" className="hide-sm">Schreibt in</th><th scope="col" /></tr></thead>
          <tbody>
            {roles.data?.map((r) => (
              <tr key={r.id} data-href tabIndex={0} onClick={() => setOpen(r.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(r.id)}>
                <td><span className="name">{r.name}</span>{r.builtin && <span className="pill" style={{ marginLeft: 8 }}>eingebaut</span>}</td>
                <td className="hide-sm muted">{Object.entries(r.permissions).filter(([, l]) => l === 'write').map(([m]) => MODULE_LABEL[m]).join(', ') || 'nur lesen'}</td>
                <td className="r">{canWrite && <button className="btn btn-ghost row-actions" onClick={(e) => { e.stopPropagation(); void copy(r); }}>Kopieren</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <Sheet title={current?.name ?? 'Rolle'} open={!!current} onClose={() => setOpen(null)}>
        {current && (
          <>
            {current.builtin && <p className="muted" style={{ marginBottom: 'var(--s-4)' }}>Eingebaute Rolle, nur lesbar.</p>}
            <div className="perm-grid">
              {Object.keys(MODULE_LABEL).map((m) => (
                <label key={m}>
                  {MODULE_LABEL[m]}
                  <select className="select" disabled={current.builtin || !canWrite} value={current.permissions[m] ?? 'none'} onChange={(e) => void patch({ permissions: { ...current.permissions, [m]: e.target.value as Role['permissions'][string] } })}>
                    {Object.entries(LEVEL_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                </label>
              ))}
            </div>
            <h3 style={{ margin: 'var(--s-5) 0 var(--s-2)' }}>Ausgeblendete Felder</h3>
            {Object.entries(FIELD_LABEL).map(([f, label]) => (
              <label key={f} className="check" style={{ marginRight: 'var(--s-4)' }}>
                <input type="checkbox" disabled={current.builtin || !canWrite} checked={current.restrictedFields.includes(f)} onChange={(e) => void patch({ restrictedFields: e.target.checked ? [...current.restrictedFields, f] : current.restrictedFields.filter((x) => x !== f) })} />
                {label}
              </label>
            ))}
            {current.builtin && canWrite && <div className="actions-row"><button className="btn" onClick={() => void copy(current)}>Als eigene Rolle kopieren</button></div>}
          </>
        )}
      </Sheet>
    </>
  );
}
