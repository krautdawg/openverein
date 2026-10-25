import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { FIELD_LABEL, LEVEL_LABEL, MODULE_LABEL, type Role, type User } from '../../../shared/access.ts';
import type { Me } from '../../../shared/auth.ts';
import { Field } from '../../components/Field.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useGroups } from '../../lib/hooks.ts';
import { useTitle } from '../../lib/useTitle.ts';

export const inviteUrl = (token: string) => `${window.location.origin}/einladung#${token}`;

function GrantPicker({ roles, defaultRole, defaultScope }: { roles: Role[]; defaultRole?: string; defaultScope?: string[] | null }) {
  const { data: groups } = useGroups();
  return (
    <>
      <div className="field">
        <label htmlFor="roleId">Rolle</label>
        <select id="roleId" name="roleId" className="select" style={{ width: '100%' }} defaultValue={defaultRole}>
          {roles.map((r) => <option key={r.id} value={r.id}>{r.name}</option>)}
        </select>
      </div>
      {groups && groups.length > 0 && (
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Beschränkt auf Gruppen <span className="meta">(leer = ganzer Verein)</span></legend>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--s-4)' }}>
            {groups.map((g) => <label key={g.id} className="check"><input type="checkbox" name="scope" value={g.id} defaultChecked={defaultScope?.includes(g.id)} /> {g.name}</label>)}
          </div>
        </fieldset>
      )}
    </>
  );
}

const grantFrom = (f: FormData) => ({ roleId: f.get('roleId'), scopeGroupIds: f.getAll('scope').length ? f.getAll('scope') : null });

function OneTimeLink({ token }: { token: string }) {
  const url = inviteUrl(token);
  return (
    <div className="alert alert-ok" role="status">
      <p style={{ marginBottom: 'var(--s-2)' }}>Einladungslink, 7 Tage gültig. Er wird nur jetzt angezeigt; schick ihn der Person.</p>
      <div className="token-once">{url}</div>
      <button className="btn" style={{ marginTop: 'var(--s-2)' }} onClick={() => void navigator.clipboard?.writeText(url)}>Link kopieren</button>
    </div>
  );
}

