import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Download, Plus, Search } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { displayName, type MemberDetail, type MemberListItem } from '../../shared/members.ts';
import { CustomInputs, readCustom, useCustomFields } from '../components/CustomFields.tsx';
import { Field } from '../components/Field.tsx';
import { GroupBadge } from '../components/GroupBadge.tsx';
import { MemberSheet } from '../components/MemberSheet.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { StatusBadge } from '../components/StatusBadge.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal, useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

type List = { items: MemberListItem[]; total: number; nextCursor: string | null };

const VIEWS = [
  { key: 'current', label: 'Aktuell', params: {} },
  { key: 'active', label: 'Aktiv', params: { status: 'active' } },
  { key: 'applicant', label: 'Anträge', params: { status: 'applicant' } },
  { key: 'resigned', label: 'Gekündigt', params: { status: 'resigned' } },
  { key: 'former', label: 'Ehemalige', params: { status: 'former' } },
] as const;

export function Members({ me }: { me: Me }) {
  useTitle('Mitglieder');
  const canWrite = me.permissions.members === 'write';
  const navigate = useNavigate();
  const { id: openId } = useParams();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const view = (params.get('ansicht') ?? 'current') as (typeof VIEWS)[number]['key'];
  const groupId = params.get('gruppe') ?? '';
  const [search, setSearch] = useState(q);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(params.get('neu') === '1');
  const searchRef = useRef<HTMLInputElement>(null);
  const { data: groups } = useGroups();

  // Debounced search into the URL, so views are shareable and survive reloads.
  useEffect(() => {
    const t = setTimeout(() => {
      if (search === q) return;
      const next = new URLSearchParams(params);
      if (search) next.set('q', search);
      else next.delete('q');
      setParams(next, { replace: true });
    }, 200);
    return () => clearTimeout(t);
  }, [search, q, params, setParams]);

  // "/" focuses search, "n" opens the create sheet.
  useEffect(() => {
    const onKey = (e: globalThis.KeyboardEvent) => {
      const typing = (e.target as HTMLElement).closest('input, textarea, select, dialog');
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '/') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'n' && canWrite) { e.preventDefault(); setCreating(true); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [canWrite]);

  const query = useMemo(() => {
    const p = new URLSearchParams();
    if (q) p.set('q', q);
    const v = VIEWS.find((x) => x.key === view) ?? VIEWS[0];
    for (const [k, val] of Object.entries(v.params)) p.set(k, val);
    if (groupId) p.set('groupId', groupId);
    return p.toString();
  }, [q, view, groupId]);

  const list = useInfiniteQuery({
    queryKey: ['members', query],
    queryFn: ({ pageParam }) => api<List>(`/members?${query}&limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const total = list.data?.pages[0]?.total ?? 0;

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set(key, value);
    else next.delete(key);
    setParams(next, { replace: true });
    setSelected(new Set());
  };

  const open = (id: string) => navigate({ pathname: `/mitglieder/${id}`, search: params.toString() });
  const close = () => navigate({ pathname: '/mitglieder', search: params.toString() });

  function rowKeys(e: KeyboardEvent<HTMLTableRowElement>, id: string) {
    const row = e.currentTarget;
    if (e.key === 'Enter') open(id);
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); (row.nextElementSibling as HTMLElement | null)?.focus(); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); (row.previousElementSibling as HTMLElement | null)?.focus(); }
    if (e.key === ' ' && canWrite) { e.preventDefault(); toggle(id); }
  }

  const toggle = (id: string) => setSelected((s) => { const n = new Set(s); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const allSelected = rows.length > 0 && rows.every((r) => selected.has(r.id));
  const exportHref = `/api/v1/members/export.csv?${query}`;

  return (
    <div className="page">
      <PageHead
        title="Mitglieder"
        intro={list.data ? `${total} ${total === 1 ? 'Eintrag' : 'Einträge'} in dieser Ansicht.` : ' '}
        actions={
          <>
            <a className="btn" href={exportHref} download><Download size={16} aria-hidden /> CSV</a>
            {canWrite && <button className="btn btn-primary" onClick={() => setCreating(true)} aria-keyshortcuts="n"><Plus size={16} aria-hidden /> Mitglied anlegen</button>}
          </>
        }
      />

      <div className="toolbar" role="search">
        <div className="search">
          <Search size={16} aria-hidden />
          <input ref={searchRef} className="input" type="search" aria-label="Mitglieder suchen" placeholder="Name, Nummer, Ort, E-Mail" value={search} onChange={(e) => setSearch(e.target.value)} />
          {!search && <kbd aria-hidden>/</kbd>}
        </div>
        <div className="segmented" role="group" aria-label="Ansicht">
          {VIEWS.map((v) => <button key={v.key} aria-pressed={view === v.key} onClick={() => setParam('ansicht', v.key === 'current' ? '' : v.key)}>{v.label}</button>)}
        </div>
        <select className="select" aria-label="Nach Gruppe filtern" value={groupId} onChange={(e) => setParam('gruppe', e.target.value)}>
          <option value="">Alle Gruppen</option>
          {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
      </div>

      {selected.size > 0 && <BulkBar ids={[...selected]} onDone={() => { setSelected(new Set()); void list.refetch(); }} />}

      {list.isError && <div className="alert alert-error" role="alert">{(list.error as Error).message}</div>}
      {list.data && rows.length === 0 ? (
        <div className="table-wrap">
          <div className="empty-state">
            {q || groupId || view !== 'current' ? (
              <>
                <h3>Niemand gefunden.</h3>
                <p>Keine Treffer für diese Suche oder diesen Filter. Ehemalige Mitglieder findest Du unter „Ehemalige“.</p>
                <button className="btn" onClick={() => { setSearch(''); setParams(new URLSearchParams(), { replace: true }); }}>Filter zurücksetzen</button>
              </>
            ) : (
              <>
                <h3>Noch keine Mitglieder.</h3>
                <p>Lege das erste Mitglied an. Später kannst Du Deine bisherige Liste auch importieren.</p>
                {canWrite && <button className="btn btn-primary" onClick={() => setCreating(true)}>Mitglied anlegen</button>}
              </>
            )}
          </div>
        </div>
      ) : (
        <div className="table-wrap">
          <table className="table" aria-label="Mitglieder" aria-rowcount={total}>
            <thead>
              <tr>
                {canWrite && <th className="cb"><input type="checkbox" aria-label="Alle sichtbaren auswählen" checked={allSelected} onChange={() => setSelected(allSelected ? new Set() : new Set(rows.map((r) => r.id)))} /></th>}
                <th scope="col">Name</th>
                <th scope="col" className="hide-sm num">Nr.</th>
                <th scope="col">Gruppen</th>
                <th scope="col">Status</th>
                <th scope="col" className="hide-sm num">Eintritt</th>
                <th scope="col" className="hide-sm">Ort</th>
              </tr>
            </thead>
            <tbody>
              {!list.data && Array.from({ length: 6 }, (_, i) => <tr key={i}><td colSpan={7}><div className="skeleton" style={{ width: `${40 + (i % 3) * 15}%` }} /></td></tr>)}
              {rows.map((r) => (
                <tr key={r.id} data-href tabIndex={0} aria-selected={selected.has(r.id)} onClick={(e) => !(e.target as HTMLElement).closest('input') && open(r.id)} onKeyDown={(e) => rowKeys(e, r.id)}>
                  {canWrite && <td className="cb"><input type="checkbox" aria-label={`${displayName(r)} auswählen`} checked={selected.has(r.id)} onChange={() => toggle(r.id)} /></td>}
                  <td><span className="name">{displayName(r)}</span></td>
                  <td className="hide-sm num">{r.membershipNumber}</td>
                  <td><span className="groups">{r.groups.map((g) => <GroupBadge key={g.id} name={g.name} color={g.color} />)}</span></td>
                  <td><StatusBadge status={r.status} /></td>
                  <td className="hide-sm num">{formatDate(r.joinDate)}</td>
                  <td className="hide-sm">{r.city}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {list.data && rows.length > 0 && (
        <div className="table-foot">
          <span>{rows.length} von {total} angezeigt</span>
          {list.hasNextPage && <button className="btn" onClick={() => void list.fetchNextPage()} aria-busy={list.isFetchingNextPage}>Weitere laden</button>}
        </div>
      )}

      <MemberSheet id={openId ?? null} onClose={close} canWrite={canWrite} permissions={me.permissions} />
      {creating && <CreateMember onClose={() => setCreating(false)} onCreated={(id) => { setCreating(false); open(id); }} />}
    </div>
  );
}

function BulkBar({ ids, onDone }: { ids: string[]; onDone: () => void }) {
  const { data: groups } = useGroups();
  const [result, setResult] = useState<string>();
  async function run(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const action = (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value');
    const r = await api<{ succeeded: number; skipped: { reason: string }[] }>('/members/bulk', { method: 'POST', body: { ids, action, groupId: f.get('groupId'), date: f.get('date') } });
    setResult(`${r.succeeded} geändert${r.skipped.length ? `, ${r.skipped.length} übersprungen (${[...new Set(r.skipped.map((s) => s.reason))].join(' ')})` : ''}.`);
    onDone();
  }
  return (
    <>
      <form className="bulkbar" onSubmit={run} aria-label="Sammelaktion">
        <strong>{ids.length} ausgewählt</strong>
        <select name="groupId" className="select" aria-label="Gruppe" required>
          {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
        </select>
        <input name="date" type="date" className="input" aria-label="Stichtag" defaultValue={todayLocal()} required />
        <button className="btn btn-primary" value="add_to_group">Zur Gruppe hinzufügen</button>
        <button className="btn" value="end_group">Gruppe beenden</button>
      </form>
      {result && <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-3)' }}>{result}</div>}
    </>
  );
}

function CreateMember({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const { data: groups } = useGroups();
  const [kind, setKind] = useState<'natural' | 'organisation'>('natural');
  const { data: customFields } = useCustomFields();
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body: Record<string, unknown> = { kind, groupIds: f.getAll('groupIds') };
    for (const k of ['firstName', 'lastName', 'companyName', 'email', 'street', 'postalCode', 'city', 'joinDate', 'birthDate']) {
      const v = f.get(k);
      if (typeof v === 'string' && v) body[k] = v;
    }
    if (f.get('applicant') === 'on') delete body.joinDate;
    if (customFields?.length) body.custom = readCustom(f, customFields.filter((x) => x.required));
    setBusy(true);
    setError(undefined);
    try {
      const m = await api<MemberDetail>('/members', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['members'] });
      void qc.invalidateQueries({ queryKey: ['overview'] });
      onCreated(m.id);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet title="Mitglied anlegen" open onClose={onClose}>
      <form id="create-member" className="form" onSubmit={submit} noValidate>
        {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
        <div className="segmented" role="group" aria-label="Art">
          <button type="button" aria-pressed={kind === 'natural'} onClick={() => setKind('natural')}>Person</button>
          <button type="button" aria-pressed={kind === 'organisation'} onClick={() => setKind('organisation')}>Firma oder Verein</button>
        </div>
        {kind === 'natural' ? (
          <div className="form-row">
            <Field label="Vorname" name="firstName" autoComplete="off" autoFocus />
            <Field label="Nachname" name="lastName" autoComplete="off" required error={error?.fieldError('lastName')} />
          </div>
        ) : (
          <Field label="Name der Firma oder des Vereins" name="companyName" required error={error?.fieldError('companyName')} />
        )}
        <Field label="E-Mail" name="email" type="email" error={error?.fieldError('email')} />
        <Field label="Straße und Hausnummer" name="street" />
        <div className="form-row">
          <Field label="PLZ" name="postalCode" inputMode="numeric" error={error?.fieldError('postalCode')} />
          <Field label="Ort" name="city" />
        </div>
        <div className="form-row">
          <Field label="Eintritt" name="joinDate" type="date" defaultValue={todayLocal()} error={error?.fieldError('joinDate')} />
          {kind === 'natural' && <Field label="Geburtsdatum" name="birthDate" type="date" error={error?.fieldError('birthDate')} />}
        </div>
        {customFields && <CustomInputs fields={customFields} only="required" error={error} />}
        <label className="check"><input type="checkbox" name="applicant" /> Erst als Antrag erfassen (noch nicht aufgenommen)</label>
        {groups && groups.length > 0 && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label" style={{ marginBottom: 'var(--s-1)' }}>Gruppen</legend>
            {groups.map((g) => <label key={g.id} className="check"><input type="checkbox" name="groupIds" value={g.id} /> {g.name}</label>)}
          </fieldset>
        )}
        <div className="actions-row">
          <button className="btn btn-primary" aria-busy={busy} disabled={busy}>Anlegen</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
        </div>
      </form>
    </Sheet>
  );
}
