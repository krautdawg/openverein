import { Fragment, useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { customText, type CustomField } from '../../shared/customFields.ts';
import type { MemberDetail } from '../../shared/members.ts';
import { api, ApiError } from '../lib/api.ts';

export const useCustomFields = () => useQuery({ queryKey: ['custom-fields'], queryFn: () => api<CustomField[]>('/custom-fields') });

const name = (f: CustomField) => `custom.${f.id}`;

/** Reads the custom inputs of a form into `{ fieldId: value }` (empty → null). */
export function readCustom(form: FormData, fields: CustomField[]) {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    if (f.archived) continue;
    if (f.type === 'checkbox') out[f.id] = form.get(name(f)) === 'on';
    else if (f.type === 'multiselect') out[f.id] = form.getAll(name(f));
    else {
      const v = (form.get(name(f)) as string | null)?.trim() ?? '';
      // German numbers: "1.234,5"; anything unparseable goes to the server as text and comes back as an error.
      const n = Number(v.replace(/\./g, '').replace(',', '.'));
      out[f.id] = v === '' ? null : f.type === 'number' ? (Number.isFinite(n) ? n : v) : v;
    }
  }
  return out;
}

/** One input per active field, named `custom.<id>`. */
export function CustomInputs({ fields, values = {}, error, only }: { fields: CustomField[]; values?: Record<string, unknown>; error?: ApiError; only?: 'required' }) {
  return (
    <>
      {fields.filter((f) => !f.archived && (!only || f.required)).map((f) => {
        const id = `cf-${f.id}`;
        const err = error?.fieldError(name(f));
        const v = values[f.id];
        const label = <label htmlFor={id}>{f.label}{f.required ? '' : ' (optional)'}</label>;
        const msg = err && <span className="error" role="alert">{err}</span>;
        switch (f.type) {
          case 'checkbox':
            return <label key={f.id} className="check"><input id={id} type="checkbox" name={name(f)} defaultChecked={v === true} /> {f.label}</label>;
          case 'multiline':
            return <div key={f.id} className="field">{label}<textarea id={id} name={name(f)} className="textarea" defaultValue={(v as string) ?? ''} aria-invalid={!!err} />{msg}</div>;
          case 'select':
            return <div key={f.id} className="field">{label}<select id={id} name={name(f)} className="select" style={{ width: '100%' }} defaultValue={(v as string) ?? ''} aria-invalid={!!err}><option value="">–</option>{f.options.map((o) => <option key={o}>{o}</option>)}</select>{msg}</div>;
          case 'multiselect':
            return (
              <fieldset key={f.id} className="field" style={{ border: 0, padding: 0, margin: 0 }} aria-invalid={!!err || undefined}>
                <legend className="label" style={{ marginBottom: 'var(--s-1)' }}>{f.label}{f.required ? '' : ' (optional)'}</legend>
                {f.options.map((o) => <label key={o} className="check"><input type="checkbox" name={name(f)} value={o} defaultChecked={Array.isArray(v) && v.includes(o)} /> {o}</label>)}
                {msg}
              </fieldset>
            );
          default:
            return <div key={f.id} className="field">{label}<input id={id} name={name(f)} className={`input${f.type === 'number' ? ' num' : ''}`} type={f.type === 'date' ? 'date' : 'text'} inputMode={f.type === 'number' ? 'decimal' : undefined} defaultValue={v === undefined || v === null ? '' : String(v)} aria-invalid={!!err} />{msg}</div>;
        }
      })}
    </>
  );
}

/** "Weitere Angaben" in the member sheet: values at a glance, a form to change them. */
export function MemberCustom({ m, canWrite, onChanged, ifMatch }: { m: MemberDetail; canWrite: boolean; onChanged: (m: MemberDetail) => void; ifMatch?: () => string | undefined }) {
  const { data: fields } = useCustomFields();
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<ApiError>();
  const active = fields?.filter((f) => !f.archived) ?? [];
  if (!active.length) return null;

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      onChanged(await api<MemberDetail>(`/members/${m.id}`, { method: 'PATCH', body: { custom: readCustom(new FormData(e.currentTarget), active) }, ifMatch: ifMatch?.() ?? m.version }));
      setEditing(false);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  return (
    <section className="sheet-section" aria-labelledby="m-custom">
      <h3 id="m-custom">Weitere Angaben</h3>
      {editing ? (
        <form className="form" noValidate onSubmit={(e) => void save(e)}>
          {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
          <CustomInputs fields={active} values={m.custom} error={error} />
          <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Speichern</button><button type="button" className="btn btn-ghost" onClick={() => setEditing(false)}>Abbrechen</button></div>
        </form>
      ) : (
        <>
          <dl className="facts">
            {active.map((f) => <Fragment key={f.id}><dt>{f.label}</dt><dd>{customText(f.type, m.custom[f.id]) || <span className="muted">–</span>}</dd></Fragment>)}
          </dl>
          {canWrite && <div className="actions-row"><button className="btn" onClick={() => setEditing(true)}>Ändern</button></div>}
        </>
      )}
    </section>
  );
}
