import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { formatDate } from '../../shared/dates.ts';
import { euro, PAYMENT_METHOD_LABEL, PAYMENT_METHODS, type Plan } from '../../shared/fees.ts';
import type { InvoiceListItem } from '../../shared/invoices.ts';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { Field } from './Field.tsx';
import { MoneyField } from './MoneyField.tsx';

interface Fees {
  paymentMethod: (typeof PAYMENT_METHODS)[number];
  assignments: { id: string; feePlanId: string; planName: string; isMain: boolean; validFrom: string; validTo: string | null; overrideCents: number | null; overrideReason: string | null }[];
}
interface Calc { lines: { key: string; text: string; amountCents: number; explanation: string; catchUp: boolean }[]; skipped: { reason: string }[]; totalCents: number }

/** Fee assignments, payment method, a no-side-effect fee calculator and the member's invoices. */
export function MemberFees({ memberId, joinDate, canWrite, canSeeInvoices }: { memberId: string; joinDate: string | null; canWrite: boolean; canSeeInvoices: boolean }) {
  const qc = useQueryClient();
  const fees = useQuery({ queryKey: ['member-fees', memberId], queryFn: () => api<Fees>(`/members/${memberId}/fees`) });
  const plans = useQuery({ queryKey: ['fee-plans', false], queryFn: () => api<Plan[]>('/fee-plans'), enabled: canWrite });
  const invoices = useQuery({ queryKey: ['invoices', `member=${memberId}`], queryFn: () => api<{ items: InvoiceListItem[] }>(`/invoices?memberId=${memberId}&status=all&limit=10`), enabled: canSeeInvoices });
  const [until, setUntil] = useState(`${todayLocal().slice(0, 4)}-12-31`);
  const calc = useQuery({ queryKey: ['fee-calc', memberId, until, fees.data], queryFn: () => api<Calc>(`/members/${memberId}/fee-calculator?until=${until}`), enabled: !!fees.data?.assignments.length });
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<ApiError>();
  const refresh = () => qc.invalidateQueries({ queryKey: ['member-fees', memberId] });

  async function call(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      await refresh();
      return true;
    } catch (e) {
      setError(e instanceof ApiError ? e : undefined);
      return false;
    }
  }

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const override = f.get('overrideCents');
    if (override === 'NaN') return;
    const ok = await call(() => api(`/members/${memberId}/fee-assignments`, {
      method: 'POST',
      body: { feePlanId: f.get('feePlanId'), isMain: f.get('isMain') === 'main', validFrom: f.get('validFrom'), overrideCents: override ? Number(override) : null, overrideReason: f.get('overrideReason') || null },
    }));
    if (ok) setAdding(false);
  }

  const f = fees.data;
  return (
    <section className="sheet-section" aria-labelledby="s-fees">
      <h3 id="s-fees">Beiträge</h3>
      {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-3)' }}>{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.detail ?? error.problem.title}</div>}
      {f && (
        <>
          <dl className="facts">
            <dt>Zahlungsart</dt>
            <dd>
              {canWrite ? (
                <select className="select" aria-label="Zahlungsart" value={f.paymentMethod} onChange={(e) => void call(() => api(`/members/${memberId}/payment-method`, { method: 'PATCH', body: { paymentMethod: e.target.value } }))}>
                  {PAYMENT_METHODS.map((m) => <option key={m} value={m}>{PAYMENT_METHOD_LABEL[m]}</option>)}
                </select>
              ) : PAYMENT_METHOD_LABEL[f.paymentMethod]}
            </dd>
          </dl>
          {f.assignments.length === 0 && <p className="muted" style={{ marginTop: 'var(--s-3)' }}>Noch kein Beitrag zugeordnet.</p>}
          <ol className="timeline" style={{ marginTop: 'var(--s-3)' }}>
            {f.assignments.map((a) => (
              <li key={a.id} style={{ gridTemplateColumns: '1fr auto' }}>
                <span>
                  <strong>{a.planName}</strong> <span className="muted">{a.isMain ? 'Hauptbeitrag' : 'Zusatzbeitrag'} · ab {formatDate(a.validFrom)}{a.validTo && ` bis ${formatDate(a.validTo)}`}</span>
                  {a.overrideCents !== null && <div className="meta">Individuell {euro(a.overrideCents)}: {a.overrideReason}</div>}
                </span>
                {canWrite && !a.validTo && <button className="btn btn-ghost" onClick={() => void call(() => api(`/fee-assignments/${a.id}`, { method: 'PATCH', body: { validTo: todayLocal() } }))}>Beenden</button>}
              </li>
            ))}
          </ol>
          {canWrite && !adding && <div className="actions-row"><button className="btn" onClick={() => setAdding(true)}>Beitrag zuordnen</button></div>}
          {adding && (
            <form className="inline-form" noValidate onSubmit={add}>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="fp">Beitragsart</label>
                  <select id="fp" name="feePlanId" className="select" style={{ width: '100%' }}>
                    {plans.data?.map((p) => <option key={p.id} value={p.id}>{p.name}{p.current && ` (${euro(p.current.amountCents)})`}</option>)}
                  </select>
                </div>
                <Field label="ab" name="validFrom" type="date" defaultValue={joinDate && joinDate > todayLocal() ? joinDate : (joinDate ?? todayLocal())} />
              </div>
              <div className="form-row">
                <div className="field">
                  <label htmlFor="ism">Art</label>
                  <select id="ism" name="isMain" className="select" style={{ width: '100%' }} defaultValue={f.assignments.some((a) => a.isMain && !a.validTo) ? 'addon' : 'main'}>
                    <option value="main">Hauptbeitrag</option>
                    <option value="addon">Zusatzbeitrag (z. B. Abteilung)</option>
                  </select>
                </div>
                <MoneyField label="Individueller Betrag (optional)" name="overrideCents" />
              </div>
              <Field label="Grund für den individuellen Betrag" name="overrideReason" placeholder="z. B. Ermäßigung laut Vorstandsbeschluss" error={error?.fieldError('overrideReason')} />
              <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Zuordnen</button><button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button></div>
            </form>
          )}
          {f.assignments.length > 0 && (
            <div style={{ marginTop: 'var(--s-4)' }}>
              <div className="inline-edit" style={{ gap: 'var(--s-3)' }}>
                <strong>Beitragsrechner</strong>
                <span className="muted">noch nicht berechnet bis</span>
                <input type="date" className="input" style={{ width: 'auto' }} aria-label="Berechnen bis" value={until} onChange={(e) => e.target.value && setUntil(e.target.value)} />
              </div>
              {calc.data && (
                <ul className="timeline">
                  {calc.data.lines.map((l) => <li key={l.key} style={{ gridTemplateColumns: '1fr auto' }}><span>{l.text}<div className="meta">{l.explanation}</div></span><span className="num">{euro(l.amountCents)}</span></li>)}
                  {calc.data.lines.length === 0 && <li style={{ gridTemplateColumns: '1fr' }}><span className="muted">{calc.data.skipped[0]?.reason ?? 'Nichts offen.'}</span></li>}
                  {calc.data.lines.length > 1 && <li style={{ gridTemplateColumns: '1fr auto' }}><strong>Summe</strong><strong className="num">{euro(calc.data.totalCents)}</strong></li>}
                </ul>
              )}
            </div>
          )}
        </>
      )}
      {canSeeInvoices && invoices.data && invoices.data.items.length > 0 && (
        <div style={{ marginTop: 'var(--s-4)' }}>
          <strong>Rechnungen</strong>
          <ul className="timeline">
            {invoices.data.items.map((i) => (
              <li key={i.id} style={{ gridTemplateColumns: '7rem 1fr auto' }}>
                <Link to={`/rechnungen/${i.id}`} className="num">{i.number ?? 'Entwurf'}</Link>
                <span className="muted">{formatDate(i.issueDate)}{i.openCents > 0 && ` · offen ${euro(i.openCents)}`}</span>
                <span className="num">{euro(i.totalCents)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
