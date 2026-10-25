import { Link } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../../shared/auth.ts';
import { PORTAL_FEATURE_KEYS, PORTAL_FEATURES, type Organization } from '../../../shared/organization.ts';
import { INVOICE_TEXT_PLACEHOLDERS } from '../../../shared/invoices.ts';
import { InlineEdit } from '../../components/InlineEdit.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

const EXIT_AT = { any_day: 'zu jedem Tag', month_end: 'zum Monatsende', quarter_end: 'zum Quartalsende', half_year_end: 'zum Halbjahresende', year_end: 'zum Jahresende' } as const;

export function ClubSettings({ me }: { me: Me }) {
  useTitle('Einstellungen');
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const { data: org } = useQuery({ queryKey: ['organization'], queryFn: () => api<Organization>('/organization') });

  async function save(body: Partial<Organization>) {
    let updated: Organization;
    try {
      updated = await api<Organization>('/organization', { method: 'PATCH', body, ifMatch: org?.version });
    } catch (err) {
      // Someone else saved meanwhile: show their state, the user repeats the change.
      if (err instanceof ApiError && err.problem.status === 412) await qc.invalidateQueries({ queryKey: ['organization'] });
      throw err;
    }
    qc.setQueryData(['organization'], updated);
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  if (!org) return <div className="skeleton" style={{ width: 280 }} />;
  const edit = (label: string, key: keyof Organization, field?: string) =>
    canWrite ? <InlineEdit label={label} field={field ?? (key as string)} value={(org[key] as string | null) ?? ''} onSave={(v) => save({ [key]: v } as Partial<Organization>)} /> : ((org[key] as string | null) ?? '—');
  return (
    <>
      <section aria-labelledby="club">
        <h2 id="club" style={{ marginBottom: 'var(--s-4)' }}>Verein</h2>
        <dl className="facts">
          <dt>Name</dt>
          <dd>{canWrite ? <InlineEdit label="Name des Vereins" value={org.name} onSave={(name) => save({ name })} /> : org.name}</dd>
          <dt>Zeitzone</dt>
          <dd>{org.timeZone}</dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="letterhead">
        <h2 id="letterhead">Briefkopf und Bankverbindung</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Steht auf jeder Rechnung. Mit IBAN druckt OpenVerein einen GiroCode, den Mitglieder mit der Banking-App scannen.</p>
        <dl className="facts">
          <dt>Straße</dt><dd>{edit('Straße', 'street')}</dd>
          <dt>PLZ</dt><dd>{edit('PLZ', 'postalCode')}</dd>
          <dt>Ort</dt><dd>{edit('Ort', 'city')}</dd>
          <dt>E-Mail</dt><dd>{edit('E-Mail', 'email')}</dd>
          <dt>Bank</dt><dd>{edit('Bank', 'bankName')}</dd>
          <dt>IBAN</dt><dd>{edit('IBAN', 'iban')}</dd>
          <dt>BIC</dt><dd>{edit('BIC', 'bic')}</dd>
          <dt>Gläubiger-ID</dt>
          <dd>{edit('Gläubiger-Identifikationsnummer', 'creditorId')}<p className="meta">Für SEPA-Lastschriften, von der Bundesbank vergeben (z. B. DE98ZZZ09999999999).</p></dd>
          <dt>Vorabankündigung</dt>
          <dd>
            <div className="inline-edit">
              <input className="input" type="number" min={1} max={60} style={{ width: 88 }} aria-label="Vorabankündigung in Tagen" disabled={!canWrite} defaultValue={org.prenotificationDays} onBlur={(e) => Number(e.target.value) !== org.prenotificationDays && void save({ prenotificationDays: Number(e.target.value) })} />
              <span>Tage zwischen Rechnung und Lastschrift</span>
            </div>
            <p className="meta">Standard sind 14 Tage. Eine kürzere Frist nur, wenn sie im Mandat vereinbart ist.</p>
          </dd>
          <dt>Verwendungszweck</dt>
          <dd>{edit('Verwendungszweck der Lastschrift', 'remittanceTemplate')}<p className="meta">Bis 140 Zeichen. Platzhalter: {'{{rechnungsnummer}}'}, {'{{mitgliedsnummer}}'}, {'{{zeitraum}}'}, {'{{verein}}'}.</p></dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="einvoice">
        <h2 id="einvoice">Steuer und E-Rechnung</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Für Rechnungen an Firmen und Behörden, die eine E-Rechnung (XRechnung) verlangen. Mitgliedsbeiträge gehen als nicht steuerbar hinein.</p>
        <dl className="facts">
          <dt>USt-IdNr.</dt><dd>{edit('USt-IdNr.', 'vatId')}</dd>
          <dt>Steuernummer</dt><dd>{edit('Steuernummer', 'taxNumber')}</dd>
          <dt>Vereinsregister</dt><dd>{edit('Vereinsregister', 'registerNumber')}<p className="meta">Zum Beispiel „VR 1234, Amtsgericht Musterstadt“.</p></dd>
          <dt>Ansprechperson</dt><dd>{edit('Ansprechperson für E-Rechnungen', 'einvoiceContactName')}</dd>
          <dt>Telefon</dt><dd>{edit('Telefon für E-Rechnungen', 'einvoiceContactPhone')}</dd>
          <dt>Kleinunternehmer</dt>
          <dd><label className="check"><input type="checkbox" disabled={!canWrite} checked={org.smallBusiness} onChange={(e) => void save({ smallBusiness: e.target.checked })} /> Umsatzsteuer wird nach § 19 UStG nicht erhoben</label></dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="invoicing">
        <h2 id="invoicing">Rechnungen</h2>
        <dl className="facts">
          <dt>Rechnungsnummern</dt><dd>{edit('Muster für Rechnungsnummern', 'invoiceNumberPattern')}</dd>
          <dt>Stornonummern</dt><dd>{edit('Muster für Stornonummern', 'cancellationNumberPattern')}</dd>
          <dt>Zahlungsziel</dt>
          <dd>
            <div className="inline-edit">
              <input className="input" type="number" min={0} max={120} style={{ width: 88 }} aria-label="Zahlungsziel in Tagen" disabled={!canWrite} defaultValue={org.paymentTermsDays} onBlur={(e) => Number(e.target.value) !== org.paymentTermsDays && void save({ paymentTermsDays: Number(e.target.value) })} />
              <span>Tage nach Rechnungsdatum</span>
            </div>
          </dd>
          <dt>Standardtexte</dt>
          <dd>
            <div className="field"><label htmlFor="cover-tpl">Über den Positionen</label><textarea id="cover-tpl" className="textarea" rows={3} style={{ maxWidth: '60ch' }} disabled={!canWrite} defaultValue={org.invoiceCoverTemplate ?? ''} onBlur={(e) => e.target.value.trim() !== (org.invoiceCoverTemplate ?? '') && void save({ invoiceCoverTemplate: e.target.value })} /></div>
            <div className="field"><label htmlFor="closing-tpl">Unter den Positionen</label><textarea id="closing-tpl" className="textarea" rows={3} style={{ maxWidth: '60ch' }} disabled={!canWrite} defaultValue={org.invoiceClosingTemplate ?? ''} onBlur={(e) => e.target.value.trim() !== (org.invoiceClosingTemplate ?? '') && void save({ invoiceClosingTemplate: e.target.value })} /></div>
            <p className="meta" style={{ maxWidth: '60ch' }}>Gelten für jede Rechnung ohne eigenen Text, auch im Beitragslauf. Platzhalter: {Object.keys(INVOICE_TEXT_PLACEHOLDERS).map((k) => `{{${k}}}`).join(', ')}.</p>
          </dd>
          <dt>Mahnstufen</dt>
          <dd>
            <ol className="timeline">
              {org.dunningLevels.map((l) => (
                <li key={l.level} style={{ gridTemplateColumns: '2rem 1fr' }}><span className="num">{l.level}.</span><span>{l.label} <span className="muted">nach {l.days} Tagen{l.feeCents > 0 && `, Gebühr ${(l.feeCents / 100).toFixed(2).replace('.', ',')} €`}</span></span></li>
              ))}
            </ol>
            <p className="meta">Änderbar über die API (<code>PATCH /api/v1/organization</code>, Feld dunningLevels).</p>
          </dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="membership">
        <h2 id="membership">Mitgliedschaft</h2>
        <dl className="facts">
          <dt>Mitgliedsnummern</dt>
          <dd>
            {canWrite ? <InlineEdit label="Muster für Mitgliedsnummern" field="memberNumberPattern" value={org.memberNumberPattern} onSave={(memberNumberPattern) => save({ memberNumberPattern })} /> : org.memberNumberPattern}
            <p className="meta">Platzhalter: {'{seq}'} fortlaufend, {'{seq:4}'} vierstellig, {'{YYYY}'} Eintrittsjahr (zählt dann pro Jahr neu).</p>
          </dd>
          <dt>Kündigungsfrist</dt>
          <dd>
            <div className="inline-edit">
              <input className="input" type="number" min={0} max={104} style={{ width: 88 }} aria-label="Kündigungsfrist in Wochen" disabled={!canWrite} defaultValue={org.noticeWeeks} onBlur={(e) => Number(e.target.value) !== org.noticeWeeks && void save({ noticeWeeks: Number(e.target.value) })} />
              <span>Wochen</span>
              <select className="select" aria-label="Austritt möglich" disabled={!canWrite} value={org.exitAt} onChange={(e) => void save({ exitAt: e.target.value as Organization['exitAt'] })}>
                {Object.entries(EXIT_AT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <p className="meta">So steht es meist in der Satzung. OpenVerein schlägt damit das Austrittsdatum vor.</p>
          </dd>
          <dt>Glückwünsche</dt>
          <dd>
            <div className="inline-edit" style={{ flexWrap: 'wrap' }}>
              <select className="select" aria-label="Geburtstagsgrüße per E-Mail" disabled={!canWrite} value={org.birthdayGreetings} onChange={(e) => void save({ birthdayGreetings: e.target.value as Organization['birthdayGreetings'] })}>
                <option value="off">keine Geburtstagsgrüße</option>
                <option value="round">zu runden Geburtstagen</option>
                <option value="all">zu jedem Geburtstag</option>
              </select>
              <label className="check"><input type="checkbox" disabled={!canWrite} checked={org.anniversaryGreetings} onChange={(e) => void save({ anniversaryGreetings: e.target.checked })} /> zu Vereinsjubiläen</label>
            </div>
            <p className="meta">Per E-Mail am Tag selbst, an aktive Mitglieder mit E-Mail-Adresse. Jubiläen ab 10 Jahren, alle 5 Jahre. Die Texte änderst Du unter <Link to="/einstellungen/email" style={{ whiteSpace: 'nowrap' }}>Einstellungen → E-Mail → Texte</Link>.</p>
          </dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="portal">
        <h2 id="portal">Mitgliederportal</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Was Mitglieder im Portal tun können. Jede Gruppe kann einzelne Punkte für ihre Mitglieder erlauben oder verbieten (Gruppen → Gruppe → Im Portal); ein Verbot geht vor.</p>
        <ul className="check-list">
          {PORTAL_FEATURE_KEYS.map((k) => (
            <li key={k}><label className="check"><input type="checkbox" disabled={!canWrite} checked={org.portalFeatures[k] ?? true} onChange={(e) => void save({ portalFeatures: { ...org.portalFeatures, [k]: e.target.checked } })} /> {PORTAL_FEATURES[k]}</label></li>
          ))}
        </ul>
      </section>
    </>
  );
}
