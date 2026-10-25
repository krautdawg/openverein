import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { Assembly } from '../../shared/assemblies.ts';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { Field } from '../components/Field.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

type Summary = { id: string; title: string; heldOn: string; invitedAt: string | null; closedAt: string | null };
const problemText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');
const stage = (a: { invitedAt: string | null; closedAt: string | null }) => (a.closedAt ? 'abgeschlossen' : a.invitedAt ? 'eingeladen' : 'in Vorbereitung');

/** General assemblies: agenda, invitation within the notice period, attendance, votes, minutes. */
export function Assemblies({ me }: { me: Me }) {
  useTitle('Versammlungen');
  const list = useQuery({ queryKey: ['assemblies'], queryFn: () => api<Summary[]>('/assemblies'), retry: false });
  const [creating, setCreating] = useState(false);
  const canWrite = me.permissions.members === 'write';
  return (
    <div className="page">
      <PageHead title="Versammlungen" intro="Mitgliederversammlungen mit Tagesordnung, fristgerechter Einladung, Anwesenheit, Abstimmungen und Protokoll." actions={canWrite && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden /> Versammlung anlegen</button>} />
      {list.error && <div className="alert alert-error" role="alert">{problemText(list.error)}</div>}
      {list.data?.length === 0 && <div className="empty-state"><h3>Noch keine Versammlung.</h3><p>Leg die nächste Mitgliederversammlung mit ihrer Tagesordnung an. OpenVerein rechnet aus, bis wann eingeladen werden muss.</p></div>}
      {!!list.data?.length && (
        <ul className="timeline" aria-label="Versammlungen">
          {list.data.map((a) => (
            <li key={a.id} style={{ gridTemplateColumns: '6rem 1fr auto' }}>
              <span className="num meta">{formatDate(a.heldOn)}</span>
              <Link to={`/versammlungen/${a.id}`}>{a.title}</Link>
              <span className="meta">{stage(a)}</span>
            </li>
          ))}
        </ul>
      )}
      {creating && <CreateAssembly onClose={() => setCreating(false)} />}
    </div>
  );
}

const AGENDA = {
  general: [{ title: 'Begrüßung und Feststellung der Beschlussfähigkeit', isVote: false }, { title: 'Bericht des Vorstands', isVote: false }, { title: 'Bericht der Kassenprüfung', isVote: false }, { title: 'Entlastung des Vorstands', isVote: true }, { title: 'Verschiedenes', isVote: false }],
  board: [{ title: 'Protokoll der letzten Sitzung', isVote: true }, { title: 'Berichte aus den Abteilungen', isVote: false }, { title: 'Finanzen', isVote: false }, { title: 'Beschlüsse', isVote: true }, { title: 'Verschiedenes', isVote: false }],
};

