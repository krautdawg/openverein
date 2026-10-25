import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro } from '../../shared/fees.ts';
import { HOUSEHOLD_RULE_KINDS, HOUSEHOLD_RULE_LABEL, type Household } from '../../shared/households.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { parseEuro } from '../lib/money.ts';
import { useTitle } from '../lib/useTitle.ts';

const problemText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');

/** Member search used to add members or pick the payer. */
function MemberPick({ label, onPick, exclude = [] }: { label: string; onPick: (m: MemberListItem) => void; exclude?: string[] }) {
  const [term, setTerm] = useState('');
  const found = useQuery({ queryKey: ['member-pick', term], queryFn: () => api<{ items: MemberListItem[] }>(`/members?q=${encodeURIComponent(term)}&limit=6`), enabled: term.trim().length >= 2 });
  const id = `pick-${label.replace(/\W/g, '')}`;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <input id={id} className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name oder Nummer" autoComplete="off" />
      <ul className="timeline">
        {found.data?.items.filter((m) => !exclude.includes(m.id)).map((m) => (
          <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}>
            <span>{displayName(m)} <span className="meta">Nr. {m.membershipNumber}</span></span>
            <button type="button" className="btn btn-ghost" aria-label={`${displayName(m)} wählen`} onClick={() => { onPick(m); setTerm(''); }}>wählen</button>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Households({ me }: { me: Me }) {
  useTitle('Haushalte');
  const list = useQuery({ queryKey: ['households'], queryFn: () => api<Household[]>('/households') });
  const [open, setOpen] = useState<string | 'new' | null>(null);
  const canWrite = me.permissions.members === 'write';
  const selected = list.data?.find((h) => h.id === open) ?? null;

  return (
    <div className="page">
      <p style={{ marginBottom: 'var(--s-4)' }}><Link to="/mitglieder">← Mitglieder</Link></p>
      <PageHead title="Haushalte" intro="Familien und Haushalte bekommen eine gemeinsame Beitragsrechnung an die zahlende Person, auf Wunsch mit Familienrabatt. Eingezogen wird mit deren Mandat." actions={canWrite ? <button className="btn btn-primary" onClick={() => setOpen('new')}><Plus size={16} aria-hidden /> Haushalt anlegen</button> : undefined} />
      {list.error && <div className="alert alert-error" role="alert">{problemText(list.error)}</div>}
      <div className="table-wrap">
        {list.data?.length === 0 ? (
          <p className="empty">Noch keine Haushalte.</p>
        ) : (
          <table className="table" aria-label="Haushalte">
            <thead><tr><th scope="col">Haushalt</th><th scope="col">Zahlt</th><th scope="col" className="hide-sm">Mitglieder</th><th scope="col" className="hide-sm">Rabatt</th></tr></thead>
            <tbody>
              {list.data?.map((h) => (
                <tr key={h.id} onClick={() => setOpen(h.id)} style={{ cursor: 'pointer' }}>
                  <td><button className="link-btn name" onClick={(e) => { e.stopPropagation(); setOpen(h.id); }}>{h.name}</button></td>
                  <td>{h.payerName}</td>
                  <td className="hide-sm">{h.members.map((m) => m.name).join(', ')}</td>
                  <td className="hide-sm">{h.currentRule}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {open === 'new' && <CreateHousehold onClose={() => setOpen(null)} onCreated={(id) => setOpen(id)} />}
      {selected && <HouseholdSheet h={selected} canWrite={canWrite} canRules={canWrite && me.permissions.fees === 'write'} onClose={() => setOpen(null)} />}
    </div>
  );
}

function CreateHousehold({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [name, setName] = useState('');
  const [members, setMembers] = useState<MemberListItem[]>([]);
  const [payer, setPayer] = useState<string>('');
  const [error, setError] = useState<string>();

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(undefined);
    try {
      const h = await api<Household>('/households', { method: 'POST', body: { name, payerPersonId: payer || members[0]?.personId, memberIds: members.map((m) => m.id) } });
      await qc.invalidateQueries({ queryKey: ['households'] });
      onCreated(h.id);
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <Sheet title="Haushalt anlegen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        <div className="field"><label htmlFor="hh-name">Name</label><input id="hh-name" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="z. B. Familie Becker" autoFocus /></div>
        <ul className="timeline" aria-label="Mitglieder im Haushalt">
          {members.map((m) => (
            <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <label className="check"><input type="radio" name="payer" checked={(payer || members[0]?.personId) === m.personId} onChange={() => setPayer(m.personId)} /> {displayName(m)} <span className="meta">zahlt</span></label>
              <button type="button" className="btn btn-ghost" aria-label={`${displayName(m)} entfernen`} onClick={() => setMembers(members.filter((x) => x.id !== m.id))}>entfernen</button>
            </li>
          ))}
        </ul>
        <MemberPick label="Mitglied hinzufügen" exclude={members.map((m) => m.id)} onPick={(m) => setMembers([...members, m])} />
        <div className="actions-row"><button className="btn btn-primary" disabled={!name.trim() || !members.length}>Anlegen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function HouseholdSheet({ h, canWrite, canRules, onClose }: { h: Household; canWrite: boolean; canRules: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<(typeof HOUSEHOLD_RULE_KINDS)[number]>('percent');
  const [confirmDelete, setConfirmDelete] = useState(false);

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      await qc.invalidateQueries({ queryKey: ['households'] });
    } catch (err) {
      setError(problemText(err));
    }
  }
  const setMembers = (ids: string[], payerPersonId?: string) => run(() => api(`/households/${h.id}`, { method: 'PATCH', body: { memberIds: ids, ...(payerPersonId ? { payerPersonId } : {}) } }));
  async function addRule(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const num = (k: string) => (f.get(k) ? Number(String(f.get(k)).replace(',', '.')) : null);
    await run(() => api(`/households/${h.id}/rules`, { method: 'POST', body: { validFrom: f.get('validFrom'), kind, fromNth: num('fromNth'), percentBp: num('percent') === null ? null : Math.round(num('percent')! * 100), capCents: kind === 'cap' ? parseEuro(String(f.get('cap') ?? '')) : null } }));
  }

  return (
    <Sheet title={h.name} open onClose={onClose}>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      <section className="sheet-section" aria-labelledby="hh-members">
        <h3 id="hh-members">Mitglieder</h3>
        <p className="muted" style={{ marginTop: 0 }}>Es zahlt <strong>{h.payerName}</strong>. Die Beiträge aller Mitglieder kommen auf eine Rechnung.</p>
        <ul className="timeline">
          {h.members.map((m) => (
            <li key={m.memberId} style={{ gridTemplateColumns: '1fr auto' }}>
              <span>{m.name} <span className="meta">Nr. {m.membershipNumber}{m.birthDate ? ` · geb. ${formatDate(m.birthDate)}` : ''}{m.personId === h.payerPersonId ? ' · zahlt' : ''}</span></span>
              {canWrite && (
                <span style={{ display: 'inline-flex', gap: 'var(--s-1)' }}>
                  {m.personId !== h.payerPersonId && <button className="btn btn-ghost" aria-label={`${m.name} als zahlende Person`} onClick={() => void run(() => api(`/households/${h.id}`, { method: 'PATCH', body: { payerPersonId: m.personId } }))}>zahlt künftig</button>}
                  <button className="btn btn-ghost" aria-label={`${m.name} entfernen`} onClick={() => void setMembers(h.members.filter((x) => x.memberId !== m.memberId).map((x) => x.memberId))}>entfernen</button>
                </span>
              )}
            </li>
          ))}
        </ul>
        {canWrite && <MemberPick label="Mitglied hinzufügen" exclude={h.members.map((m) => m.memberId)} onPick={(m) => void setMembers([...h.members.map((x) => x.memberId), m.id])} />}
      </section>

      <section className="sheet-section" aria-labelledby="hh-rules">
        <h3 id="hh-rules">Familienrabatt</h3>
        <ul className="timeline">
          {h.rules.length === 0 && <li style={{ gridTemplateColumns: '1fr' }}><span className="muted">Kein Rabatt.</span></li>}
          {h.rules.map((r) => <li key={r.id}><time dateTime={r.validFrom}>ab {formatDate(r.validFrom)}</time><span>{r.label}</span></li>)}
        </ul>
        {canRules && (
          <form className="inline-form" noValidate onSubmit={(e) => void addRule(e)}>
            <div className="form-row">
              <div className="field"><label htmlFor="r-kind">Regel</label><select id="r-kind" className="select" style={{ width: '100%' }} value={kind} onChange={(e) => setKind(e.target.value as typeof kind)}>{HOUSEHOLD_RULE_KINDS.map((k) => <option key={k} value={k}>{HOUSEHOLD_RULE_LABEL[k]}</option>)}</select></div>
              <div className="field"><label htmlFor="r-from">Gilt ab</label><input id="r-from" name="validFrom" type="date" className="input" defaultValue={`${todayLocal().slice(0, 4)}-01-01`} /></div>
            </div>
            {(kind === 'percent' || kind === 'children_free') && (
              <div className="form-row">
                <div className="field"><label htmlFor="r-nth">{kind === 'percent' ? 'Ab dem … Mitglied' : 'Ab dem … Kind'}</label><input id="r-nth" key={kind} name="fromNth" className="input num" inputMode="numeric" defaultValue={kind === 'percent' ? 2 : 3} /></div>
                {kind === 'percent' && <div className="field"><label htmlFor="r-pct">Rabatt in %</label><input id="r-pct" name="percent" className="input num" inputMode="decimal" defaultValue={25} /></div>}
              </div>
            )}
            {kind === 'cap' && <div className="field"><label htmlFor="r-cap">Höchstbetrag je Beitragslauf</label><input id="r-cap" name="cap" className="input num" inputMode="decimal" placeholder={euro(30000)} /></div>}
            <div className="actions-row" style={{ marginTop: 0 }}><button className="btn">Regel speichern</button></div>
          </form>
        )}
      </section>

      {canWrite && (
        <section className="sheet-section">
          {confirmDelete ? (
            <div className="actions-row" style={{ marginTop: 0 }}>
              <span>Haushalt auflösen? Die Mitglieder bekommen wieder eigene Rechnungen.</span>
              <button className="btn btn-danger" onClick={() => void run(async () => { await api(`/households/${h.id}`, { method: 'DELETE' }); onClose(); })}>Auflösen</button>
              <button className="btn btn-ghost" onClick={() => setConfirmDelete(false)}>Abbrechen</button>
            </div>
          ) : (
            <button className="btn btn-ghost" onClick={() => setConfirmDelete(true)}>Haushalt auflösen …</button>
          )}
        </section>
      )}
    </Sheet>
  );
}
