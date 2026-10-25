import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../../shared/auth.ts';
import { WEBHOOK_TOPICS } from '../../../shared/webhooks.ts';
import { Field } from '../../components/Field.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface Hook { id: string; url: string; topics: string[]; active: boolean; createdAt: string; counts: { sent: number; queued: number; failed: number } }
interface Delivery { id: string; event: string; occurredAt: string; status: string; attempts: number; responseStatus: number | null; error: string | null }
const STATUS: Record<string, string> = { queued: 'wartet', sending: 'wird gesendet', sent: 'zugestellt', failed: 'fehlgeschlagen' };

/** Webhooks: the club's website or tools hear about changes; payloads carry ids, details come from the API. */
export function Webhooks({ me }: { me: Me }) {
  useTitle('Webhooks');
  const qc = useQueryClient();
  const hooks = useQuery({ queryKey: ['webhooks'], queryFn: () => api<Hook[]>('/webhooks'), retry: false });
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<ApiError>();
  const [open, setOpen] = useState<string | null>(null);
  const canWrite = me.permissions.settings === 'write' && me.permissions.api === 'write';
  const refresh = () => qc.invalidateQueries({ queryKey: ['webhooks'] });

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(undefined);
    try {
      const r = await api<{ secret: string }>('/webhooks', { method: 'POST', body: { url: f.get('url'), topics: f.getAll('topics') } });
      setSecret(r.secret);
      form.reset();
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <section aria-labelledby="wh-title">
      <h2 id="wh-title" style={{ marginBottom: 'var(--s-2)' }}>Webhooks</h2>
      <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>
        OpenVerein meldet Änderungen an eine Adresse Deiner Website oder eines Werkzeugs, etwa wenn ein Mitglied angelegt wird. Die Nachricht enthält nur Art und Kennung; die Details holt der Empfänger mit einem API-Schlüssel. Jede Nachricht ist signiert (Kopfzeile X-OpenVerein-Signature) und wird bei Fehlern bis zu sechsmal wiederholt.
      </p>
      {hooks.error && <div className="alert alert-error" role="alert">{hooks.error instanceof ApiError ? hooks.error.problem.title : 'Nicht verfügbar.'}</div>}
      {secret && <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-4)' }}>Geheimnis zum Prüfen der Signatur (nur jetzt sichtbar): <code style={{ wordBreak: 'break-all' }}>{secret}</code></div>}
      {canWrite && !hooks.error && (
        <form className="form" style={{ maxWidth: 640, marginBottom: 'var(--s-6)' }} noValidate onSubmit={(e) => void create(e)} aria-label="Neuer Webhook">
          {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.title}</div>}
          <Field label="Adresse (https)" name="url" type="url" placeholder="https://www.mein-verein.de/openverein-hook" error={error?.fieldError('url')} />
          <fieldset className="checks">
            <legend>Themen</legend>
            {Object.entries(WEBHOOK_TOPICS).map(([k, v]) => <label key={k} className="check"><input type="checkbox" name="topics" value={k} defaultChecked={k === 'member'} /> {v}</label>)}
          </fieldset>
          <div className="actions-row"><button className="btn btn-primary">Webhook anlegen</button></div>
        </form>
      )}
      <ul className="timeline" aria-label="Webhooks">
        {hooks.data?.length === 0 && <li style={{ gridTemplateColumns: '1fr' }}><span className="muted">Noch keine Webhooks.</span></li>}
        {hooks.data?.map((h) => (
          <li key={h.id} style={{ gridTemplateColumns: '1fr auto' }}>
            <span>
              <span className="name" style={{ wordBreak: 'break-all' }}>{h.url}</span>
              <span className="meta" style={{ display: 'block' }}>{h.topics.map((t) => WEBHOOK_TOPICS[t as keyof typeof WEBHOOK_TOPICS] ?? t).join(', ')} · {h.counts.sent} zugestellt{h.counts.queued ? `, ${h.counts.queued} wartend` : ''}{h.counts.failed ? `, ${h.counts.failed} fehlgeschlagen` : ''}{h.active ? '' : ' · ausgeschaltet'}</span>
              {open === h.id && <Deliveries id={h.id} />}
            </span>
            <span className="actions-inline">
              <button className="btn btn-ghost" aria-expanded={open === h.id} onClick={() => setOpen(open === h.id ? null : h.id)}>Zustellungen</button>
              {canWrite && <button className="btn btn-ghost" onClick={() => void api(`/webhooks/${h.id}/test`, { method: 'POST' }).then(refresh)}>Test senden</button>}
              {canWrite && <button className="btn btn-ghost" onClick={() => void api(`/webhooks/${h.id}`, { method: 'PATCH', body: { active: !h.active } }).then(refresh)}>{h.active ? 'Ausschalten' : 'Einschalten'}</button>}
              {canWrite && <button className="btn btn-ghost" onClick={() => void api(`/webhooks/${h.id}`, { method: 'DELETE' }).then(refresh)}>Löschen</button>}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Deliveries({ id }: { id: string }) {
  const d = useQuery({ queryKey: ['webhook-deliveries', id], queryFn: () => api<Delivery[]>(`/webhooks/${id}/deliveries`), refetchInterval: 5000 });
  if (!d.data?.length) return <p className="meta">Noch keine Zustellungen.</p>;
  return (
    <ul className="meta" style={{ margin: 'var(--s-2) 0 0', paddingLeft: 'var(--s-4)' }}>
      {d.data.map((x) => <li key={x.id}>{new Date(x.occurredAt).toLocaleString('de-DE')} · {x.event} · {STATUS[x.status] ?? x.status}{x.attempts > 1 ? ` (${x.attempts}. Versuch)` : ''}{x.error ? `: ${x.error}` : ''}</li>)}
    </ul>
  );
}