function CreateAssembly({ onClose }: { onClose: () => void }) {
  const navigate = useNavigate();
  const qc = useQueryClient();
  const groups = useGroups();
  const [kind, setKind] = useState<'general' | 'board'>('general');
  const [items, setItems] = useState(AGENDA.general);
  const switchKind = (k: 'general' | 'board') => { setKind(k); setItems(AGENDA[k]); };
  const [error, setError] = useState<ApiError>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const a = await api<Assembly>('/assemblies', { method: 'POST', body: { kind, groupId: kind === 'board' ? f.get('groupId') : null, title: f.get('title'), heldOn: f.get('heldOn'), startsAt: f.get('startsAt'), place: f.get('place'), noticeDays: Number(f.get('noticeDays')), items: items.filter((i) => i.title.trim()) } });
      await qc.invalidateQueries({ queryKey: ['assemblies'] });
      navigate(`/versammlungen/${a.id}`);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  const set = (i: number, patch: Partial<(typeof items)[number]>) => setItems((xs) => xs.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <Sheet title="Versammlung anlegen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
        <div className="segmented" role="group" aria-label="Art" style={{ alignSelf: 'flex-start' }}>
          <button type="button" aria-pressed={kind === 'general'} onClick={() => switchKind('general')}>Mitgliederversammlung</button>
          <button type="button" aria-pressed={kind === 'board'} onClick={() => switchKind('board')}>Vorstandssitzung</button>
        </div>
        {kind === 'board' && (
          <div className="field">
            <label htmlFor="as-group">Eingeladen wird</label>
            <select id="as-group" name="groupId" className="select" defaultValue={groups.data?.find((g) => g.kind === 'board')?.id ?? ''} key={groups.data?.length}>
              {groups.data?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
            </select>
          </div>
        )}
        <Field key={kind} label="Titel" name="title" defaultValue={kind === 'board' ? 'Vorstandssitzung' : `Ordentliche Mitgliederversammlung ${new Date().getFullYear()}`} error={error?.fieldError('title')} />
        <div className="form-row">
          <Field label="Datum" name="heldOn" type="date" error={error?.fieldError('heldOn')} />
          <Field label="Beginn" name="startsAt" type="time" defaultValue="19:00" error={error?.fieldError('startsAt')} />
        </div>
        <Field label="Ort" name="place" placeholder="z. B. Vereinsheim, Am Sportplatz 1" error={error?.fieldError('place')} />
        <Field key={`n-${kind}`} label="Einladungsfrist laut Satzung (Tage)" name="noticeDays" type="number" min={0} max={120} defaultValue={kind === 'board' ? 7 : 14} />
        <fieldset className="agenda-edit">
          <legend>Tagesordnung</legend>
          <ol>
            {items.map((it, i) => (
              <li key={i}>
                <input className="input" aria-label={`Punkt ${i + 1}`} value={it.title} onChange={(e) => set(i, { title: e.target.value })} />
                <label className="check"><input type="checkbox" checked={it.isVote} onChange={(e) => set(i, { isVote: e.target.checked })} /> Abstimmung</label>
              </li>
            ))}
          </ol>
          <button type="button" className="btn btn-ghost" onClick={() => setItems((xs) => [...xs, { title: '', isVote: false }])}>Punkt hinzufügen</button>
        </fieldset>
        <div className="actions-row"><button className="btn btn-primary">Anlegen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

/** All current members, page by page (the list API pages at 200). */
async function allMembers(groupId: string | null) {
  const out: MemberListItem[] = [];
  let cursor: string | null = '';
  while (cursor !== null) {
    const r: { items: MemberListItem[]; nextCursor: string | null } = await api(`/members?limit=200${groupId ? `&groupId=${groupId}` : ''}${cursor ? `&cursor=${cursor}` : ''}`);
    out.push(...r.items);
    cursor = r.nextCursor;
  }
  return out;
}

export function AssemblyPage({ me }: { me: Me }) {
  const { id } = useParams();
  const qc = useQueryClient();
  const a = useQuery({ queryKey: ['assembly', id], queryFn: () => api<Assembly>(`/assemblies/${id}`) });
  useTitle(a.data?.title ?? 'Versammlung');
  const [letters, setLetters] = useState<{ name: string; reason: string }[]>();
  const [error, setError] = useState<string>();
  const canWrite = me.permissions.members === 'write';
  const closed = !!a.data?.closedAt;
  const refresh = (next: Assembly) => qc.setQueryData(['assembly', id], next);
  const run = async (f: () => Promise<void>) => {
    setError(undefined);
    try {
      await f();
    } catch (err) {
      setError(problemText(err));
    }
  };
  if (!a.data) return <div className="page">{a.error && <div className="alert alert-error" role="alert">{problemText(a.error)}</div>}</div>;
  const d = a.data;
  return (
    <div className="page">
      <PageHead title={d.title} intro={`${d.kind === 'board' ? 'Vorstandssitzung · ' : ''}${formatDate(d.heldOn)}, ${d.startsAt} Uhr · ${d.place}`} actions={<a className="btn" href={`/api/v1/assemblies/${d.id}/minutes.pdf`} download>Protokoll (PDF)</a>} />
      {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-4)' }}>{error}</div>}

      <section className="section" aria-labelledby="as-invite" style={{ marginTop: 0 }}>
        <h2 id="as-invite">Einladung</h2>
        {d.invitedAt ? (
          <p>Verschickt am {formatDate(d.invitedAt.slice(0, 10))}{d.messageId && <> (<Link to={`/kommunikation/${d.messageId}`}>Zustellung</Link>)</>}.</p>
        ) : (
          <>
            <p className="muted" style={{ marginBottom: 'var(--s-3)', maxWidth: '72ch' }}>Frist {d.noticeDays} Tage: spätestens am {formatDate(d.inviteBy)} einladen. Die E-Mail geht mit der Tagesordnung an {d.kind === 'board' ? 'die eingeladene Gruppe' : 'alle aktuellen Mitglieder'}; danach stehen Termin und Tagesordnung fest.</p>
            {canWrite && <button className="btn btn-primary" onClick={() => void run(async () => { const r = await api<{ sent: number; letters: { name: string; reason: string }[] }>(`/assemblies/${d.id}/invite`, { method: 'POST' }); setLetters(r.letters); await a.refetch(); })}>Einladung verschicken</button>}
          </>
        )}
        {letters && letters.length > 0 && <p className="meta" style={{ marginTop: 'var(--s-2)' }}>Per Brief einladen: {letters.map((l) => `${l.name} (${l.reason})`).join(', ')}.</p>}
      </section>

      <section className="section" aria-labelledby="as-agenda">
        <h2 id="as-agenda">Tagesordnung</h2>
        <ol className="agenda-items">
          {d.items.map((i) => <AgendaItem key={i.id} assemblyId={d.id} item={i} editable={canWrite && !closed} onSaved={refresh} />)}
        </ol>
      </section>

      <Attendance assembly={d} editable={canWrite && !closed} onSaved={refresh} />

      <section className="section" aria-labelledby="as-close">
        <h2 id="as-close">Abschluss</h2>
        {closed ? (
          <p>Abgeschlossen am {formatDate(d.closedAt!.slice(0, 10))}. Leitung: {d.chair} · Protokoll: {d.minutesBy}. Das Protokoll wird nicht mehr geändert.</p>
        ) : canWrite ? (
          <form className="form" style={{ maxWidth: 520 }} noValidate onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void run(async () => { refresh(await api<Assembly>(`/assemblies/${d.id}/close`, { method: 'POST', body: { chair: f.get('chair'), minutesBy: f.get('minutesBy') } })); }); }}>
            <div className="form-row"><Field label="Versammlungsleitung" name="chair" /><Field label="Protokoll" name="minutesBy" /></div>
            <div className="actions-row"><button className="btn">Versammlung abschließen</button></div>
          </form>
        ) : <p className="muted">Noch nicht abgeschlossen.</p>}
      </section>
    </div>
  );
}

function AgendaItem({ assemblyId, item, editable, onSaved }: { assemblyId: string; item: Assembly['items'][number]; editable: boolean; onSaved: (a: Assembly) => void }) {
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const n = (k: string) => (String(f.get(k) ?? '') === '' ? null : Number(f.get(k)));
    setError(undefined);
    try {
      onSaved(await api<Assembly>(`/assemblies/${assemblyId}/items/${item.id}`, { method: 'PUT', body: { votesYes: n('yes'), votesNo: n('no'), votesAbstain: n('abstain'), outcome: String(f.get('outcome') ?? '') || null } }));
      setSaved(true);
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <li>
      <strong>{item.title}</strong>
      {item.description && <p className="muted">{item.description}</p>}
      {editable ? (
        <form className="agenda-result" onSubmit={(e) => void save(e)} aria-label={`Ergebnis zu ${item.title}`}>
          {item.isVote && (
            <span className="votes">
              <label>Ja <input name="yes" type="number" min={0} className="input" defaultValue={item.votesYes ?? ''} /></label>
              <label>Nein <input name="no" type="number" min={0} className="input" defaultValue={item.votesNo ?? ''} /></label>
              <label>Enthaltung <input name="abstain" type="number" min={0} className="input" defaultValue={item.votesAbstain ?? ''} /></label>
            </span>
          )}
          <textarea name="outcome" className="textarea" rows={2} aria-label={`Beschluss oder Notiz zu ${item.title}`} placeholder={item.isVote ? 'Beschluss, z. B. „Der Vorstand ist entlastet.“' : 'Notiz fürs Protokoll'} defaultValue={item.outcome ?? ''} />
          <span className="actions-inline"><button className="btn">Speichern</button>{saved && <span className="meta" role="status">Gespeichert.</span>}{error && <span className="error" role="alert">{error}</span>}</span>
        </form>
      ) : (
        <p>{item.isVote && item.votesYes !== null ? `${item.votesYes} Ja, ${item.votesNo ?? 0} Nein, ${item.votesAbstain ?? 0} Enthaltungen. ` : ''}{item.outcome}</p>
      )}
    </li>
  );
}

function Attendance({ assembly, editable, onSaved }: { assembly: Assembly; editable: boolean; onSaved: (a: Assembly) => void }) {
  const members = useQuery({ queryKey: ['members-all', assembly.groupId], queryFn: () => allMembers(assembly.groupId), enabled: editable });
  const [present, setPresent] = useState<Set<string>>(() => new Set(assembly.attendees));
  const [q, setQ] = useState('');
  const [state, setState] = useState<string>();
  const shown = (members.data ?? []).filter((m) => displayName(m).toLowerCase().includes(q.trim().toLowerCase()));
  async function save() {
    setState(undefined);
    try {
      onSaved(await api<Assembly>(`/assemblies/${assembly.id}/attendance`, { method: 'PUT', body: { memberIds: [...present] } }));
      setState('Gespeichert.');
    } catch (err) {
      setState(problemText(err));
    }
  }
  return (
    <section className="section" aria-labelledby="as-attend">
      <h2 id="as-attend">Anwesenheit</h2>
      <p className="muted" style={{ marginBottom: 'var(--s-3)' }}><span className="num">{present.size}</span> von <span className="num">{assembly.eligible}</span> Mitgliedern anwesend.</p>
      {editable && (
        <>
          <div className="toolbar">
            <input className="input" type="search" aria-label="Mitglied suchen" placeholder="Name" value={q} onChange={(e) => setQ(e.target.value)} style={{ maxWidth: 280 }} />
            <button className="btn" onClick={() => void save()}>Anwesenheit speichern</button>
            {state && <span className="meta" role="status">{state}</span>}
          </div>
          <ul className="attendance" aria-label="Mitglieder">
            {shown.map((m) => (
              <li key={m.id}><label className="check"><input type="checkbox" checked={present.has(m.id)} onChange={() => setPresent((s) => { const n = new Set(s); if (n.has(m.id)) n.delete(m.id); else n.add(m.id); return n; })} /> {displayName(m)}</label></li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
