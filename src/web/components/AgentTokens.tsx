import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CHANNEL_LABEL, TOKEN_ACCESS_LABEL, type PersonalTokenDto } from '../../shared/agents.ts';
import { formatDate } from '../../shared/dates.ts';
import { api, ApiError } from '../lib/api.ts';
import { Field } from './Field.tsx';

const time = (iso: string) => new Date(iso).toLocaleString('de-DE', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });

/**
 * Personal tokens for agents, shared by the admin settings and the portal: create (shown once), connected agents
 * with their last calls, revoke. The token acts as the signed-in person: `whoAmI` is the call that proves it.
 */
export function AgentTokens({ base, whoAmI, modules }: { base: '/personal-tokens' | '/portal/tokens'; whoAmI: string; modules?: { key: string; label: string }[] }) {
  const qc = useQueryClient();
  const key = ['agent-tokens', base];
  const tokens = useQuery({ queryKey: key, queryFn: () => api<PersonalTokenDto[]>(base) });
  const [secret, setSecret] = useState<string>();
  const [error, setError] = useState<ApiError>();
  const [limited, setLimited] = useState(false);
  const [busy, setBusy] = useState(false);

  async function create(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = e.currentTarget;
    const f = new FormData(form);
    setError(undefined);
    setBusy(true);
    try {
      const body = { name: f.get('name'), access: f.get('access'), expiresInDays: Number(f.get('days')), ...(modules && limited ? { modules: f.getAll('modules') } : {}) };
      const r = await api<{ token: string }>(base, { method: 'POST', body });
      setSecret(r.token);
      form.reset();
      setLimited(false);
      await qc.invalidateQueries({ queryKey: key });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function revoke(id: string) {
    await api(`${base}/${id}/revoke`, { method: 'POST' });
    await qc.invalidateQueries({ queryKey: key });
  }

  const live = tokens.data?.filter((t) => !t.revoked && t.expiresAt > new Date().toISOString()) ?? [];
  const gone = tokens.data?.filter((t) => !live.includes(t)) ?? [];
  const op = whoAmI === '/auth/me' ? 'getAuthMe' : 'getPortalMe';
  const cli = secret && `curl -fsSLO ${location.origin}/ov.mjs\nexport OV_URL=${location.origin} OV_TOKEN=${secret}\nnode ov.mjs ${op}`;
  const claudeCode = secret && `claude mcp add --transport http openverein ${location.origin}/mcp --header "Authorization: Bearer ${secret}"`;

  return (
    <div className="agents">
      {secret && (
        <section className="alert alert-ok agents-once" role="status" aria-labelledby="agents-once-h">
          <h3 id="agents-once-h">Dein Token. Es wird nur jetzt angezeigt.</h3>
          <div className="token-once">{secret}</div>
          <div className="actions-row" style={{ marginTop: 'var(--s-2)' }}>
            <button className="btn" onClick={() => void navigator.clipboard?.writeText(secret)}>Token kopieren</button>
          </div>
          <p className="agents-step">Claude Code oder ein anderer MCP-Client verbindet sich so:</p>
          <pre className="agents-code">{claudeCode}</pre>
          <p className="agents-step">Oder im Terminal, mit der Kommandozeile <code>ov</code>. Damit fragst Du, wer Du bist:</p>
          <pre className="agents-code">{cli}</pre>
          <p className="agents-step">Alle Operationen stehen unter <a href="/api/docs" target="_blank" rel="noreferrer">/api/docs</a>.</p>
        </section>
      )}

      <form className="inline-form agents-form" onSubmit={create} noValidate aria-label="Neues Agenten-Token">
        {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.detail ?? error.problem.title}</div>}
        <Field label="Für welchen Agenten?" name="name" placeholder="Claude auf meinem Laptop" required error={error?.fieldError('name')} />
        <fieldset className="agents-access">
          <legend>Was darf er?</legend>
          {(['read', 'write'] as const).map((a) => (
            <label key={a} className="radio-row">
              <input type="radio" name="access" value={a} defaultChecked={a === 'read'} />
              <span><strong>{TOKEN_ACCESS_LABEL[a]}</strong><span className="meta"> {a === 'read' ? 'Sehen, was Du siehst.' : 'Auch ändern, was Du ändern darfst.'}</span></span>
            </label>
          ))}
        </fieldset>
        {modules && (
          <fieldset className="agents-access">
            <legend>Bereiche</legend>
            <label className="radio-row"><input type="checkbox" checked={limited} onChange={(e) => setLimited(e.target.checked)} /><span>Nur bestimmte Bereiche</span></label>
            {limited && (
              <div className="agents-modules">
                {modules.map((m) => <label key={m.key} className="radio-row"><input type="checkbox" name="modules" value={m.key} /><span>{m.label}</span></label>)}
              </div>
            )}
            {error?.fieldError('modules') && <p className="field-error">{error.fieldError('modules')}</p>}
          </fieldset>
        )}
        <div className="field" style={{ maxWidth: 240 }}>
          <label htmlFor="agent-days">Gültig für</label>
          <select id="agent-days" name="days" className="select" defaultValue="90"><option value="30">30 Tage</option><option value="90">90 Tage</option><option value="365">1 Jahr</option></select>
        </div>
        <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary" disabled={busy}>Token erstellen</button></div>
      </form>

      <section aria-labelledby="agents-live-h">
        <h3 id="agents-live-h" className="agents-h">Verbundene Agenten</h3>
        {tokens.data && live.length === 0 && <p className="muted">Noch keiner. Ein Token reicht für einen Agenten; widerrufen kannst Du es jederzeit.</p>}
        <ul className="agents-list">
          {live.map((t) => <TokenRow key={t.id} t={t} onRevoke={() => void revoke(t.id)} />)}
        </ul>
        {gone.length > 0 && (
          <details className="agents-gone">
            <summary>Widerrufen oder abgelaufen ({gone.length})</summary>
            <ul className="agents-list">{gone.map((t) => <TokenRow key={t.id} t={t} />)}</ul>
          </details>
        )}
      </section>
    </div>
  );
}

function TokenRow({ t, onRevoke }: { t: PersonalTokenDto; onRevoke?: () => void }) {
  return (
    <li className="agents-row">
      <div className="agents-row-head">
        <div>
          <span className="name">{t.name}</span> <span className="pill">{TOKEN_ACCESS_LABEL[t.access]}</span>
          {t.modules && <span className="pill">{t.modules.length} {t.modules.length === 1 ? 'Bereich' : 'Bereiche'}</span>}
          {t.viaOAuth && <span className="pill">verbunden per OAuth</span>}
          <div className="meta">
            {t.revoked ? 'widerrufen' : `gültig bis ${formatDate(t.expiresAt.slice(0, 10))}`} · {t.lastUsedAt ? `zuletzt ${time(t.lastUsedAt)}` : 'noch nie benutzt'} · {t.calls24h} {t.calls24h === 1 ? 'Aufruf' : 'Aufrufe'} in 24 Std.
          </div>
        </div>
        {onRevoke && <button className="btn btn-ghost btn-danger" onClick={onRevoke} aria-label={`${t.name} widerrufen`}>Widerrufen</button>}
      </div>
      {t.recentCalls.length > 0 && (
        <ol className="agents-log" aria-label={`Letzte Aufrufe von ${t.name}`}>
          {t.recentCalls.map((c, i) => (
            <li key={i} data-ok={c.status < 400}>
              <span className="agents-log-op">{c.operation}</span>
              <span className="agents-log-status">{c.status}</span>
              <span className="agents-log-meta">{CHANNEL_LABEL[c.channel]} · {time(c.at)}</span>
            </li>
          ))}
        </ol>
      )}
    </li>
  );
}
