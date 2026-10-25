import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink } from 'react-router';
import { Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { Field } from '../components/Field.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

interface Loan { id: string; memberId: string; memberName: string; quantity: number; lentOn: string; dueOn: string | null; overdue: boolean }
interface Item { id: string; name: string; category: string | null; location: string | null; serial: string | null; quantity: number; valueCents: number | null; note: string | null; archived: boolean; available: number; loans: Loan[] }
const problemText = (e: unknown) => (e instanceof ApiError ? (e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ')) : 'Das hat nicht geklappt.');

export function DocumentsNav() {
  return (
    <nav className="subnav" aria-label="Dokumente">
      <NavLink to="/dokumente" end>Dateien</NavLink>
      <NavLink to="/dokumente/inventar">Inventar</NavLink>
    </nav>
  );
}

/** What the club owns, where it is and who has it. */
export function Inventory({ me }: { me: Me }) {
  useTitle('Inventar');
  const items = useQuery({ queryKey: ['inventory'], queryFn: () => api<Item[]>('/inventory') });
  const [adding, setAdding] = useState(false);
  const [lending, setLending] = useState<Item | null>(null);
  const qc = useQueryClient();
  const canWrite = me.permissions.documents === 'write';
  const giveBack = async (l: Loan) => {
    await api(`/inventory/loans/${l.id}/return`, { method: 'POST', body: { returnedOn: todayLocal() } });
    await qc.invalidateQueries({ queryKey: ['inventory'] });
  };
  const overdue = items.data?.flatMap((i) => i.loans.filter((l) => l.overdue)).length ?? 0;
  return (
    <div className="page">
      <PageHead title="Dokumente" intro="Inventar: was dem Verein gehört, wo es liegt und wer es gerade hat." actions={canWrite && <button className="btn btn-primary" onClick={() => setAdding(true)}><Plus size={16} aria-hidden /> Gegenstand anlegen</button>} />
      <DocumentsNav />
      {overdue > 0 && <div className="alert alert-warn" role="status" style={{ marginBottom: 'var(--s-4)' }}>{overdue === 1 ? 'Eine Ausleihe ist' : `${overdue} Ausleihen sind`} überfällig.</div>}
      <div className="table-wrap">
        {items.data?.length === 0 ? <p className="empty">Noch nichts im Inventar.</p> : (
          <table className="table" aria-label="Inventar">
            <thead><tr><th scope="col">Gegenstand</th><th scope="col" className="hide-sm">Ort</th><th scope="col" className="num">Verfügbar</th><th scope="col">Ausgeliehen an</th><th scope="col"><span className="sr-only">Aktionen</span></th></tr></thead>
            <tbody>
              {items.data?.map((i) => (
                <tr key={i.id}>
                  <td><span className="name">{i.name}</span>{i.category && <span className="meta"> · {i.category}</span>}{i.serial && <span className="meta"> · Nr. {i.serial}</span>}</td>
                  <td className="hide-sm">{i.location ?? '–'}</td>
                  <td className="num">{i.available} von {i.quantity}</td>
                  <td>
                    {i.loans.length === 0 ? <span className="muted">–</span> : i.loans.map((l) => (
                      <div key={l.id} className="loan">
                        <span data-over={l.overdue || undefined}>{l.memberName}{l.quantity > 1 ? ` (${l.quantity})` : ''}<span className="meta"> seit {formatDate(l.lentOn)}{l.dueOn ? `, bis ${formatDate(l.dueOn)}` : ''}</span></span>
                        {canWrite && <button className="btn btn-ghost" aria-label={`Rückgabe von ${l.memberName}: ${i.name}`} onClick={() => void giveBack(l)}>Zurück</button>}
                      </div>
                    ))}
                  </td>
                  <td>{canWrite && i.available > 0 && <button className="btn btn-ghost" aria-label={`${i.name} ausleihen`} onClick={() => setLending(i)}>Ausleihen …</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {adding && <AddItem onClose={() => setAdding(false)} />}
      {lending && <Lend item={lending} onClose={() => setLending(null)} />}
    </div>
  );
}

function AddItem({ onClose }: { onClose: () => void }) {
  const qc = useQueryClient();
  const [error, setError] = useState<ApiError>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const s = (k: string) => String(f.get(k) ?? '').trim() || null;
    setError(undefined);
    try {
      await api('/inventory', { method: 'POST', body: { name: s('name'), category: s('category'), location: s('location'), serial: s('serial'), quantity: Number(f.get('quantity') || 1), note: s('note') } });
      await qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  return (
    <Sheet title="Gegenstand anlegen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{problemText(error)}</div>}
        <Field label="Bezeichnung" name="name" placeholder="z. B. Fußball Größe 5" error={error?.fieldError('name')} />
        <div className="form-row"><Field label="Kategorie" name="category" placeholder="z. B. Bälle" /><Field label="Anzahl" name="quantity" type="number" min={1} defaultValue={1} /></div>
        <div className="form-row"><Field label="Ort" name="location" placeholder="z. B. Geräteraum Halle 2" /><Field label="Inventarnummer (optional)" name="serial" /></div>
        <div className="field"><label htmlFor="inv-note">Notiz (optional)</label><textarea id="inv-note" name="note" className="textarea" /></div>
        <div className="actions-row"><button className="btn btn-primary">Anlegen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function Lend({ item, onClose }: { item: Item; onClose: () => void }) {
  const qc = useQueryClient();
  const [term, setTerm] = useState('');
  const [member, setMember] = useState<MemberListItem | null>(null);
  const found = useQuery({ queryKey: ['lend-pick', term], queryFn: () => api<{ items: MemberListItem[] }>(`/members?q=${encodeURIComponent(term)}&limit=8`), enabled: term.trim().length >= 2 && !member });
  const [error, setError] = useState<string>();
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api(`/inventory/${item.id}/loans`, { method: 'POST', body: { memberId: member?.id, quantity: Number(f.get('quantity') || 1), lentOn: f.get('lentOn'), dueOn: f.get('dueOn') || null } });
      await qc.invalidateQueries({ queryKey: ['inventory'] });
      onClose();
    } catch (err) {
      setError(problemText(err));
    }
  }
  return (
    <Sheet title={`Ausleihen: ${item.name}`} open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e)}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {member ? (
          <div className="field"><span className="label">An</span><div className="inline-edit">{displayName(member)} <button type="button" className="btn btn-ghost" onClick={() => setMember(null)}>ändern</button></div></div>
        ) : (
          <div className="field">
            <label htmlFor="lend-pick">Mitglied suchen</label>
            <input id="lend-pick" className="input" autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name oder Nummer" />
            <ul className="timeline">{found.data?.items.map((m) => <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}><span>{displayName(m)}</span><button type="button" className="btn btn-ghost" aria-label={`${displayName(m)} wählen`} onClick={() => setMember(m)}>wählen</button></li>)}</ul>
          </div>
        )}
        <div className="form-row">
          <Field label="Anzahl" name="quantity" type="number" min={1} max={item.available} defaultValue={1} />
          <Field label="Ausgeliehen am" name="lentOn" type="date" defaultValue={todayLocal()} />
        </div>
        <Field label="Zurück bis (optional)" name="dueOn" type="date" />
        <div className="actions-row"><button className="btn btn-primary" disabled={!member}>Ausleihen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}