export function Users({ me }: { me: Me }) {
  useTitle('Zugänge');
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const users = useQuery({ queryKey: ['users'], queryFn: () => api<User[]>('/users') });
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<Role[]>('/roles') });
  const [creating, setCreating] = useState(false);
  const [invite, setInvite] = useState<string>();
  const [error, setError] = useState<ApiError>();
  const [open, setOpen] = useState<string | null>(null);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const r = await api<{ inviteToken: string }>('/users', { method: 'POST', body: { name: f.get('name'), email: f.get('email'), grants: [grantFrom(f)] } });
      setInvite(r.inviteToken);
      setCreating(false);
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <>
      <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div><h2>Zugänge</h2><p>Wer die Verwaltung nutzen darf. Admins müssen keine Mitglieder sein.</p></div>
        {canWrite && !creating && <button className="btn btn-primary" onClick={() => { setCreating(true); setInvite(undefined); }}>Zugang anlegen</button>}
      </div>
      {invite && <OneTimeLink token={invite} />}
      {creating && roles.data && (
        <form className="inline-form" style={{ marginBottom: 'var(--s-5)' }} onSubmit={create} noValidate aria-label="Neuer Zugang">
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <div className="form-row">
            <Field label="Name" name="name" required autoFocus error={error?.fieldError('name')} />
            <Field label="E-Mail" name="email" type="email" required error={error?.fieldError('email')} />
          </div>
          <GrantPicker roles={roles.data} />
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary">Anlegen und Link erzeugen</button>
            <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Abbrechen</button>
          </div>
        </form>
      )}
      <div className="table-wrap" style={{ marginTop: 'var(--s-4)' }}>
        <table className="table" aria-label="Zugänge">
          <thead><tr><th scope="col">Name</th><th scope="col" className="hide-sm">E-Mail</th><th scope="col">Rollen</th><th scope="col">Status</th></tr></thead>
          <tbody>
            {users.data?.map((u) => (
              <tr key={u.id} data-href tabIndex={0} onClick={() => setOpen(u.id)} onKeyDown={(e) => e.key === 'Enter' && setOpen(u.id)}>
                <td className="name">{u.name}</td>
                <td className="hide-sm">{u.email}</td>
                <td>{u.grants.map((g) => g.roleName + (g.scopeGroupIds ? ' (Gruppen)' : '')).join(', ')}</td>
                <td>{u.status === 'disabled' ? <span className="pill">gesperrt</span> : u.invited ? <span className="pill">eingeladen</span> : 'aktiv'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <UserSheet user={users.data?.find((u) => u.id === open) ?? null} roles={roles.data ?? []} me={me} onClose={() => setOpen(null)} />
    </>
  );
}

function UserSheet({ user, roles, me, onClose }: { user: User | null; roles: Role[]; me: Me; onClose: () => void }) {
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const perms = useQuery({
    queryKey: ['permissions', user?.id, user?.grants],
    queryFn: () => api<{ modules: { module: string; level: keyof typeof LEVEL_LABEL; scope: string[] | null }[]; restrictedFields: string[] }>(`/users/${user!.id}/permissions`),
    enabled: !!user,
  });
  const [error, setError] = useState<string>();
  const [invite, setInvite] = useState<string>();

  async function patch(body: unknown) {
    setError(undefined);
    try {
      await api(`/users/${user!.id}`, { method: 'PATCH', body });
      await qc.invalidateQueries({ queryKey: ['users'] });
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
    }
  }

  return (
    <Sheet title={user?.name ?? 'Zugang'} open={!!user} onClose={() => { setInvite(undefined); onClose(); }}>
      {user && (
        <>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          {invite && <OneTimeLink token={invite} />}
          <section className="sheet-section">
            <p className="muted">{user.email}{user.lastLoginAt && ` · zuletzt angemeldet ${new Date(user.lastLoginAt).toLocaleString('de-DE')}`} · zweiter Faktor {user.totpEnabled ? 'eingerichtet' : 'nicht eingerichtet'}</p>
            {canWrite && (
              <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void patch({ grants: [grantFrom(new FormData(e.currentTarget))] }); }} aria-label="Rolle ändern" key={user.id}>
                <GrantPicker roles={roles} defaultRole={user.grants[0]?.roleId} defaultScope={user.grants[0]?.scopeGroupIds} />
                <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Rolle speichern</button></div>
              </form>
            )}
            {canWrite && (
              <div className="actions-row">
                {user.id !== me.id && <button className="btn" onClick={() => void patch({ status: user.status === 'active' ? 'disabled' : 'active' })}>{user.status === 'active' ? 'Zugang sperren' : 'Zugang entsperren'}</button>}
                {user.invited && <button className="btn" onClick={async () => setInvite((await api<{ inviteToken: string }>(`/users/${user.id}/invite`, { method: 'POST' })).inviteToken)}>Neuen Einladungslink</button>}
                {user.totpEnabled && user.id !== me.id && <button className="btn" onClick={async () => { try { await api(`/users/${user.id}/totp/reset`, { method: 'POST' }); setError(undefined); await qc.invalidateQueries({ queryKey: ['users'] }); } catch (e) { setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e)); } }}>Zweiten Faktor zurücksetzen</button>}
              </div>
            )}
          </section>
          <section className="sheet-section" aria-labelledby="eff">
            <h3 id="eff">Berechtigungen prüfen</h3>
            <dl className="facts">
              {perms.data?.modules.filter((m) => m.level !== 'none').map((m) => (
                <div key={m.module} style={{ display: 'contents' }}>
                  <dt>{MODULE_LABEL[m.module] ?? m.module}</dt>
                  <dd>{LEVEL_LABEL[m.level]}{m.scope && <span className="muted"> · nur {m.scope.join(', ')}</span>}</dd>
                </div>
              ))}
            </dl>
            {perms.data && perms.data.restrictedFields.length > 0 && <p className="meta" style={{ marginTop: 'var(--s-3)' }}>Ausgeblendete Felder: {perms.data.restrictedFields.map((f) => FIELD_LABEL[f] ?? f).join(', ')}</p>}
          </section>
        </>
      )}
    </Sheet>
  );
}
