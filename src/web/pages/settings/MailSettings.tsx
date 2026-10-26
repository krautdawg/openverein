import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../../shared/auth.ts';
import type { SystemTemplateKey } from '../../../shared/mail.ts';
import type { Organization } from '../../../shared/organization.ts';
import { InlineEdit } from '../../components/InlineEdit.tsx';
import { Sheet } from '../../components/Sheet.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

export interface MailTemplate { id: string; key: SystemTemplateKey | null; name: string; subject: string; body: string; category: 'notice' | 'newsletter'; custom: boolean }

export function MailSettings({ me }: { me: Me }) {
  useTitle('E-Mail');
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const canSend = me.permissions.communication === 'write';
  const { data: org } = useQuery({ queryKey: ['organization'], queryFn: () => api<Organization>('/organization') });
  const templates = useQuery({ queryKey: ['mail-templates'], queryFn: () => api<MailTemplate[]>('/mail-templates') });
  const [test, setTest] = useState<{ ok: boolean; text: string; hints?: string[] }>();
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<MailTemplate | null>(null);
  const [unblock, setUnblock] = useState<string>();

  async function save(body: Partial<Organization>) {
    qc.setQueryData(['organization'], await api<Organization>('/organization', { method: 'PATCH', body, ifMatch: qc.getQueryData<Organization>(['organization'])?.version }));
  }
  async function sendTest() {
    setBusy(true);
    try {
      const r = await api<{ to: string; hints: string[] }>('/mail/test', { method: 'POST', body: {} });
      setTest({ ok: true, text: `Test-E-Mail an ${r.to} ist beim Mailserver angekommen.`, hints: r.hints });
    } catch (err) {
      setTest({ ok: false, text: err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.' });
    } finally {
      setBusy(false);
    }
  }

  if (!org) return <div className="skeleton" style={{ width: 280 }} />;
  const edit = (label: string, key: 'mailFromName' | 'mailFromAddress' | 'mailReplyTo', placeholder: string) =>
    canWrite ? <InlineEdit label={label} field={key} value={org[key] ?? ''} onSave={(v) => save({ [key]: v || null })} /> : (org[key] ?? <span className="muted">{placeholder}</span>);
  return (
    <>
      <section aria-labelledby="sender">
        <h2 id="sender" style={{ marginBottom: 'var(--s-2)' }}>Absender</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>OpenVerein verschickt über den Mailserver, der beim Betrieb eingetragen ist (SMTP_URL). Die Absenderadresse muss dieser Mailserver senden dürfen.</p>
        <dl className="facts">
          <dt>Name</dt><dd>{edit('Absendername', 'mailFromName', org.name)}</dd>
          <dt>Adresse</dt><dd>{edit('Absenderadresse', 'mailFromAddress', 'Standard des Servers')}</dd>
          <dt>Antworten an</dt><dd>{edit('Antwortadresse', 'mailReplyTo', 'an den Absender')}</dd>
          <dt>Tempo</dt><dd>{canWrite ? <InlineEdit label="E-Mails pro Minute" field="mailPerMinute" value={String(org.mailPerMinute)} display={(v) => `${v} E-Mails pro Minute`} onSave={(v) => save({ mailPerMinute: Number(v) })} /> : `${org.mailPerMinute} E-Mails pro Minute`}</dd>
        </dl>
        {org.mailPausedReason && (
          <div className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-4)', maxWidth: '70ch' }}>
            Versand angehalten: {org.mailPausedReason}. Prüf SMTP-Zugang und Absenderadresse, schick Dir eine Test-E-Mail und setz den Versand dann fort.
          </div>
        )}
        {canWrite && (
          <div className="actions-row">
            <button className="btn" aria-busy={busy} disabled={busy} onClick={() => void sendTest()}>Test-E-Mail an mich</button>
            {org.mailPausedReason && <button className="btn btn-primary" onClick={() => void api('/mail/resume', { method: 'POST', body: {} }).then(() => Promise.all([qc.invalidateQueries({ queryKey: ['organization'] }), qc.invalidateQueries({ queryKey: ['mail-status'] })]))}>Versand fortsetzen</button>}
          </div>
        )}
        {test && (
          <div className={`alert ${test.ok ? 'alert-ok' : 'alert-error'}`} role="status" style={{ marginTop: 'var(--s-3)', maxWidth: '70ch' }}>
            {test.text}
            {test.hints && <ul style={{ margin: 'var(--s-2) 0 0', paddingLeft: '1.2em' }}>{test.hints.map((h) => <li key={h}>{h}</li>)}</ul>}
          </div>
        )}
      </section>

      <section className="section" aria-labelledby="texts">
        <h2 id="texts">Texte</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Diese Texte nutzt OpenVerein beim Rechnungs- und Mahnversand, für Einladungen und Glückwünsche. Eigene Vorlagen legst Du beim Schreiben einer E-Mail an.</p>
        <ul className="timeline">
          {templates.data?.map((t) => (
            <li key={t.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <span><span className="name">{t.name}</span>{t.key && <span className="pill" style={{ marginLeft: 8 }}>{t.custom ? 'angepasst' : 'Standard'}</span>}<div className="meta">{t.subject}</div></span>
              {(t.key ? canWrite : canSend) && <button className="btn btn-ghost" onClick={() => setEditing(t)}>Bearbeiten</button>}
            </li>
          ))}
        </ul>
      </section>

      {canSend && (
        <section className="section" aria-labelledby="blocked">
          <h2 id="blocked">Gesperrte Adressen</h2>
          <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Unzustellbare Adressen bekommen keine E-Mails mehr. Wenn ein Mitglied sein Postfach repariert hat, gib die Adresse hier wieder frei. Abmeldungen vom Rundschreiben bleiben bestehen.</p>
          <form className="inline-form narrow" noValidate onSubmit={(e) => {
            e.preventDefault();
            const email = String(new FormData(e.currentTarget).get('email') ?? '');
            void api<{ removed: boolean }>('/mail/unblock', { method: 'POST', body: { email } }).then((r) => setUnblock(r.removed ? `${email} ist wieder freigegeben.` : `${email} war nicht gesperrt.`), (err) => setUnblock(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : 'Das hat nicht geklappt.'));
          }}>
            <div className="field"><label htmlFor="unblock">E-Mail-Adresse</label><input id="unblock" name="email" type="email" className="input" autoComplete="off" /></div>
            <button className="btn">Freigeben</button>
          </form>
          {unblock && <p role="status" className="meta">{unblock}</p>}
        </section>
      )}
      <TemplateSheet template={editing} onClose={() => setEditing(null)} onSaved={() => void qc.invalidateQueries({ queryKey: ['mail-templates'] })} />
    </>
  );
}

export function TemplateSheet({ template, onClose, onSaved }: { template: MailTemplate | null; onClose: () => void; onSaved: () => void }) {
  const [error, setError] = useState<string>();
  return (
    <Sheet title={template?.name ?? 'Vorlage'} open={!!template} onClose={onClose}>
      {template && (
        <form key={template.id} noValidate onSubmit={(e) => {
          e.preventDefault();
          const f = new FormData(e.currentTarget);
          setError(undefined);
          void api(`/mail-templates/${template.id}`, { method: 'PUT', body: { name: f.get('name') ?? template.name, subject: f.get('subject'), body: f.get('body'), category: template.category } }).then(() => { onSaved(); onClose(); }, (err) => setError(err instanceof ApiError ? (err.problem.errors?.map((x) => x.message).join(' ') ?? err.problem.title) : 'Das hat nicht geklappt.'));
        }}>
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          {!template.key && <div className="field"><label htmlFor="tname">Name</label><input id="tname" name="name" className="input" defaultValue={template.name} /></div>}
          <div className="field"><label htmlFor="tsubj">Betreff</label><input id="tsubj" name="subject" className="input" defaultValue={template.subject} /></div>
          <div className="field"><label htmlFor="tbody">Text</label><textarea id="tbody" name="body" className="textarea" style={{ minHeight: 280 }} defaultValue={template.body} /></div>
          <div className="actions-row">
            <button className="btn btn-primary">Speichern</button>
            {template.custom && <button type="button" className="btn btn-ghost" onClick={() => void api(`/mail-templates/${template.id}`, { method: 'DELETE' }).then(() => { onSaved(); onClose(); })}>{template.key ? 'Auf Standard zurücksetzen' : 'Löschen'}</button>}
          </div>
        </form>
      )}
    </Sheet>
  );
}
