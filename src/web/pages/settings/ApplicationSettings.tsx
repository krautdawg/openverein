import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { generate } from 'lean-qr';
import { toSvgDataURL } from 'lean-qr/extras/svg';
import type { Me } from '../../../shared/auth.ts';
import type { Organization } from '../../../shared/organization.ts';
import { Field } from '../../components/Field.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useGroups } from '../../lib/hooks.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface AppForm { id: string; slug: string; title: string; intro: string | null; groupIds: string[]; feePlanIds: string[]; askMandate: boolean; consentText: string; consentVersion: number; privacyUrl: string | null; allowedOrigins: string[]; active: boolean; url: string }

const JOIN_RULE = { next_month_first: 'zum 1. des Folgemonats', month_first: 'zum 1. des Antragsmonats', application_date: 'zum Tag des Antrags', acceptance_date: 'zum Tag der Aufnahme' } as const;
const DEFAULT_CONSENT = 'Ich erkenne die Satzung des Vereins an. Ich willige ein, dass der Verein meine Angaben zur Mitgliederverwaltung verarbeitet.';

export function ApplicationSettings({ me }: { me: Me }) {
  useTitle('Aufnahme');
  const qc = useQueryClient();
  const canWrite = me.permissions.members === 'write' && me.permissions.settings === 'write';
  const { data: org } = useQuery({ queryKey: ['organization'], queryFn: () => api<Organization>('/organization') });
  const forms = useQuery({ queryKey: ['application-forms'], queryFn: () => api<AppForm[]>('/application-forms') });
  const [editing, setEditing] = useState<AppForm | 'new' | null>(null);

  async function save(body: Partial<Organization>) {
    qc.setQueryData(['organization'], await api<Organization>('/organization', { method: 'PATCH', body }));
  }
  if (!org) return <div className="skeleton" style={{ width: 280 }} />;
  return (
    <>
      <section aria-labelledby="rules">
        <h2 id="rules" style={{ marginBottom: 'var(--s-4)' }}>Regeln</h2>
        <dl className="facts">
          <dt>Eintritt</dt>
          <dd>
            {canWrite ? (
              <select className="select" aria-label="Eintritt bei Aufnahme" value={org.joinRule} onChange={(e) => void save({ joinRule: e.target.value as Organization['joinRule'] })}>
                {Object.entries(JOIN_RULE).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            ) : JOIN_RULE[org.joinRule]}
          </dd>
          <dt>Online-Mandate</dt>
          <dd>
            <label className="check"><input type="checkbox" disabled={!canWrite} checked={org.electronicMandatesAgreed} onChange={(e) => void save({ electronicMandatesAgreed: e.target.checked })} /> Unsere Bank hat schriftlich zugestimmt, dass Mandate online erteilt werden dürfen</label>
            <div className="meta" style={{ maxWidth: '60ch' }}>Ohne diese Zustimmung wartet ein Mandat aus dem Formular auf die Unterschrift auf Papier. Eine Lastschrift ohne gültiges Mandat kann das Mitglied 13 Monate lang zurückholen.</div>
          </dd>
        </dl>
      </section>

      <section className="section" aria-labelledby="forms">
        <h2 id="forms">Formulare</h2>
        {forms.data?.length === 0 && <p className="muted" style={{ marginBottom: 'var(--s-4)' }}>Noch kein Aufnahmeformular. Leg eins an und verlinke es auf Deiner Website oder häng den QR-Code im Vereinsheim aus.</p>}
        <ul className="timeline">
          {forms.data?.map((f) => (
            <li key={f.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <span>
                <span className="name">{f.title}</span>{!f.active && <span className="pill" style={{ marginLeft: 8 }}>aus</span>}
                <div className="meta"><a href={f.url} target="_blank" rel="noreferrer">{f.url}</a></div>
              </span>
              <button className="btn btn-ghost" onClick={() => setEditing(f)}>{canWrite ? 'Bearbeiten' : 'Ansehen'}</button>
            </li>
          ))}
        </ul>
        {canWrite && <div className="actions-row"><button className="btn" onClick={() => setEditing('new')}>Formular anlegen</button></div>}
      </section>
      {editing && <FormSheet form={editing === 'new' ? null : editing} canWrite={canWrite} onClose={() => setEditing(null)} />}
    </>
  );
}

function FormSheet({ form, canWrite, onClose }: { form: AppForm | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: groups } = useGroups();
  const plans = useQuery({ queryKey: ['fee-plans', false], queryFn: () => api<{ id: string; name: string }[]>('/fee-plans') });
  const [error, setError] = useState<ApiError>();

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const body = {
      slug: f.get('slug'), title: f.get('title'), intro: f.get('intro') || null,
      groupIds: f.getAll('groupIds'), feePlanIds: f.getAll('feePlanIds'),
      askMandate: f.get('askMandate') === 'on', consentText: f.get('consentText'), privacyUrl: f.get('privacyUrl') || null,
      allowedOrigins: String(f.get('allowedOrigins') ?? '').split(/[\s,]+/).filter(Boolean), active: f.get('active') === 'on',
    };
    setError(undefined);
    try {
      await api(form ? `/application-forms/${form.id}` : '/application-forms', { method: form ? 'PUT' : 'POST', body });
      await qc.invalidateQueries({ queryKey: ['application-forms'] });
      onClose();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  const qr = form ? toSvgDataURL(generate(form.url), { on: '#14202e', off: '#ffffff', padX: 2, padY: 2 }) : null;
  const snippet = form ? `<iframe src="${form.url}" title="${form.title}" style="width:100%;min-height:1400px;border:0"></iframe>` : '';
  return (
    <Sheet title={form ? form.title : 'Neues Aufnahmeformular'} open onClose={onClose}>
      {form && (
        <section className="sheet-section" aria-labelledby="share">
          <h3 id="share">Teilen</h3>
          <div style={{ display: 'flex', gap: 'var(--s-4)', alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <img src={qr!} width={120} height={120} alt={`QR-Code für ${form.url}`} style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', imageRendering: 'pixelated' }} />
            <div style={{ flex: 1, minWidth: 220 }}>
              <div className="meta">Zum Einbetten in die Vereinswebsite:</div>
              <code className="token-once" style={{ display: 'block', whiteSpace: 'pre-wrap', wordBreak: 'break-all', marginTop: 'var(--s-1)' }}>{snippet}</code>
              <div className="meta" style={{ marginTop: 'var(--s-1)' }}>Einbetten klappt nur auf den unten eingetragenen Websites.</div>
            </div>
          </div>
        </section>
      )}
      <form className="form" noValidate onSubmit={submit}>
        {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.title}</div>}
        <fieldset disabled={!canWrite} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 'var(--s-3)' }}>
          <Field label="Titel" name="title" defaultValue={form?.title ?? 'Mitglied werden'} error={error?.fieldError('title')} />
          <Field label="Adresse (Teil hinter /aufnahme/)" name="slug" defaultValue={form?.slug ?? 'mitglied-werden'} error={error?.fieldError('slug')} />
          <div className="field"><label htmlFor="intro">Einleitung</label><textarea id="intro" name="intro" className="textarea" defaultValue={form?.intro ?? ''} /></div>
          {groups && groups.length > 0 && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">Gruppen zur Auswahl</legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--s-4)' }}>{groups.map((g) => <label key={g.id} className="check"><input type="checkbox" name="groupIds" value={g.id} defaultChecked={form?.groupIds.includes(g.id)} /> {g.name}</label>)}</div>
            </fieldset>
          )}
          {plans.data && plans.data.length > 0 && (
            <fieldset className="field" style={{ border: 0, padding: 0, margin: 0 }}>
              <legend className="label">Beiträge zur Auswahl <span className="meta">(keiner gewählt = keine Auswahl im Formular)</span></legend>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0 var(--s-4)' }}>{plans.data.map((p) => <label key={p.id} className="check"><input type="checkbox" name="feePlanIds" value={p.id} defaultChecked={form?.feePlanIds.includes(p.id)} /> {p.name}</label>)}</div>
            </fieldset>
          )}
          <label className="check"><input type="checkbox" name="askMandate" defaultChecked={form?.askMandate ?? true} /> SEPA-Lastschrift anbieten (braucht eine Gläubiger-ID)</label>
          <div className="field"><label htmlFor="consent">Einwilligung {form && <span className="meta">(Version {form.consentVersion}; jede Änderung zählt als neue Version)</span>}</label><textarea id="consent" name="consentText" className="textarea" defaultValue={form?.consentText ?? DEFAULT_CONSENT} /></div>
          <Field label="Link zu den Datenschutzhinweisen" name="privacyUrl" type="url" defaultValue={form?.privacyUrl ?? ''} placeholder="https://" error={error?.fieldError('privacyUrl')} />
          <Field label="Websites, die das Formular einbetten dürfen" name="allowedOrigins" defaultValue={form?.allowedOrigins.join(' ') ?? ''} placeholder="https://www.mein-verein.de" hint="Mehrere durch Leerzeichen trennen." error={error?.fieldError('allowedOrigins')} />
          <label className="check"><input type="checkbox" name="active" defaultChecked={form?.active ?? true} /> Formular ist online</label>
          {canWrite && <div className="actions-row"><button className="btn btn-primary">{form ? 'Speichern' : 'Formular anlegen'}</button></div>}
        </fieldset>
      </form>
    </Sheet>
  );
}
