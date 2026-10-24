import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { NavLink, useNavigate, useParams } from 'react-router';
import { Plus } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro, INTERVAL_LABEL, type Plan } from '../../shared/fees.ts';
import { Field } from '../components/Field.tsx';
import { InlineEdit } from '../components/InlineEdit.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

export function FeesLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="page">
      <PageHead title="Beiträge" intro="Beitragsarten mit Preisverlauf und die Beitragsläufe, die daraus Rechnungen machen. Jeder Lauf zeigt erst eine Vorschau." />
      <nav className="subnav" aria-label="Beiträge">
        <NavLink to="/beitraege" end>Beitragsarten</NavLink>
        <NavLink to="/beitraege/laeufe">Beitragsläufe</NavLink>
      </nav>
      {children}
    </div>
  );
}

const INTERVALS: [string, number | null][] = [['monatlich', 1], ['vierteljährlich', 3], ['halbjährlich', 6], ['jährlich', 12], ['alle 2 Jahre', 24], ['einmalig', null]];

function VersionFields({ error, defaults }: { error?: ApiError; defaults?: Plan['current'] }) {
  return (
    <>
      <div className="form-row">
        <MoneyField label="Betrag je Zeitraum" name="amountCents" defaultCents={defaults?.amountCents} error={error?.fieldError('version.amountCents') ?? error?.fieldError('amountCents')} />
        <div className="field">
          <label htmlFor="intervalMonths">Zeitraum</label>
          <select id="intervalMonths" name="intervalMonths" className="select" style={{ width: '100%' }} defaultValue={String(defaults?.intervalMonths ?? 12)}>
            {INTERVALS.map(([l, v]) => <option key={l} value={String(v)}>{l}</option>)}
          </select>
        </div>
      </div>
      <div className="form-row">
        <Field label="Gültig ab" name="validFrom" type="date" defaultValue={todayLocal().slice(0, 4) + '-01-01'} error={error?.fieldError('version.validFrom') ?? error?.fieldError('validFrom')} />
        <MoneyField label="Aufnahmegebühr (einmalig)" name="admissionFeeCents" defaultCents={defaults?.admissionFeeCents ?? 0} />
      </div>
      <div className="form-row">
        <div className="field">
          <label htmlFor="anchor">Zeiträume</label>
          <select id="anchor" name="anchor" className="select" style={{ width: '100%' }} defaultValue={defaults?.anchor ?? 'calendar'}>
            <option value="calendar">am Kalender ausgerichtet (Quartal, Jahr …)</option>
            <option value="entry">ab Eintritt gezählt</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="proration">Bei Eintritt im Zeitraum</label>
          <select id="proration" name="proration" className="select" style={{ width: '100%' }} defaultValue={defaults?.proration ?? 'month'}>
            <option value="month">anteilig nach Monaten</option>
            <option value="none">voller Betrag</option>
          </select>
        </div>
      </div>
    </>
  );
}

const versionFrom = (f: FormData) => ({
  validFrom: f.get('validFrom'),
  amountCents: Number(f.get('amountCents') || NaN),
  intervalMonths: f.get('intervalMonths') === 'null' ? null : Number(f.get('intervalMonths')),
  anchor: f.get('anchor'),
  proration: f.get('proration'),
  admissionFeeCents: f.get('admissionFeeCents') === '' ? 0 : Number(f.get('admissionFeeCents')),
});

