import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../shared/auth.ts';
import { api, ApiError } from '../lib/api.ts';
import { useCustomFields } from './CustomFields.tsx';
import { Sheet } from './Sheet.tsx';

/** URL parameter (German, shareable) → API query parameter. */
export const FILTERS = {
  zahlweise: 'paymentMethod',
  alter_von: 'ageFrom',
  alter_bis: 'ageTo',
  eintritt_von: 'joinFrom',
  eintritt_bis: 'joinTo',
  austritt_von: 'exitFrom',
  austritt_bis: 'exitTo',
  mandat: 'mandate',
  haushalt: 'household',
  offen: 'openBalance',
  feld: 'cf',
} as const;
export type FilterKey = keyof typeof FILTERS;

/** API query for the facet parameters in the URL; exit filters include former members. */
export function facetQuery(params: URLSearchParams, into: URLSearchParams) {
  for (const [ui, apiKey] of Object.entries(FILTERS)) {
    const v = params.get(ui);
    if (v) into.set(apiKey, v);
  }
  if (params.get('austritt_von') || params.get('austritt_bis')) into.set('includeFormer', 'true');
}
export const activeFacets = (params: URLSearchParams) => Object.keys(FILTERS).filter((k) => params.get(k)).length;

interface View { id: string; name: string; params: string; shared: boolean; mine: boolean }
export const useViews = () => useQuery({ queryKey: ['member-views'], queryFn: () => api<View[]>('/member-views') });

export function ViewPicker({ onApply }: { onApply: (params: string) => void }) {
  const { data } = useViews();
  if (!data?.length) return null;
  return (
    <select className="select" aria-label="Gespeicherte Ansicht öffnen" value="" onChange={(e) => { const v = data.find((x) => x.id === e.target.value); if (v) onApply(v.params); }}>
      <option value="">Ansichten …</option>
      {data.map((v) => <option key={v.id} value={v.id}>{v.name}{v.shared ? ' (geteilt)' : ''}</option>)}
    </select>
  );
}

