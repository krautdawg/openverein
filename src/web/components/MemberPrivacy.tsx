import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CONSENT_PURPOSE_LABEL, CONSENT_PURPOSES, CONSENT_SOURCE_LABEL, CONSENT_SOURCES, type PrivacyState } from '../../shared/privacy.ts';
import { api, ApiError } from '../lib/api.ts';

const problemText = (e: ApiError) => e.problem.errors?.map((x) => x.message).join(' ') ?? [e.problem.title, e.problem.detail].filter(Boolean).join(' ');

/** Consents, legal hold, access export and anonymisation for one person. Needs a club-wide members grant. */
export function MemberPrivacy({ personId, canWrite, onAnonymised }: { personId: string; canWrite: boolean; onAnonymised: () => void }) {
  const qc = useQueryClient();
  const key = ['privacy', personId];
  const { data, error: loadError } = useQuery({ queryKey: key, queryFn: () => api<PrivacyState>(`/persons/${personId}/privacy`), retry: false });
  const [form, setForm] = useState<'consent' | 'hold' | 'anonymise' | null>(null);
  const [purpose, setPurpose] = useState<(typeof CONSENT_PURPOSES)[number]>('newsletter');
  const [error, setError] = useState<string>();

  async function run(fn: () => Promise<unknown>) {
    setError(undefined);
    try {
      await fn();
      setForm(null);
      await qc.invalidateQueries({ queryKey: key });
      // A legal hold or anonymisation changes the person record: the sheet reloads its version.
      await qc.invalidateQueries({ queryKey: ['member'] });
    } catch (err) {
      setError(err instanceof ApiError ? problemText(err) : 'Das hat nicht geklappt. Bitte versuch es noch einmal.');
    }
  }
  // Scoped users have no club-wide grant (403): the section stays out of their way. Other errors are shown.
  if (loadError instanceof ApiError && loadError.problem.status === 403) return null;
  if (loadError) return <section className="sheet-section"><h3>Datenschutz</h3><div className="alert alert-error" role="alert">{loadError instanceof ApiError ? problemText(loadError) : 'Konnte nicht geladen werden.'}</div></section>;
  if (!data) return null;
  const live = data.consents.filter((c) => !c.withdrawnAt);
  const past = data.consents.filter((c) => c.withdrawnAt);
  const fd = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    return new FormData(e.currentTarget);
  };

  return (
    <section className="sheet-section" aria-labelledby="m-privacy">
      <h3 id="m-privacy">Datenschutz</h3>
      {!data.anonymisedAt && <p className="muted" style={{ marginTop: 0 }}>Einwilligungen werden hier dokumentiert. Ein Widerruf der Newsletter-Einwilligung meldet die E-Mail-Adresse vom Newsletter ab.</p>}
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {data.anonymisedAt ? (
        <p className="muted">Anonymisiert am {new Date(data.anonymisedAt).toLocaleDateString('de-DE')}. Rechnungen und Buchungen behalten ihre Angaben bis zum Ende ihrer Aufbewahrung.</p>
      ) : (
        <>
          <ul className="timeline" aria-label="Einwilligungen">
            {live.length === 0 && <li style={{ gridTemplateColumns: '1fr' }}><span className="muted">Keine Einwilligungen erfasst.</span></li>}
            {live.map((c) => (
              <li key={c.id} style={{ gridTemplateColumns: '1fr auto' }}>
                <span>{c.label ?? CONSENT_PURPOSE_LABEL[c.purpose]} <span className="meta">· {CONSENT_SOURCE_LABEL[c.source]}, {new Date(c.grantedAt).toLocaleDateString('de-DE')}{c.textVersion ? `, ${c.textVersion}` : ''}</span></span>
                {canWrite && <button className="btn btn-ghost" aria-label={`Einwilligung ${c.label ?? CONSENT_PURPOSE_LABEL[c.purpose]} widerrufen`} onClick={() => void run(() => api(`/consents/${c.id}/withdraw`, { method: 'POST', body: { source: 'admin' } }))}>Widerrufen</button>}
              </li>
            ))}
            {past.map((c) => (
              <li key={c.id} style={{ gridTemplateColumns: '1fr' }}>
                <span className="muted">{c.label ?? CONSENT_PURPOSE_LABEL[c.purpose]} · widerrufen am {new Date(c.withdrawnAt!).toLocaleDateString('de-DE')}</span>
              </li>
            ))}
          </ul>
          {data.legalHoldReason && <div className="alert alert-warn" style={{ marginTop: 'var(--s-3)' }}>Löschsperre: {data.legalHoldReason}</div>}

          {form === 'consent' && (
            <form className="inline-form" noValidate onSubmit={(e) => { const f = fd(e); void run(() => api(`/persons/${personId}/consents`, { method: 'POST', body: { purpose, label: purpose === 'other' ? f.get('label') : null, source: f.get('source'), textVersion: (f.get('textVersion') as string) || null } })); }}>
              <div className="form-row">
                <div className="field"><label htmlFor="c-purpose">Wofür</label><select id="c-purpose" className="select" style={{ width: '100%' }} value={purpose} onChange={(e) => setPurpose(e.target.value as typeof purpose)}>{CONSENT_PURPOSES.map((p) => <option key={p} value={p}>{CONSENT_PURPOSE_LABEL[p]}</option>)}</select></div>
                <div className="field"><label htmlFor="c-source">Erteilt</label><select id="c-source" name="source" className="select" style={{ width: '100%' }} defaultValue="paper">{CONSENT_SOURCES.map((s) => <option key={s} value={s}>{CONSENT_SOURCE_LABEL[s]}</option>)}</select></div>
              </div>
              {purpose === 'other' && <div className="field"><label htmlFor="c-label">Beschreibung</label><input id="c-label" name="label" className="input" /></div>}
              <div className="field"><label htmlFor="c-version">Fassung des Textes (optional)</label><input id="c-version" name="textVersion" className="input" placeholder="z. B. Aufnahmeantrag 2026" /></div>
              <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Erfassen</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
            </form>
          )}
          {form === 'hold' && (
            <form className="inline-form" noValidate onSubmit={(e) => { const f = fd(e); void run(() => api(`/persons/${personId}/legal-hold`, { method: 'PUT', body: { reason: f.get('reason') } })); }}>
              <div className="field"><label htmlFor="h-reason">Grund der Löschsperre</label><input id="h-reason" name="reason" className="input" placeholder="z. B. laufender Rechtsstreit" /></div>
              <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Sperre setzen</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
            </form>
          )}
          {form === 'anonymise' && (
            <div className="inline-form">
              {data.blockers.length ? (
                <>
                  <p>Anonymisieren geht erst, wenn das hier erledigt ist:</p>
                  <ul>{data.blockers.map((b) => <li key={b}>{b}</li>)}</ul>
                  <div className="actions-row" style={{ marginTop: 0 }}><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Schließen</button></div>
                </>
              ) : (
                <>
                  <p role="alert">Name, Anschrift, Kontaktdaten, Notizen, Einwilligungen und löschbare Dateien werden endgültig entfernt. Rechnungen, Bestätigungen und Buchungen behalten ihre Angaben bis zum Ende der Aufbewahrungsfrist. Das lässt sich nicht rückgängig machen.</p>
                  <div className="actions-row" style={{ marginTop: 0 }}>
                    <button type="button" className="btn btn-danger" onClick={() => void run(async () => { await api(`/persons/${personId}/anonymise`, { method: 'POST' }); onAnonymised(); })}>Endgültig anonymisieren</button>
                    <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button>
                  </div>
                </>
              )}
            </div>
          )}

          <div className="actions-row">
            {canWrite && form !== 'consent' && <button className="btn" onClick={() => setForm('consent')}>Einwilligung erfassen</button>}
            <a className="btn" href={`/api/v1/persons/${personId}/export`}>Auskunft (Art. 15)</a>
            {canWrite && (data.legalHoldReason
              ? <button className="btn btn-ghost" onClick={() => void run(() => api(`/persons/${personId}/legal-hold`, { method: 'PUT', body: { reason: null } }))}>Löschsperre aufheben</button>
              : form !== 'hold' && <button className="btn btn-ghost" onClick={() => setForm('hold')}>Löschsperre …</button>)}
            {canWrite && form !== 'anonymise' && <button className="btn btn-ghost" onClick={() => setForm('anonymise')}>Anonymisieren …</button>}
          </div>
        </>
      )}
    </section>
  );
}