export function FeePlans({ me }: { me: Me }) {
  useTitle('Beitragsarten');
  const qc = useQueryClient();
  const canWrite = me.permissions.fees === 'write';
  const [showRetired, setShowRetired] = useState(false);
  const plans = useQuery({ queryKey: ['fee-plans', showRetired], queryFn: () => api<Plan[]>(`/fee-plans${showRetired ? '?includeRetired=true' : ''}`) });
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<ApiError>();
  const navigate = useNavigate();
  const { id } = useParams();

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/fee-plans', { method: 'POST', body: { name: f.get('name'), version: versionFrom(f) } });
      await qc.invalidateQueries({ queryKey: ['fee-plans'] });
      setCreating(false);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <FeesLayout>
      <div className="toolbar">
        <label className="check"><input type="checkbox" checked={showRetired} onChange={(e) => setShowRetired(e.target.checked)} /> Stillgelegte zeigen</label>
        <span style={{ flex: 1 }} />
        {canWrite && !creating && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden /> Beitragsart anlegen</button>}
      </div>
      {creating && (
        <form className="inline-form" style={{ marginBottom: 'var(--s-5)', marginTop: 0 }} onSubmit={create} noValidate aria-label="Neue Beitragsart">
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <Field label="Name" name="name" placeholder="Erwachsene" autoFocus required error={error?.fieldError('name')} />
          <VersionFields error={error} />
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary">Anlegen</button>
            <button type="button" className="btn btn-ghost" onClick={() => setCreating(false)}>Abbrechen</button>
          </div>
        </form>
      )}
      <div className="table-wrap">
        {plans.data?.length === 0 ? (
          <div className="empty-state">
            <h3>Noch keine Beitragsarten.</h3>
            <p>Lege an, was in Deiner Beitragsordnung steht, zum Beispiel „Erwachsene, 120 € jährlich“. Preiserhöhungen bekommen später einfach einen neuen Preis ab einem Datum.</p>
          </div>
        ) : (
          <table className="table" aria-label="Beitragsarten">
            <thead><tr><th scope="col">Beitrag</th><th scope="col" className="num">Betrag</th><th scope="col">Zeitraum</th><th scope="col" className="num hide-sm">Mitglieder</th></tr></thead>
            <tbody>
              {plans.data?.map((p) => (
                <tr key={p.id} data-href tabIndex={0} onClick={() => navigate(`/beitraege/${p.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/beitraege/${p.id}`)}>
                  <td><span className="name">{p.name}</span>{p.status === 'retired' && <span className="pill" style={{ marginLeft: 8 }}>stillgelegt</span>}</td>
                  <td className="num">{p.current ? euro(p.current.amountCents) : '—'}</td>
                  <td>{p.current ? INTERVAL_LABEL(p.current.intervalMonths) : '—'}</td>
                  <td className="num hide-sm">{p.assignedMembers}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <PlanSheet plan={plans.data?.find((p) => p.id === id) ?? null} canWrite={canWrite} onClose={() => navigate('/beitraege')} />
    </FeesLayout>
  );
}

function PlanSheet({ plan, canWrite, onClose }: { plan: Plan | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError>();
  const refresh = () => qc.invalidateQueries({ queryKey: ['fee-plans'] });
  const call = async (fn: () => Promise<unknown>) => {
    setError(undefined);
    try {
      await fn();
      await refresh();
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
      return false;
    }
  };

  return (
    <Sheet title={plan?.name ?? 'Beitragsart'} open={!!plan} onClose={() => { setAdding(false); onClose(); }}>
      {plan && (
        <>
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <section className="sheet-section">
            <dl className="facts">
              <dt>Name</dt>
              <dd>{canWrite ? <InlineEdit label="Name" value={plan.name} onSave={(name) => api(`/fee-plans/${plan.id}`, { method: 'PATCH', body: { name } }).then(refresh)} /> : plan.name}</dd>
              <dt>Positionstext</dt>
              <dd>
                {canWrite ? <InlineEdit label="Positionstext" value={plan.lineText} onSave={(lineText) => api(`/fee-plans/${plan.id}`, { method: 'PATCH', body: { lineText } }).then(refresh)} /> : plan.lineText}
                <p className="meta">Platzhalter: {'{plan}'}, {'{period_start}'}, {'{period_end}'}, {'{member_number}'}</p>
              </dd>
              <dt>Mitglieder</dt>
              <dd>{plan.assignedMembers}</dd>
            </dl>
          </section>
          <section className="sheet-section" aria-labelledby="pv">
            <h3 id="pv">Preise</h3>
            <ol className="timeline">
              {[...plan.versions].reverse().map((v) => (
                <li key={v.id} style={{ gridTemplateColumns: '6.5rem 1fr' }}>
                  <time>ab {formatDate(v.validFrom)}</time>
                  <span>
                    <strong className="num">{euro(v.amountCents)}</strong> {INTERVAL_LABEL(v.intervalMonths)}
                    <span className="muted"> · {v.anchor === 'calendar' ? 'am Kalender' : 'ab Eintritt'}, {v.proration === 'month' ? 'anteilig' : 'voller Betrag'}{v.admissionFeeCents > 0 && ` · Aufnahmegebühr ${euro(v.admissionFeeCents)}`}</span>
                  </span>
                </li>
              ))}
            </ol>
            {canWrite && !adding && <div className="actions-row"><button className="btn" onClick={() => setAdding(true)}>Neuer Preis ab Datum</button></div>}
            {adding && (
              <form className="inline-form" noValidate onSubmit={async (e) => { e.preventDefault(); const f = new FormData(e.currentTarget); if (await call(() => api(`/fee-plans/${plan.id}/versions`, { method: 'POST', body: versionFrom(f) }))) setAdding(false); }}>
                <p className="meta">Bereits abgerechnete Zeiträume behalten ihren Preis.</p>
                <VersionFields error={error} defaults={plan.current} />
                <div className="actions-row" style={{ marginTop: 0 }}>
                  <button className="btn btn-primary">Preis speichern</button>
                  <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button>
                </div>
              </form>
            )}
          </section>
          {canWrite && (
            <section className="sheet-section">
              <div className="actions-row" style={{ marginTop: 0 }}>
                <button className="btn" onClick={() => void call(() => api(`/fee-plans/${plan.id}/retire`, { method: 'POST' }))}>{plan.status === 'active' ? 'Stilllegen' : 'Wieder aktivieren'}</button>
                {plan.assignedMembers === 0 && <button className="btn btn-ghost btn-danger" onClick={async () => { if (await call(() => api(`/fee-plans/${plan.id}`, { method: 'DELETE' }))) onClose(); }}>Löschen</button>}
              </div>
            </section>
          )}
        </>
      )}
    </Sheet>
  );
}