export function FilterSheet({ me, params, onApply, onClose }: { me: Me; params: URLSearchParams; onApply: (next: URLSearchParams) => void; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: fields } = useCustomFields();
  const views = useViews();
  const roles = useQuery({ queryKey: ['roles'], queryFn: () => api<{ id: string; name: string }[]>('/roles'), enabled: me.permissions.settings === 'write' });
  const [fieldId, setFieldId] = useState(params.get('feld')?.slice(0, 36) ?? '');
  const [error, setError] = useState<string>();
  const v = (k: FilterKey) => params.get(k) ?? '';
  const field = fields?.find((f) => f.id === fieldId);

  function read(form: HTMLFormElement) {
    const f = new FormData(form);
    const next = new URLSearchParams(params);
    for (const k of Object.keys(FILTERS) as FilterKey[]) {
      if (k === 'feld' || k === 'offen') continue;
      const val = ((f.get(k) as string | null) ?? '').trim();
      // Ages are whole numbers; anything else is dropped instead of breaking the list.
      if (val && (!k.startsWith('alter') || /^\d{1,3}$/.test(val))) next.set(k, val);
      else next.delete(k);
    }
    if (f.get('offen') === 'on') next.set('offen', 'true');
    else next.delete('offen');
    const fv = ((f.get('feldwert') as string | null) ?? '').trim();
    if (fieldId && fv) next.set('feld', `${fieldId}:${fv}`);
    else next.delete('feld');
    return next;
  }
  function apply(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    onApply(read(e.currentTarget));
    onClose();
  }
  async function save(form: HTMLFormElement) {
    const f = new FormData(form);
    const name = ((f.get('viewName') as string | null) ?? '').trim();
    if (!name) return setError('Bitte gib der Ansicht einen Namen.');
    const next = read(form);
    next.delete('neu');
    setError(undefined);
    try {
      await api('/member-views', { method: 'POST', body: { name, params: next.toString(), sharedRoleId: (f.get('share') as string) || null } });
      await qc.invalidateQueries({ queryKey: ['member-views'] });
      onApply(next);
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    }
  }
  async function remove(id: string) {
    setError(undefined);
    try {
      await api(`/member-views/${id}`, { method: 'DELETE' });
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
    }
    await qc.invalidateQueries({ queryKey: ['member-views'] });
  }
  // Facets only for data the user may see (the API refuses the others).
  const may = { age: !me.restricted.includes('birth_date'), mandate: (me.permissions.sepa ?? 'none') !== 'none', open: (me.permissions.invoices ?? 'none') !== 'none', pay: (me.permissions.fees ?? 'none') !== 'none' };

  return (
    <Sheet title="Filter" open onClose={onClose}>
      <form className="form" noValidate onSubmit={apply}>
        {error && <div className="alert alert-error" role="alert">{error}</div>}
        {(may.pay || may.mandate) && (
          <div className="form-row">
            {may.pay && <div className="field"><label htmlFor="f-pay">Zahlweise</label><select id="f-pay" name="zahlweise" className="select" style={{ width: '100%' }} defaultValue={v('zahlweise')}><option value="">alle</option><option value="direct_debit">Lastschrift</option><option value="transfer">Überweisung</option><option value="cash">Bar</option><option value="none">keine</option></select></div>}
            {may.mandate && <div className="field"><label htmlFor="f-mandate">SEPA-Mandat</label><select id="f-mandate" name="mandat" className="select" style={{ width: '100%' }} defaultValue={v('mandat')}><option value="">egal</option><option value="active">aktiv</option><option value="none">keins</option></select></div>}
          </div>
        )}
        {may.age && (
          <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="label">Alter (volle Jahre)</legend>
            <div className="form-row">
              <div className="field"><label htmlFor="f-age-from">von<span className="sr-only"> (Alter)</span></label><input id="f-age-from" name="alter_von" className="input num" inputMode="numeric" pattern="\d*" defaultValue={v('alter_von')} /></div>
              <div className="field"><label htmlFor="f-age-to">bis<span className="sr-only"> (Alter)</span></label><input id="f-age-to" name="alter_bis" className="input num" inputMode="numeric" pattern="\d*" defaultValue={v('alter_bis')} /></div>
            </div>
          </fieldset>
        )}
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Eintritt</legend>
          <div className="form-row">
            <div className="field"><label htmlFor="f-join-from">von<span className="sr-only"> (Eintritt)</span></label><input id="f-join-from" name="eintritt_von" type="date" className="input" defaultValue={v('eintritt_von')} /></div>
            <div className="field"><label htmlFor="f-join-to">bis<span className="sr-only"> (Eintritt)</span></label><input id="f-join-to" name="eintritt_bis" type="date" className="input" defaultValue={v('eintritt_bis')} /></div>
          </div>
        </fieldset>
        <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label">Austritt (zeigt auch Ehemalige)</legend>
          <div className="form-row">
            <div className="field"><label htmlFor="f-exit-from">von<span className="sr-only"> (Austritt)</span></label><input id="f-exit-from" name="austritt_von" type="date" className="input" defaultValue={v('austritt_von')} /></div>
            <div className="field"><label htmlFor="f-exit-to">bis<span className="sr-only"> (Austritt)</span></label><input id="f-exit-to" name="austritt_bis" type="date" className="input" defaultValue={v('austritt_bis')} /></div>
          </div>
        </fieldset>
        <div className="form-row">
          <div className="field"><label htmlFor="f-hh">Haushalt</label><select id="f-hh" name="haushalt" className="select" style={{ width: '100%' }} defaultValue={v('haushalt')}><option value="">egal</option><option value="yes">im Haushalt</option><option value="no">einzeln</option></select></div>
          {may.open && <label className="check" style={{ alignSelf: 'end' }}><input type="checkbox" name="offen" defaultChecked={v('offen') === 'true'} /> Mit offenen Posten</label>}
        </div>
        {fields && fields.filter((f) => !f.archived).length > 0 && (
          <div className="form-row">
            <div className="field"><label htmlFor="f-field">Eigenes Feld</label><select id="f-field" className="select" style={{ width: '100%' }} value={fieldId} onChange={(e) => setFieldId(e.target.value)}><option value="">–</option>{fields.filter((f) => !f.archived).map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}</select></div>
            <div className="field">
              <label htmlFor="f-field-value">Wert</label>
              {field?.type === 'select' || field?.type === 'multiselect'
                ? <select id="f-field-value" name="feldwert" className="select" style={{ width: '100%' }} defaultValue={params.get('feld')?.slice(37) ?? ''}><option value="">–</option>{field.options.map((o) => <option key={o}>{o}</option>)}</select>
                : field?.type === 'checkbox'
                  ? <select id="f-field-value" name="feldwert" className="select" style={{ width: '100%' }} defaultValue={params.get('feld')?.slice(37) ?? ''}><option value="">–</option><option value="true">ja</option><option value="false">nein</option></select>
                  : <input id="f-field-value" name="feldwert" className="input" defaultValue={params.get('feld')?.slice(37) ?? ''} disabled={!field} />}
            </div>
          </div>
        )}
        <div className="actions-row"><button className="btn btn-primary">Anwenden</button><button type="button" className="btn btn-ghost" onClick={() => { onApply(new URLSearchParams([...params].filter(([k]) => !(k in FILTERS)))); onClose(); }}>Filter zurücksetzen</button></div>

        <section className="sheet-section" aria-labelledby="save-view">
          <h3 id="save-view">Als Ansicht speichern</h3>
          <div className="form-row">
            <div className="field"><label htmlFor="view-name">Name</label><input id="view-name" name="viewName" className="input" placeholder="z. B. Jugend mit offenen Posten" /></div>
            {me.permissions.settings === 'write' && roles.data && (
              <div className="field"><label htmlFor="view-share">Teilen mit</label><select id="view-share" name="share" className="select" style={{ width: '100%' }} defaultValue=""><option value="">nur mir</option>{roles.data.map((r) => <option key={r.id} value={r.id}>Rolle {r.name}</option>)}</select></div>
            )}
          </div>
          <div className="actions-row" style={{ marginTop: 0 }}><button type="button" className="btn" onClick={(e) => void save(e.currentTarget.form!)}>Speichern</button></div>
          {views.data && views.data.length > 0 && (
            <ul className="timeline" aria-label="Gespeicherte Ansichten">
              {views.data.map((x) => (
                <li key={x.id} style={{ gridTemplateColumns: '1fr auto' }}>
                  <span>{x.name}{x.shared && <span className="meta"> · geteilt</span>}</span>
                  {(x.mine || me.permissions.settings === 'write') && <button type="button" className="btn btn-ghost" aria-label={`Ansicht ${x.name} löschen`} onClick={() => void remove(x.id)}>löschen</button>}
                </li>
              ))}
            </ul>
          )}
        </section>
      </form>
    </Sheet>
  );
}
