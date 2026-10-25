import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { COLOR_LABEL, COURT_COLORS, GROUP_KINDS, KIND_LABEL, type Group } from '../../shared/groups.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { Field } from '../components/Field.tsx';
import { GroupBadge } from '../components/GroupBadge.tsx';
import { InlineEdit } from '../components/InlineEdit.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { useMe } from '../lib/session.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal, useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

export function Groups({ me }: { me: Me }) {
  useTitle('Gruppen');
  const canWrite = me.permissions.groups === 'write';
  const [showArchived, setShowArchived] = useState(false);
  const { data: groups, isPending } = useGroups(showArchived);
  const [creating, setCreating] = useState(false);
  const navigate = useNavigate();
  const { id } = useParams();

  return (
    <div className="page">
      <PageHead
        title="Gruppen"
        intro="Abteilungen, Mannschaften und Gruppen. Mitglieder gehören ihnen jeweils von einem Datum bis zu einem Datum an."
        actions={canWrite && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden /> Gruppe anlegen</button>}
      />
      <div className="toolbar">
        <label className="check"><input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Archivierte zeigen</label>
      </div>
      {creating && <CreateGroup onClose={() => setCreating(false)} />}
      <div className="table-wrap">
        {groups && groups.length === 0 ? (
          <div className="empty-state">
            <h3>Noch keine Gruppen.</h3>
            <p>Lege zum Beispiel Deine Abteilungen an (Fußball, Turnen, Jugend). Jede Gruppe bekommt eine Linienfarbe wie auf dem Hallenboden.</p>
            {canWrite && <button className="btn btn-primary" onClick={() => setCreating(true)}>Erste Gruppe anlegen</button>}
          </div>
        ) : (
          <table className="table" aria-label="Gruppen">
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th scope="col" className="num">Kürzel</th>
                <th scope="col" className="hide-sm">Art</th>
                <th scope="col" className="num">Mitglieder</th>
                <th scope="col" className="hide-sm">Sichtbar</th>
              </tr>
            </thead>
            <tbody>
              {isPending && <tr><td colSpan={5}><div className="skeleton" style={{ width: '40%' }} /></td></tr>}
              {groups?.map((g) => (
                <tr key={g.id} data-href tabIndex={0} onClick={() => navigate(`/gruppen/${g.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/gruppen/${g.id}`)}>
                  <td><span className="name"><GroupBadge name={g.name} color={g.color} /></span>{g.archived && <span className="pill" style={{ marginLeft: 8 }}>archiviert</span>}</td>
                  <td className="num">{g.shortCode}</td>
                  <td className="hide-sm">{KIND_LABEL[g.kind]}</td>
                  <td className="num"><Link to={`/mitglieder?gruppe=${g.id}`} onClick={(e) => e.stopPropagation()}>{g.memberCount}</Link></td>
                  <td className="hide-sm">{g.visibleToMembers ? 'Für Mitglieder' : 'Nur Verwaltung'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <GroupSheet group={groups?.find((g) => g.id === id) ?? null} canWrite={canWrite} onClose={() => navigate('/gruppen')} />
    </div>
  );
}

function CreateGroup({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<ApiError>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    try {
      await api('/groups', { method: 'POST', body: { name: f.get('name'), shortCode: f.get('shortCode'), kind: f.get('kind'), color: f.get('color'), visibleToMembers: f.get('adminOnly') !== 'on' } });
      await qc.invalidateQueries({ queryKey: ['groups'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  return (
    <form className="inline-form" style={{ marginBottom: 'var(--s-5)', marginTop: 0 }} onSubmit={submit} noValidate aria-label="Neue Gruppe">
      {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
      <div className="form-row">
        <Field label="Name" name="name" autoFocus required placeholder="Fußball Jugend" error={error?.fieldError('name')} />
        <Field label="Kürzel" name="shortCode" required placeholder="FBJ" error={error?.fieldError('shortCode') ?? (error?.problem.status === 409 ? error.problem.detail : undefined)} />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="kind">Art</label>
          <select id="kind" name="kind" className="select" style={{ width: '100%' }} defaultValue="division">
            {GROUP_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
        <div className="field">
          <label htmlFor="color">Linienfarbe</label>
          <select id="color" name="color" className="select" style={{ width: '100%' }}>
            {COURT_COLORS.map((c) => <option key={c} value={c}>{COLOR_LABEL[c]}</option>)}
          </select>
        </div>
      </div>
      <label className="check"><input type="checkbox" name="adminOnly" /> Nur für die Verwaltung sichtbar (erscheint nie im Mitgliederbereich)</label>
      <div className="actions-row" style={{ marginTop: 0 }}>
        <button className="btn btn-primary">Gruppe anlegen</button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
      </div>
    </form>
  );
}

function GroupSheet({ group, canWrite, onClose }: { group: Group | null; canWrite: boolean; onClose: () => void }) {
  const canMail = useMe().data?.permissions.communication === 'write';
  const qc = useQueryClient();
  const [at, setAt] = useState(todayLocal());
  const members = useQuery({ queryKey: ['group-members', group?.id, at], queryFn: () => api<MemberListItem[]>(`/groups/${group!.id}/members?at=${at}`), enabled: !!group });
  const [error, setError] = useState<string>();
  const save = async (body: Record<string, unknown>) => {
    setError(undefined);
    try {
      await api(`/groups/${group!.id}`, { method: 'PATCH', body });
      await qc.invalidateQueries({ queryKey: ['groups'] });
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.detail ?? e.problem.title) : String(e));
      throw e;
    }
  };
  const archive = async () => {
    await api(`/groups/${group!.id}/${group!.archived ? 'unarchive' : 'archive'}`, { method: 'POST' });
    await qc.invalidateQueries({ queryKey: ['groups'] });
  };

  return (
    <Sheet title={group?.name ?? 'Gruppe'} open={!!group} onClose={onClose}>
      {group && (
        <>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <section className="sheet-section">
            <dl className="facts">
              <dt>Name</dt>
              <dd>{canWrite ? <InlineEdit label="Name" value={group.name} onSave={(v) => save({ name: v })} /> : group.name}</dd>
              <dt>Kürzel</dt>
              <dd>{canWrite ? <InlineEdit label="Kürzel" field="shortCode" value={group.shortCode} onSave={(v) => save({ shortCode: v })} /> : group.shortCode}</dd>
              <dt>Art</dt>
              <dd>
                <select className="select" aria-label="Art" disabled={!canWrite} value={group.kind} onChange={(e) => void save({ kind: e.target.value })}>
                  {GROUP_KINDS.map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
                </select>
              </dd>
              <dt>Linienfarbe</dt>
              <dd>
                <select className="select" aria-label="Linienfarbe" disabled={!canWrite} value={group.color} onChange={(e) => void save({ color: e.target.value })}>
                  {COURT_COLORS.map((c) => <option key={c} value={c}>{COLOR_LABEL[c]}</option>)}
                </select>
              </dd>
              <dt>Sichtbarkeit</dt>
              <dd>
                <label className="check"><input type="checkbox" disabled={!canWrite} checked={!group.visibleToMembers} onChange={(e) => void save({ visibleToMembers: !e.target.checked })} /> Nur für die Verwaltung</label>
              </dd>
            </dl>
            <div className="actions-row">
              {canMail && !group.archived && <Link className="btn" to="/kommunikation" state={{ groupId: group.id }}>E-Mail an die Gruppe</Link>}
              {canWrite && <button className="btn" onClick={() => void archive()}>{group.archived ? 'Wiederherstellen' : 'Archivieren'}</button>}
            </div>
          </section>
          <AgeRule group={group} canWrite={canWrite} save={save} />
          <section className="sheet-section" aria-labelledby="g-members">
            <h3 id="g-members">Mitglieder am</h3>
            <input type="date" className="input" style={{ width: 'auto', marginBottom: 'var(--s-3)' }} aria-label="Stichtag" value={at} onChange={(e) => e.target.value && setAt(e.target.value)} />
            {members.data?.length === 0 && <p className="muted">An diesem Tag war niemand in der Gruppe.</p>}
            <ul className="timeline">
              {members.data?.map((m) => (
                <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}>
                  <Link to={`/mitglieder/${m.id}`}>{displayName(m)}</Link>
                  <StatusBadge status={m.status} />
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Sheet>
  );
}

/** Age rule: members move on to another group at a given age; with a preview of who moves when. */
function AgeRule({ group, canWrite, save }: { group: Group; canWrite: boolean; save: (body: Record<string, unknown>) => Promise<void> }) {
  const { data: groups } = useGroups();
  const birthVisible = useMe().data?.restricted?.includes('birth_date') !== true;
  const moves = useQuery({ queryKey: ['age-moves', group.id, group.nextGroupId, group.nextGroupAge, group.nextGroupOn], queryFn: () => api<{ memberId: string; name: string; moveOn: string }[]>(`/groups/${group.id}/age-moves`), enabled: !!group.nextGroupId && birthVisible, retry: false });
  const target = groups?.find((g) => g.id === group.nextGroupId);
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const to = String(f.get('nextGroupId') ?? '');
    await save(to ? { nextGroupId: to, nextGroupAge: Number(f.get('nextGroupAge')), nextGroupOn: f.get('nextGroupOn') } : { nextGroupId: null, nextGroupAge: null, nextGroupOn: null }).catch(() => undefined);
  }
  return (
    <section className="sheet-section" aria-labelledby="g-age">
      <h3 id="g-age">Wechsel nach Alter</h3>
      {canWrite ? (
        <form className="age-rule" onSubmit={submit} aria-label="Wechsel nach Alter">
          <span>Mit</span>
          <input name="nextGroupAge" type="number" min={1} max={120} className="input" aria-label="Alter" defaultValue={group.nextGroupAge ?? 18} />
          <span>Jahren</span>
          <select name="nextGroupOn" className="select" aria-label="Zeitpunkt" defaultValue={group.nextGroupOn ?? 'birthday'}>
            <option value="birthday">am Geburtstag</option>
            <option value="year_start">zum 1. Januar</option>
          </select>
          <span>wechseln nach</span>
          <select name="nextGroupId" className="select" aria-label="Zielgruppe" defaultValue={group.nextGroupId ?? ''}>
            <option value="">kein Wechsel</option>
            {groups?.filter((g) => g.id !== group.id).map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
          </select>
          <button className="btn">Speichern</button>
        </form>
      ) : (
        <p className="muted">{target ? `Mit ${group.nextGroupAge} Jahren ${group.nextGroupOn === 'birthday' ? 'am Geburtstag' : 'zum 1. Januar'} nach „${target.name}“.` : 'Kein Wechsel nach Alter.'}</p>
      )}
      {group.nextGroupId && moves.data && (
        moves.data.length === 0 ? <p className="meta" style={{ marginTop: 'var(--s-2)' }}>In den nächsten 12 Monaten wechselt niemand.</p> : (
          <ul className="timeline" aria-label="Anstehende Wechsel" style={{ marginTop: 'var(--s-3)' }}>
            {moves.data.map((m) => (
              <li key={m.memberId} style={{ gridTemplateColumns: '1fr auto' }}>
                <Link to={`/mitglieder/${m.memberId}`}>{m.name}</Link>
                <span className="meta num">{m.moveOn.split('-').reverse().join('.')}</span>
              </li>
            ))}
          </ul>
        )
      )}
    </section>
  );
}
