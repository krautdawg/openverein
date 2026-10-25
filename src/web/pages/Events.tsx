import { useMemo, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useParams, useSearchParams } from 'react-router';
import { Cake, ChevronLeft, ChevronRight, Link2, Plus, Upload } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { PARTICIPATION_LABEL, type Calendar, type Occurrence, type OccurrenceDetail } from '../../shared/events.ts';
import { euro } from '../../shared/fees.ts';
import { COLOR_LABEL, COURT_COLORS } from '../../shared/groups.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { Field } from '../components/Field.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { courtVar, todayLocal, useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

const MONTHS = ['Januar', 'Februar', 'März', 'April', 'Mai', 'Juni', 'Juli', 'August', 'September', 'Oktober', 'November', 'Dezember'];
const WEEKDAYS = ['Mo', 'Di', 'Mi', 'Do', 'Fr', 'Sa', 'So'];
const DAY_CODES = ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'] as const;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const time = (s: string) => s.slice(11, 16);
const longDate = (date: string) => new Date(`${date}T12:00:00Z`).toLocaleDateString('de-DE', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

function monthGrid(month: string) {
  const first = new Date(`${month}-01T00:00:00Z`);
  const start = new Date(first.getTime() - ((first.getUTCDay() + 6) % 7) * 86_400_000);
  return Array.from({ length: 42 }, (_, i) => iso(new Date(start.getTime() + i * 86_400_000)));
}

export function Events({ me }: { me: Me }) {
  useTitle('Termine');
  const canWrite = me.permissions.events === 'write';
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { id, date } = useParams();
  const month = params.get('monat') ?? todayLocal().slice(0, 7);
  const view = params.get('ansicht') ?? 'monat';
  const [showBirthdays, setShowBirthdays] = useState(false);
  const [creating, setCreating] = useState<string | null>(null);
  const [managing, setManaging] = useState(false);
  const grid = useMemo(() => monthGrid(month), [month]);
  const from = view === 'liste' ? `${month}-01` : grid[0]!;
  const to = view === 'liste' ? iso(new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0))) : grid[41]!;
  const calendars = useQuery({ queryKey: ['calendars'], queryFn: () => api<Calendar[]>('/calendars') });
  const events = useQuery({ queryKey: ['events', from, to], queryFn: () => api<Occurrence[]>(`/events?from=${from}&to=${to}`) });
  const birthdays = useQuery({ queryKey: ['birthdays', from, to], queryFn: () => api<{ memberId: string; name: string; date: string; age: number }[]>(`/birthdays?from=${from}&to=${to}`), enabled: showBirthdays && me.permissions.members !== 'none' });
  const byDate = useMemo(() => {
    const m = new Map<string, Occurrence[]>();
    for (const o of events.data ?? []) m.set(o.date, [...(m.get(o.date) ?? []), o]);
    return m;
  }, [events.data]);
  const today = todayLocal();

  const go = (delta: number) => {
    const d = new Date(`${month}-01T00:00:00Z`);
    d.setUTCMonth(d.getUTCMonth() + delta);
    const n = new URLSearchParams(params);
    n.set('monat', iso(d).slice(0, 7));
    setParams(n, { replace: true });
  };
  const setView = (v: string) => {
    const n = new URLSearchParams(params);
    n.set('ansicht', v);
    setParams(n, { replace: true });
  };
  const open = (o: Occurrence) => navigate({ pathname: `/termine/${o.eventId}/${o.date}`, search: params.toString() });

  return (
    <div className="page">
      <PageHead
        title="Termine"
        intro="Trainings, Spiele und Sitzungen. Jeder Kalender hat eine Linienfarbe und ist nur für die Gruppen sichtbar, die Du festlegst."
        actions={
          <>
            {canWrite && <button className="btn" onClick={() => setManaging(true)}>Kalender</button>}
            {canWrite && calendars.data && calendars.data.length > 0 && <button className="btn btn-primary" onClick={() => setCreating(today)}><Plus size={16} aria-hidden /> Termin anlegen</button>}
          </>
        }
      />
      <div className="toolbar">
        <div className="inline-edit" style={{ gap: 'var(--s-1)' }}>
          <button className="icon-btn" aria-label="Vorheriger Monat" onClick={() => go(-1)}><ChevronLeft size={18} /></button>
          <h2 style={{ minWidth: '10ch', textAlign: 'center' }} aria-live="polite">{MONTHS[Number(month.slice(5, 7)) - 1]} {month.slice(0, 4)}</h2>
          <button className="icon-btn" aria-label="Nächster Monat" onClick={() => go(1)}><ChevronRight size={18} /></button>
          {month !== today.slice(0, 7) && <button className="btn btn-ghost" onClick={() => { const n = new URLSearchParams(params); n.delete('monat'); setParams(n, { replace: true }); }}>Heute</button>}
        </div>
        <span style={{ flex: 1 }} />
        <div className="segmented" role="group" aria-label="Ansicht">
          <button aria-pressed={view !== 'liste'} onClick={() => setView('monat')}>Monat</button>
          <button aria-pressed={view === 'liste'} onClick={() => setView('liste')}>Liste</button>
        </div>
        {me.permissions.members !== 'none' && <label className="check"><input type="checkbox" checked={showBirthdays} onChange={(e) => setShowBirthdays(e.target.checked)} /> Geburtstage</label>}
      </div>

      {calendars.data?.length === 0 ? (
        <div className="table-wrap"><div className="empty-state"><h3>Noch kein Kalender.</h3><p>Leg zuerst einen Kalender an, zum Beispiel „Training“ für alle oder „Vorstand“ nur für den Vorstand.</p>{canWrite && <button className="btn btn-primary" onClick={() => setManaging(true)}>Kalender anlegen</button>}</div></div>
      ) : view === 'liste' ? (
        <div className="agenda">
          {[...byDate.keys(), ...(birthdays.data ?? []).map((b) => b.date)].filter((v, i, a) => a.indexOf(v) === i).sort().map((d) => (
            <section key={d} className="agenda-day" aria-label={longDate(d)}>
              <h3 data-today={d === today}>{longDate(d)}</h3>
              <ul>
                {(birthdays.data ?? []).filter((b) => b.date === d).map((b) => <li key={b.memberId} className="agenda-item muted"><Cake size={14} aria-hidden /> {b.name} wird {b.age}</li>)}
                {(byDate.get(d) ?? []).map((o) => (
                  <li key={o.eventId + o.date}>
                    <button className="agenda-item" style={courtVar(o.color)} onClick={() => open(o)}>
                      <span className="when num">{o.allDay ? 'ganztägig' : `${time(o.startsAt)}–${time(o.endsAt)}`}</span>
                      <span className="what">{o.title}{o.location && <span className="muted"> · {o.location}</span>}</span>
                      {o.maxParticipants !== null || o.counts.yes > 0 ? <span className="meta num">{o.counts.yes}{o.maxParticipants !== null && ` / ${o.maxParticipants}`} Zusagen</span> : null}
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {events.data && events.data.length === 0 && <p className="muted">Keine Termine in diesem Monat.</p>}
        </div>
      ) : (
        <div className="month" role="group" aria-label={`${MONTHS[Number(month.slice(5, 7)) - 1]} ${month.slice(0, 4)}`}>
          {/* Weekday heads are visual only; each day says its weekday to screen readers. */}
          {WEEKDAYS.map((w) => <div key={w} className="month-head" aria-hidden>{w}</div>)}
          {grid.map((d) => (
            <div key={d} className="month-day" data-other={d.slice(0, 7) !== month} data-today={d === today} onDoubleClick={() => canWrite && setCreating(d)}>
              <span className="month-date num"><span className="sr-only">{WEEKDAYS[(new Date(`${d}T00:00:00Z`).getUTCDay() + 6) % 7]}, </span>{Number(d.slice(8))}</span>
              {(birthdays.data ?? []).filter((b) => b.date === d).map((b) => <span key={b.memberId} className="month-birthday" title={`${b.name} wird ${b.age}`}><Cake size={12} aria-hidden /> {b.name.split(', ').reverse().join(' ')}</span>)}
              {(byDate.get(d) ?? []).slice(0, 4).map((o) => (
                <button key={o.eventId} className="month-event" style={courtVar(o.color)} onClick={() => open(o)}>
                  {!o.allDay && <span className="num">{time(o.startsAt)}</span>} {o.title}
                </button>
              ))}
              {(byDate.get(d)?.length ?? 0) > 4 && <button className="month-more" onClick={() => setView('liste')}>+{byDate.get(d)!.length - 4} weitere</button>}
            </div>
          ))}
        </div>
      )}

      <OccurrenceSheet id={id ?? null} date={date ?? null} canWrite={canWrite} onClose={() => navigate({ pathname: '/termine', search: params.toString() })} />
      {creating && calendars.data && <CreateEvent calendars={calendars.data} date={creating} onClose={() => setCreating(null)} onCreated={(o) => { setCreating(null); open(o); }} />}
      {managing && <CalendarsSheet calendars={calendars.data ?? []} onClose={() => setManaging(false)} />}
    </div>
  );
}

function CreateEvent({ calendars, date, onClose, onCreated }: { calendars: Calendar[]; date: string; onClose: () => void; onCreated: (o: Occurrence) => void }) {
  const qc = useQueryClient();
  const [repeat, setRepeat] = useState<'none' | 'weekly' | 'biweekly' | 'monthly'>('none');
  const [allDay, setAllDay] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [day, setDay] = useState(date);
  const weekday = DAY_CODES[(new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7]!;

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const day = String(f.get('date'));
    const body = {
      calendarId: f.get('calendarId'),
      title: f.get('title'),
      location: f.get('location') || null,
      description: f.get('description') || null,
      allDay,
      startsAt: `${day}T${allDay ? '00:00' : f.get('start')}`,
      endsAt: `${day}T${allDay ? '23:59' : f.get('end')}`,
      recurrence: repeat === 'none' ? null : { freq: repeat === 'monthly' ? 'MONTHLY' : 'WEEKLY', interval: repeat === 'biweekly' ? 2 : 1, byDay: repeat === 'monthly' ? [] : f.getAll('byDay'), until: f.get('until') || null },
      maxParticipants: f.get('max') ? Number(f.get('max')) : null,
      priceCents: f.get('priceCents') && f.get('priceCents') !== '0' ? Number(f.get('priceCents')) : null,
    };
    setError(undefined);
    try {
      const o = await api<Occurrence>('/events', { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['events'] });
      onCreated(o);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <Sheet title="Termin anlegen" open onClose={onClose}>
      <form className="form" noValidate onSubmit={submit}>
        {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.detail ?? error.problem.title}</div>}
        <Field label="Titel" name="title" required autoFocus placeholder="Training U17" />
        <div className="field">
          <label htmlFor="cal">Kalender</label>
          <select id="cal" name="calendarId" className="select" style={{ width: '100%' }}>{calendars.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}</select>
        </div>
        <div className="form-row">
          <Field label="Datum" name="date" type="date" value={day} onChange={(e) => e.target.value && setDay(e.target.value)} />
          <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" checked={allDay} onChange={(e) => setAllDay(e.target.checked)} /> Ganztägig</label>
        </div>
        {!allDay && (
          <div className="form-row">
            <Field label="Beginn" name="start" type="time" defaultValue="18:00" />
            <Field label="Ende" name="end" type="time" defaultValue="19:30" error={error?.fieldError('endsAt')} />
          </div>
        )}
        <Field label="Ort" name="location" placeholder="Sporthalle, Feld 2" />
        <div className="field">
          <label htmlFor="rep">Wiederholen</label>
          <select id="rep" className="select" style={{ width: '100%' }} value={repeat} onChange={(e) => setRepeat(e.target.value as typeof repeat)}>
            <option value="none">Nicht wiederholen</option>
            <option value="weekly">Jede Woche</option>
            <option value="biweekly">Alle zwei Wochen</option>
            <option value="monthly">Jeden Monat am gleichen Tag</option>
          </select>
        </div>
        {(repeat === 'weekly' || repeat === 'biweekly') && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">An diesen Tagen</legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--s-3)' }}>
              {DAY_CODES.map((c, i) => <label key={`${c}-${weekday}`} className="check"><input type="checkbox" name="byDay" value={c} defaultChecked={c === weekday} /> {WEEKDAYS[i]}</label>)}
            </div>
          </fieldset>
        )}
        {repeat !== 'none' && <Field label="Bis (optional)" name="until" type="date" hint="Ohne Enddatum läuft die Serie weiter, bis Du sie beendest." />}
        <div className="form-row">
          <Field label="Höchstens Teilnehmende" name="max" type="number" min={1} hint="Leer: unbegrenzt. Weitere Zusagen kommen auf die Warteliste." />
          <MoneyField label="Teilnahmegebühr (optional)" name="priceCents" hint="Mit Gebühr erhält jede Zusage eine Rechnung." />
        </div>
        <div className="field"><label htmlFor="desc">Beschreibung</label><textarea id="desc" name="description" className="textarea" /></div>
        <div className="actions-row"><button className="btn btn-primary">Anlegen</button><button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button></div>
      </form>
    </Sheet>
  );
}

function OccurrenceSheet({ id, date, canWrite, onClose }: { id: string | null; date: string | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { data: o, error: loadError } = useQuery({ queryKey: ['occurrence', id, date], queryFn: () => api<OccurrenceDetail>(`/events/${id}/occurrences/${date}`), enabled: !!id && !!date });
  const [term, setTerm] = useState('');
  const found = useQuery({ queryKey: ['member-pick', term], queryFn: () => api<{ items: MemberListItem[] }>(`/members?q=${encodeURIComponent(term)}&limit=6`), enabled: term.length >= 2 });
  const [error, setError] = useState<string>();
  const [cancelling, setCancelling] = useState(false);
  const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
  const started = !!o && o.startsAt <= now;

  async function rsvp(memberId: string, status: string) {
    setError(undefined);
    try {
      qc.setQueryData(['occurrence', id, date], await api<OccurrenceDetail>(`/events/${id}/occurrences/${date}/participants/${memberId}`, { method: 'PUT', body: { status } }));
      void qc.invalidateQueries({ queryKey: ['events'] });
      setTerm('');
    } catch (e) {
      setError(e instanceof ApiError ? [e.problem.title, e.problem.detail].filter(Boolean).join(' ') : String(e));
    }
  }

  async function cancel(scope: 'this' | 'following' | 'all') {
    try {
      await api(`/events/${id}`, { method: 'DELETE', body: { scope, date } });
      await qc.invalidateQueries({ queryKey: ['events'] });
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.title : String(e));
    }
  }

  return (
    <Sheet title={o?.title ?? 'Termin'} open={!!id && !!date} onClose={() => { setCancelling(false); onClose(); }}>
      {loadError && <div className="alert alert-error">{(loadError as Error).message}</div>}
      {o && (
        <>
          <div className="sheet-sub" style={{ marginTop: 'calc(-1 * var(--s-3))', marginBottom: 'var(--s-5)' }}>
            <span className="court" style={courtVar(o.color)}>{o.calendarName}</span>
            {o.recurring && <span className="pill">Serie</span>}
          </div>
          {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-3)' }}>{error}</div>}
          <section className="sheet-section">
            <dl className="facts">
              <dt>Wann</dt><dd>{longDate(o.date)}{!o.allDay && `, ${time(o.startsAt)}–${time(o.endsAt)} Uhr`}</dd>
              {o.location && (<><dt>Wo</dt><dd>{o.location}</dd></>)}
              {o.maxParticipants !== null && (<><dt>Plätze</dt><dd className="num">{o.counts.yes + o.counts.attended} von {o.maxParticipants} belegt{o.counts.waitlist > 0 && `, ${o.counts.waitlist} auf der Warteliste`}</dd></>)}
              {o.priceCents ? (<><dt>Gebühr</dt><dd className="num">{euro(o.priceCents)} je Zusage (Rechnung automatisch)</dd></>) : null}
            </dl>
            {o.description && <p style={{ marginTop: 'var(--s-4)', whiteSpace: 'pre-wrap', maxWidth: '65ch' }}>{o.description}</p>}
          </section>

          {(o.rsvp || started) && (
            <section className="sheet-section" aria-labelledby="ptc">
              <h3 id="ptc">{started ? 'Anwesenheit' : 'Rückmeldungen'}</h3>
              <p className="meta" style={{ marginBottom: 'var(--s-3)' }}>{o.counts.yes} Zusagen · {o.counts.maybe} vielleicht · {o.counts.no} Absagen{started && ` · ${o.counts.attended} anwesend`}</p>
              <ul className="timeline">
                {o.participants.map((p) => (
                  <li key={p.memberId} style={{ gridTemplateColumns: '1fr auto' }}>
                    <span>{p.name} <span className="pill" style={{ marginLeft: 4 }}>{PARTICIPATION_LABEL[p.status]}</span>{p.invoiceId && <div className="meta"><a href={`/rechnungen/${p.invoiceId}`} onClick={(e) => { e.preventDefault(); navigate(`/rechnungen/${p.invoiceId}`); }}>Rechnung ansehen</a></div>}</span>
                    {canWrite && (
                      <span className="segmented" role="group" aria-label={`Status für ${p.name}`}>
                        {(started ? (['attended', 'not_attended'] as const) : (['yes', 'maybe', 'no'] as const)).map((s) => (
                          <button key={s} aria-pressed={p.status === s} onClick={() => void rsvp(p.memberId, s)}>{PARTICIPATION_LABEL[s]}</button>
                        ))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {canWrite && (
                <div className="field" style={{ marginTop: 'var(--s-3)' }}>
                  <label htmlFor="add-p">{started ? 'Anwesende hinzufügen' : 'Rückmeldung für ein Mitglied eintragen'}</label>
                  <input id="add-p" className="input" value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name suchen" />
                  {term.length >= 2 && (
                    <ul className="timeline">
                      {found.data?.items.filter((m) => !o.participants.some((p) => p.memberId === m.id)).map((m) => (
                        <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}>
                          <span>{displayName(m)}</span>
                          <button className="btn" onClick={() => void rsvp(m.id, started ? 'attended' : 'yes')}>{started ? 'Anwesend' : 'Zusage'}</button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
              )}
            </section>
          )}

          {canWrite && (
            <section className="sheet-section">
              {!cancelling ? (
                <button className="btn btn-ghost btn-danger" onClick={() => setCancelling(true)}>Termin absagen …</button>
              ) : (
                <div className="inline-form">
                  <p>{o.recurring ? 'Was soll abgesagt werden?' : 'Termin wirklich absagen? Rückmeldungen gehen verloren.'}</p>
                  <div className="actions-row" style={{ marginTop: 0 }}>
                    {o.recurring && <button className="btn btn-danger" onClick={() => void cancel('this')}>Nur diesen</button>}
                    {o.recurring && <button className="btn btn-danger" onClick={() => void cancel('following')}>Diesen und alle folgenden</button>}
                    <button className="btn btn-danger" onClick={() => void cancel('all')}>{o.recurring ? 'Die ganze Serie' : 'Absagen'}</button>
                    <button className="btn btn-ghost" onClick={() => setCancelling(false)}>Abbrechen</button>
                  </div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </Sheet>
  );
}

function CalendarsSheet({ calendars, onClose }: { calendars: Calendar[]; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: groups } = useGroups();
  const [error, setError] = useState<ApiError>();
  const [feed, setFeed] = useState<{ id: string; url: string }>();
  const [imported, setImported] = useState<{ id: string; text: string; notes: { title: string; note: string }[] }>();

  async function importIcs(id: string, file: File) {
    try {
      const r = await api<{ imported: number; duplicates: number; notes: { title: string; note: string }[] }>(`/calendars/${id}/import`, { method: 'POST', body: { content: await file.text() } });
      setImported({ id, text: `${r.imported === 1 ? 'Ein Termin' : `${r.imported} Termine`} übernommen${r.duplicates ? `, ${r.duplicates === 1 ? 'einer war' : `${r.duplicates} waren`} schon da` : ''}.`, notes: r.notes });
      await qc.invalidateQueries({ queryKey: ['events'] });
    } catch (err) {
      setImported({ id, text: err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Die Datei ließ sich nicht lesen.', notes: [] });
    }
  }

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const ids = f.getAll('groups');
      await api('/calendars', { method: 'POST', body: { name: f.get('name'), color: f.get('color'), groupIds: ids.length ? ids : null } });
      await qc.invalidateQueries({ queryKey: ['calendars'] });
      e.currentTarget?.reset();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  async function makeFeed(id: string) {
    const r = await api<{ path: string }>(`/calendars/${id}/feed`, { method: 'POST' });
    setFeed({ id, url: `${window.location.origin}${r.path}` });
    await qc.invalidateQueries({ queryKey: ['calendars'] });
  }

  return (
    <Sheet title="Kalender" open onClose={onClose}>
      <ul className="timeline">
        {calendars.map((c) => (
          <li key={c.id} style={{ gridTemplateColumns: '1fr' }}>
            <span>
              <span className="court" style={courtVar(c.color)}>{c.name}</span>
              <div className="meta">{c.groupIds ? `Nur für ${c.groupIds.map((g) => groups?.find((x) => x.id === g)?.name ?? '…').join(', ')}` : 'Für alle Mitglieder'}</div>
              <span className="actions-inline" style={{ marginTop: 'var(--s-1)' }}>
                <button className="btn btn-ghost" style={{ paddingLeft: 0 }} onClick={() => void makeFeed(c.id)}><Link2 size={16} aria-hidden /> {c.hasFeed ? 'Neuer Abo-Link' : 'Abo-Link'}</button>
                <label className="btn btn-ghost">
                  <Upload size={16} aria-hidden /> ICS importieren
                  <input type="file" accept=".ics,text/calendar" hidden aria-label={`ICS-Datei in ${c.name} importieren`} onChange={(e) => { const f = e.target.files?.[0]; if (f) void importIcs(c.id, f); e.target.value = ''; }} />
                </label>
              </span>
              {feed?.id === c.id && <div className="token-once" style={{ marginTop: 'var(--s-2)' }}>{feed.url}</div>}
              {imported?.id === c.id && (
                <div role="status" className="meta" style={{ marginTop: 'var(--s-2)' }}>
                  {imported.text}
                  {imported.notes.length > 0 && <ul style={{ margin: 'var(--s-1) 0 0', paddingLeft: '1.2em' }}>{imported.notes.slice(0, 8).map((n, i) => <li key={i}>{n.title}: {n.note}</li>)}</ul>}
                </div>
              )}
              <PublicCalendar c={c} />
            </span>
          </li>
        ))}
      </ul>
      {feed && <p className="meta">Diesen Link in Google, Apple oder Outlook als Kalender-Abo eintragen. Ein neuer Link macht den alten ungültig.</p>}
      <form className="inline-form" noValidate onSubmit={create} aria-label="Neuer Kalender">
        <h3>Neuer Kalender</h3>
        {error && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
        <div className="form-row">
          <Field label="Name" name="name" required placeholder="Training" error={error?.fieldError('name')} />
          <div className="field">
            <label htmlFor="cc">Linienfarbe</label>
            <select id="cc" name="color" className="select" style={{ width: '100%' }}>{COURT_COLORS.map((c) => <option key={c} value={c}>{COLOR_LABEL[c]}</option>)}</select>
          </div>
        </div>
        {groups && groups.length > 0 && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Sichtbar für <span className="meta">(nichts gewählt = alle Mitglieder)</span></legend>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--s-4)' }}>{groups.map((g) => <label key={g.id} className="check"><input type="checkbox" name="groups" value={g.id} /> {g.name}</label>)}</div>
          </fieldset>
        )}
        <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Kalender anlegen</button></div>
      </form>
    </Sheet>
  );
}

/** Website widget: make a calendar public and copy the embed code. */
function PublicCalendar({ c }: { c: Calendar }) {
  const qc = useQueryClient();
  const [origins, setOrigins] = useState(c.publicOrigins.join(', '));
  const [error, setError] = useState<string>();
  async function save(body: { public?: boolean; publicOrigins?: string[] }) {
    setError(undefined);
    try {
      await api(`/calendars/${c.id}`, { method: 'PATCH', body });
      await qc.invalidateQueries({ queryKey: ['calendars'] });
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.map((x) => x.message).join(' ') ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  }
  const src = `${window.location.origin}/widget/termine/${c.id}`;
  if (c.groupIds) return null;
  return (
    <div style={{ marginTop: 'var(--s-2)' }}>
      <label className="check"><input type="checkbox" checked={c.public} onChange={(e) => void save({ public: e.target.checked })} /> Öffentlich auf der Vereinswebsite zeigen (ohne Beschreibung und Teilnehmende)</label>
      {c.public && (
        <div className="form" style={{ marginTop: 'var(--s-2)' }}>
          <div className="field">
            <label htmlFor={`orig-${c.id}`}>Websites, die einbetten dürfen</label>
            <input id={`orig-${c.id}`} className="input" placeholder="https://www.mein-verein.de" value={origins} onChange={(e) => setOrigins(e.target.value)} onBlur={() => void save({ publicOrigins: origins.split(/[\s,]+/).filter(Boolean) })} />
          </div>
          {error && <span className="error" role="alert">{error}</span>}
          <div className="token-once">{`<iframe src="${src}" title="Termine" style="border:0;width:100%;height:480px"></iframe>`}</div>
        </div>
      )}
    </div>
  );
}
