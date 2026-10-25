import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { PLACEHOLDERS } from '../../shared/mail.ts';
import { useCustomFields } from '../components/CustomFields.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { CommunicationNav } from './Polls.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useGroups } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';
import type { MailTemplate } from './settings/MailSettings.tsx';

interface Recipients { recipients: { memberId: string; name: string; email: string }[]; excluded: { memberId: string; name: string; reason: string }[] }
interface Message { id: string; kind: 'free' | 'invoices'; category: 'notice' | 'newsletter'; subject: string; body: string; status: 'sending' | 'sent'; createdBy: string; createdAt: string; counts: { total: number; sent: number; queued: number; failed: number } }
interface Delivery { id: string; memberId: string | null; name: string; email: string; status: string; error: string | null; sentAt: string | null; invoiceNumber: string | null }

const DELIVERY_LABEL: Record<string, string> = { queued: 'Wartet', sending: 'Wird gesendet', sent: 'Zugestellt an den Mailserver', failed: 'Fehlgeschlagen', bounced: 'Unzustellbar', skipped: 'Ausgelassen' };

export function Communication({ me }: { me: Me }) {
  useTitle('Kommunikation');
  const qc = useQueryClient();
  const navigate = useNavigate();
  const { id } = useParams();
  const location = useLocation();
  const state = location.state as { memberIds?: string[]; groupId?: string } | null;
  const picked = state?.memberIds ?? null;
  const canWrite = me.permissions.communication === 'write';
  const { data: groups } = useGroups();
  const [mode, setMode] = useState<'all' | 'group' | 'members'>(picked ? 'members' : state?.groupId ? 'group' : 'all');
  const [groupId, setGroupId] = useState(state?.groupId ?? '');
  const [category, setCategory] = useState<'notice' | 'newsletter'>('notice');
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('Hallo {{vorname}},\n\n\n\nViele Grüße\n{{verein}}');
  const [confirming, setConfirming] = useState(false);
  const [showExcluded, setShowExcluded] = useState(false);
  const [error, setError] = useState<ApiError>();
  const [done, setDone] = useState<string>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const filter = { mode, groupId: mode === 'group' ? groupId || undefined : undefined, memberIds: mode === 'members' ? (picked ?? []) : undefined };
  const ready = mode !== 'group' || !!groupId;

  const recipients = useQuery({ queryKey: ['recipients', mode, groupId, category, picked], queryFn: () => api<Recipients>('/messages/recipients', { method: 'POST', body: { filter, category } }), enabled: canWrite && ready });
  const first = recipients.data?.recipients[0];
  const [preview, setPreview] = useState<{ subject: string; body: string }>();
  const previewSeq = useRef(0);
  useEffect(() => {
    if (!first) return setPreview(undefined);
    // Only the newest request may update the preview; slower older answers are dropped.
    const seq = ++previewSeq.current;
    const t = setTimeout(() => void api<{ subject: string; body: string }>('/messages/preview', { method: 'POST', body: { subject, body, memberId: first.memberId } }).then((p) => seq === previewSeq.current && setPreview(p), () => undefined), 300);
    return () => clearTimeout(t);
  }, [subject, body, first]);
  const [sending, setSending] = useState(false);
  const org = useQuery({ queryKey: ['organization'], queryFn: () => api<{ mailPausedReason: string | null }>('/organization') });
  const templates = useQuery({ queryKey: ['mail-templates'], queryFn: () => api<MailTemplate[]>('/mail-templates'), enabled: canWrite });
  const own = templates.data?.filter((t) => !t.key) ?? [];
  const [naming, setNaming] = useState<string | null>(null);
  async function saveTemplate(name: string) {
    await api('/mail-templates', { method: 'POST', body: { name, subject, body, category } });
    setNaming(null);
    setDone(`Vorlage „${name}“ gespeichert.`);
    await qc.invalidateQueries({ queryKey: ['mail-templates'] });
  }
  const messages = useQuery({ queryKey: ['messages'], queryFn: () => api<Message[]>('/messages'), refetchInterval: (q) => (q.state.data?.some((m) => m.status === 'sending') ? 3000 : false) });

  const { data: customFields } = useCustomFields();
  function insert(key: string) {
    const el = textRef.current;
    const token = `{{${key}}}`;
    if (!el) return setBody((b) => b + token);
    const start = el.selectionStart;
    const next = body.slice(0, start) + token + body.slice(el.selectionEnd);
    setBody(next);
    requestAnimationFrame(() => { el.focus(); el.selectionStart = el.selectionEnd = start + token.length; });
  }

  async function send() {
    if (sending) return;
    setSending(true);
    setError(undefined);
    try {
      const m = await api<Message>('/messages', { method: 'POST', body: { subject, body, category, filter } });
      setDone(`Unterwegs an ${m.counts.total} Empfänger:innen. Den Stand siehst Du unten.`);
      setConfirming(false);
      setSubject('');
      await qc.invalidateQueries({ queryKey: ['messages'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
      setConfirming(false);
    } finally {
      setSending(false);
    }
  }

  const count = recipients.data?.recipients.length ?? 0;
  return (
    <div className="page">
      <PageHead title="Kommunikation" intro="E-Mails an Mitglieder, über den Mailserver des Vereins. Wer keine Adresse hat oder nicht mehr Mitglied ist, wird angezeigt und ausgelassen." />
      <CommunicationNav />
      {org.data?.mailPausedReason && (
        <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-5)', maxWidth: '80ch' }}>
          Der Versand ist angehalten, weil der Mailserver die Anmeldung oder den Absender abgelehnt hat: {org.data.mailPausedReason}. Neue E-Mails warten, bis jemand mit Einstellungsrechten den Versand unter <Link to="/einstellungen/email">Einstellungen → E-Mail</Link> fortsetzt.
        </div>
      )}
      {canWrite && (
        <section className="compose" aria-label="Neue E-Mail">
          <div className="compose-form">
            {done && <div className="alert alert-ok" role="status">{done}</div>}
            {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((e) => e.message).join(' ') ?? [error.problem.title, error.problem.detail].filter(Boolean).join(' ')}</div>}
            <div className="field">
              <span className="label">An</span>
              <div className="toolbar" style={{ marginBottom: 0 }}>
                <div className="segmented" role="group" aria-label="Empfänger">
                  <button aria-pressed={mode === 'all'} onClick={() => setMode('all')}>Alle aktuellen Mitglieder</button>
                  <button aria-pressed={mode === 'group'} onClick={() => setMode('group')}>Eine Gruppe</button>
                  {picked && <button aria-pressed={mode === 'members'} onClick={() => setMode('members')}>Auswahl ({picked.length})</button>}
                </div>
                {mode === 'group' && (
                  <select className="select" aria-label="Gruppe" value={groupId} onChange={(e) => setGroupId(e.target.value)}>
                    <option value="">Gruppe wählen</option>
                    {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
                  </select>
                )}
              </div>
              {recipients.data && (
                <p className="meta">
                  {count} Empfänger:innen{recipients.data.excluded.length > 0 && <>, {recipients.data.excluded.length} ausgelassen <button className="linklike" onClick={() => setShowExcluded((s) => !s)}>{showExcluded ? 'ausblenden' : 'anzeigen'}</button></>}
                </p>
              )}
              {showExcluded && <ul className="timeline">{recipients.data?.excluded.map((x) => <li key={x.memberId} style={{ gridTemplateColumns: '1fr auto' }}><span>{x.name}</span><span className="muted">{x.reason}</span></li>)}</ul>}
            </div>
            {own.length > 0 && (
              <div className="field">
                <label htmlFor="tpl">Vorlage</label>
                <select id="tpl" className="select" value="" onChange={(e) => { const t = own.find((x) => x.id === e.target.value); if (t) { setSubject(t.subject); setBody(t.body); setCategory(t.category); } }}>
                  <option value="">Vorlage laden …</option>
                  {own.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                </select>
              </div>
            )}
            <div className="field">
              <span className="label">Art</span>
              <div className="segmented" role="group" aria-label="Art">
                <button aria-pressed={category === 'notice'} onClick={() => setCategory('notice')}>Vereinsmitteilung</button>
                <button aria-pressed={category === 'newsletter'} onClick={() => setCategory('newsletter')}>Rundschreiben (abbestellbar)</button>
              </div>
            </div>
            <div className="field">
              <label htmlFor="subj">Betreff</label>
              <input id="subj" className="input" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Einladung zur Mitgliederversammlung" />
            </div>
            <div className="field">
              <label htmlFor="body">Text</label>
              <textarea id="body" ref={textRef} className="textarea" style={{ minHeight: 260 }} value={body} onChange={(e) => setBody(e.target.value)} />
              <div className="chips" aria-label="Platzhalter einfügen">
                {(['vorname', 'nachname', 'name', 'mitgliedsnummer', 'verein'] as const).map((k) => <button key={k} type="button" className="pill pill-button" title={PLACEHOLDERS[k]} onClick={() => insert(k)}>{`{{${k}}}`}</button>)}
                {customFields?.filter((f) => !f.archived && !f.sensitive).map((f) => <button key={f.id} type="button" className="pill pill-button" title={f.label} onClick={() => insert(`custom.${f.key}`)}>{`{{custom.${f.key}}}`}</button>)}
              </div>
            </div>
            <div className="actions-row">
              {confirming ? (
                <>
                  <span>Wirklich an {count} Empfänger:innen senden?</span>
                  <button className="btn btn-primary" aria-busy={sending} disabled={sending} onClick={() => void send()}>Ja, senden</button>
                  <button className="btn btn-ghost" onClick={() => setConfirming(false)}>Abbrechen</button>
                </>
              ) : (
                <>
                  <button className="btn btn-primary" disabled={!subject.trim() || !body.trim() || count === 0} onClick={() => setConfirming(true)}>An {count} senden</button>
                  {naming === null ? (
                    <button className="btn btn-ghost" disabled={!subject.trim() || !body.trim()} onClick={() => setNaming(subject)}>Als Vorlage speichern</button>
                  ) : (
                    <form className="inline-form" style={{ margin: 0 }} onSubmit={(e) => { e.preventDefault(); if (naming.trim()) void saveTemplate(naming.trim()); }}>
                      <input className="input" aria-label="Name der Vorlage" autoFocus value={naming} onChange={(e) => setNaming(e.target.value)} onKeyDown={(e) => e.key === 'Escape' && setNaming(null)} />
                      <button className="btn">Speichern</button>
                    </form>
                  )}
                </>
              )}
            </div>
          </div>
          <aside className="compose-preview" aria-label="Vorschau">
            <span className="meta">Vorschau{first && ` für ${first.name}`}</span>
            {preview ? (
              <article>
                <h3>{preview.subject || 'Ohne Betreff'}</h3>
                <p style={{ whiteSpace: 'pre-wrap' }}>{preview.body}</p>
                {category === 'newsletter' && <p className="meta">Unten steht automatisch ein Abmeldelink.</p>}
              </article>
            ) : (
              <p className="muted">Sobald es Empfänger:innen gibt, siehst Du hier die E-Mail mit eingesetzten Platzhaltern.</p>
            )}
          </aside>
        </section>
      )}

      <section className="section" aria-labelledby="sent">
        <h2 id="sent">Gesendet</h2>
        <div className="table-wrap">
          {messages.data?.length === 0 ? (
            <div className="empty-state"><h3>Noch nichts gesendet.</h3><p>Versendete E-Mails und ihre Zustellung erscheinen hier.</p></div>
          ) : (
            <table className="table" aria-label="Gesendete E-Mails">
              <thead><tr><th scope="col">Betreff</th><th scope="col" className="hide-sm">Von</th><th scope="col" className="num hide-sm">Datum</th><th scope="col" className="num">Zugestellt</th></tr></thead>
              <tbody>
                {messages.data?.map((m) => (
                  <tr key={m.id} data-href tabIndex={0} onClick={() => navigate(`/kommunikation/${m.id}`)} onKeyDown={(e) => e.key === 'Enter' && navigate(`/kommunikation/${m.id}`)}>
                    <td><span className="name">{m.subject}</span>{m.kind === 'invoices' && <span className="pill" style={{ marginLeft: 8 }}>Rechnungen</span>}{m.category === 'newsletter' && <span className="pill" style={{ marginLeft: 8 }}>Rundschreiben</span>}</td>
                    <td className="hide-sm">{m.createdBy}</td>
                    <td className="num hide-sm">{new Date(m.createdAt).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                    <td className="num">{m.counts.sent} / {m.counts.total}{m.counts.failed > 0 && <span style={{ color: 'var(--danger)' }}> · {m.counts.failed} Fehler</span>}{m.status === 'sending' && <span className="muted"> · läuft</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
      <MessageSheet id={id ?? null} canWrite={canWrite} onClose={() => navigate('/kommunikation')} />
    </div>
  );
}

function MessageSheet({ id, onClose, canWrite }: { id: string | null; onClose: () => void; canWrite: boolean }) {
  const qc = useQueryClient();
  const [bouncing, setBouncing] = useState<string | null>(null);
  const { data } = useQuery({ queryKey: ['message', id], queryFn: () => api<Message & { deliveries: Delivery[] }>(`/messages/${id}`), enabled: !!id, refetchInterval: (q) => (q.state.data?.status === 'sending' ? 3000 : false) });
  return (
    <Sheet title={data?.subject ?? 'Nachricht'} open={!!id} onClose={onClose}>
      {data && (
        <>
          <p className="meta" style={{ marginTop: 'calc(-1 * var(--s-3))', marginBottom: 'var(--s-4)' }}>{data.createdBy} · {new Date(data.createdAt).toLocaleString('de-DE')} · {data.counts.sent} von {data.counts.total} zugestellt</p>
          <section className="sheet-section"><p style={{ whiteSpace: 'pre-wrap' }}>{data.body}</p></section>
          <section className="sheet-section" aria-labelledby="dl">
            <h3 id="dl">Zustellung</h3>
            <ul className="timeline">
              {data.deliveries.map((d) => (
                <li key={d.id} style={{ gridTemplateColumns: '1fr auto' }}>
                  <span>{d.name}{d.invoiceNumber && <span className="muted"> · {d.invoiceNumber}</span>}<div className="meta">{d.email}{d.error && ` · ${d.error}`}</div></span>
                  <span>
                    <span className="status" data-s={d.status === 'sent' ? 'active' : d.status === 'queued' || d.status === 'sending' ? 'future' : 'rejected'}>{DELIVERY_LABEL[d.status]}</span>
                    {canWrite && d.status === 'sent' && (
                      <div className="meta">
                        {bouncing === d.id ? (
                          <>Adresse sperren? <button className="linklike" onClick={() => void api(`/deliveries/${d.id}/bounce`, { method: 'POST', body: {} }).then(() => { setBouncing(null); return qc.invalidateQueries({ queryKey: ['message', id] }); })}>Ja</button> · <button className="linklike" onClick={() => setBouncing(null)}>Nein</button></>
                        ) : (
                          <button className="linklike" onClick={() => setBouncing(d.id)} aria-label={`E-Mail an ${d.name} kam zurück`}>kam zurück?</button>
                        )}
                      </div>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}
    </Sheet>
  );
}
