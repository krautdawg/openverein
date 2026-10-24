import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { formatDate } from '../../shared/dates.ts';
import { MANDATE_STATUS_LABEL, type Mandate } from '../../shared/sepa.ts';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { Field } from './Field.tsx';

/** SEPA mandate of the member: show, record a signed one, revoke. IBANs only for those allowed to see them. */
export function MemberMandate({ memberId, holder, canWrite }: { memberId: string; holder: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const mandates = useQuery({ queryKey: ['mandates', memberId], queryFn: () => api<Mandate[]>(`/members/${memberId}/mandates`) });
  const [form, setForm] = useState<'new' | 'revoke' | null>(null);
  const [error, setError] = useState<ApiError>();
  const current = mandates.data?.find((m) => m.status === 'active' || m.status === 'pending_evidence');

  async function call(path: string, body: unknown) {
    setError(undefined);
    try {
      await api(path, { method: 'POST', body });
      await qc.invalidateQueries({ queryKey: ['mandates', memberId] });
      void qc.invalidateQueries({ queryKey: ['member', memberId] });
      setForm(null);
    } catch (e) {
      setError(e instanceof ApiError ? e : undefined);
    }
  }

  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void call(`/members/${memberId}/mandates`, { accountHolder: f.get('accountHolder'), iban: f.get('iban'), bic: f.get('bic') || null, signedOn: f.get('signedOn'), pendingEvidence: f.get('pending') === 'on' });
  }

  return (
    <section className="sheet-section" aria-labelledby="s-mandate">
      <h3 id="s-mandate">SEPA-Lastschriftmandat</h3>
      {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
      {current ? (
        <dl className="facts">
          <dt>Mandatsreferenz</dt><dd className="num">{current.reference}</dd>
          <dt>Status</dt><dd><span className="status" data-s={current.status === 'active' ? 'active' : 'applicant'}>{MANDATE_STATUS_LABEL[current.status]}</span></dd>
          <dt>Kontoinhaber:in</dt><dd>{current.accountHolder}</dd>
          <dt>IBAN</dt><dd className="num">{current.iban?.replace(/(.{4})/g, '$1 ') ?? current.ibanMasked}</dd>
          <dt>Unterschrieben am</dt><dd>{formatDate(current.signedOn)}</dd>
          {current.lastCollectedOn && (<><dt>Zuletzt eingezogen</dt><dd>{formatDate(current.lastCollectedOn)}</dd></>)}
        </dl>
      ) : (
        <p className="muted">Kein aktives Mandat.</p>
      )}
      {canWrite && !form && (
        <div className="actions-row">
          <button className="btn" onClick={() => setForm('new')}>{current ? 'Neues Mandat (z. B. neue IBAN)' : 'Mandat erfassen'}</button>
          {current?.status === 'pending_evidence' && <button className="btn" onClick={() => void call(`/mandates/${current.id}/activate`, {})}>Unterschrift liegt vor</button>}
          {current && <button className="btn btn-ghost btn-danger" onClick={() => setForm('revoke')}>Widerrufen</button>}
        </div>
      )}
      {form === 'new' && (
        <form className="inline-form" noValidate onSubmit={submit}>
          <div className="form-row">
            <Field label="Kontoinhaber:in" name="accountHolder" defaultValue={holder} error={error?.fieldError('accountHolder')} />
            <Field label="Unterschrieben am" name="signedOn" type="date" defaultValue={todayLocal()} error={error?.fieldError('signedOn')} />
          </div>
          <div className="form-row">
            <Field label="IBAN" name="iban" autoComplete="off" error={error?.fieldError('iban')} />
            <Field label="BIC (optional)" name="bic" error={error?.fieldError('bic')} />
          </div>
          <label className="check"><input type="checkbox" name="pending" /> Unterschriebenes Mandat liegt noch nicht vor</label>
          {current && <p className="meta">Das bisherige Mandat {current.reference} wird dabei widerrufen.</p>}
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Speichern</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
        </form>
      )}
      {form === 'revoke' && current && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void call(`/mandates/${current.id}/revoke`, { reason: new FormData(e.currentTarget).get('reason') }); }}>
          <Field label="Grund" name="reason" required placeholder="z. B. Widerruf durch das Mitglied" />
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-danger">Widerrufen</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
        </form>
      )}
    </section>
  );
}
