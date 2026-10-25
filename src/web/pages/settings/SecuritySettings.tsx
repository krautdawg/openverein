import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { generate } from 'lean-qr';
import { toSvgDataURL } from 'lean-qr/extras/svg';
import type { Me } from '../../../shared/auth.ts';
import { Field } from '../../components/Field.tsx';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface Session { id: string; current: boolean; userAgent: string | null; createdAt: string; lastSeenAt: string }

/** Own account: second factor and active sessions. */
export function SecuritySettings({ me }: { me: Me }) {
  useTitle('Sicherheit');
  const qc = useQueryClient();
  const sessions = useQuery({ queryKey: ['sessions'], queryFn: () => api<Session[]>('/auth/sessions') });
  const [setup, setSetup] = useState<{ secret: string; uri: string }>();
  const [codes, setCodes] = useState<string[]>();
  const [error, setError] = useState<ApiError>();
  const [note, setNote] = useState<string>();

  async function start() {
    setError(undefined);
    try {
      setSetup(await api('/auth/totp/setup', { method: 'POST' }));
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function enable(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      const r = await api<{ recoveryCodes: string[] }>('/auth/totp/enable', { method: 'POST', body: { code: String(new FormData(e.currentTarget).get('code') ?? '').trim() } });
      setCodes(r.recoveryCodes);
      setSetup(undefined);
      await qc.invalidateQueries({ queryKey: ['me'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function revokeOthers() {
    const r = await api<{ revoked: number }>('/auth/sessions/revoke-others', { method: 'POST' });
    setNote(r.revoked ? `${r.revoked} andere Anmeldung${r.revoked === 1 ? '' : 'en'} beendet.` : 'Es gab keine anderen Anmeldungen.');
    await qc.invalidateQueries({ queryKey: ['sessions'] });
  }

  return (
    <>
      <section aria-labelledby="mfa">
        <h2 id="mfa" style={{ marginBottom: 'var(--s-2)' }}>Anmeldung mit zweitem Faktor</h2>
        <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>
          Nach dem Passwort fragt OpenVerein nach einem Code aus einer Authenticator-App (zum Beispiel Aegis, Google Authenticator oder 1Password). {me.mfa.required ? 'Für Deine Rollen ist das Pflicht, weil sie an Finanzdaten kommen.' : 'Für Zugänge mit Finanzrechten ist das Pflicht.'}
        </p>
        {error && <div className="alert alert-error" role="alert">{error.problem.errors?.[0]?.message ?? [error.problem.title, error.problem.detail].filter(Boolean).join(' ')}</div>}
        {codes && (
          <div className="alert alert-ok" role="status" style={{ maxWidth: 560 }}>
            <strong>Eingerichtet.</strong> Bewahr diese zehn Wiederherstellungscodes sicher auf (ausdrucken oder im Passwortmanager). Jeder gilt einmal, falls Dein Handy weg ist. Sie werden nur jetzt angezeigt.
            <ol className="recovery-codes">{codes.map((c) => <li key={c}><code>{c}</code></li>)}</ol>
          </div>
        )}
        {setup ? (
          <div className="inline-form" style={{ maxWidth: 560 }}>
            <div style={{ display: 'flex', gap: 'var(--s-4)', flexWrap: 'wrap', alignItems: 'flex-start' }}>
              <img src={toSvgDataURL(generate(setup.uri), { on: '#14202e', off: '#ffffff', padX: 2, padY: 2 })} width={168} height={168} alt="QR-Code zum Einscannen mit der Authenticator-App" style={{ border: '1px solid var(--line)', imageRendering: 'pixelated' }} />
              <div style={{ flex: 1, minWidth: 220 }}>
                <p>1. QR-Code mit der App scannen. Geht das nicht, gib diesen Schlüssel von Hand ein:</p>
                <code className="token-once" style={{ display: 'block', wordBreak: 'break-all' }}>{setup.secret.replace(/(.{4})/g, '$1 ').trim()}</code>
              </div>
            </div>
            <form onSubmit={enable} noValidate className="form" style={{ marginTop: 'var(--s-3)' }}>
              <Field label="2. Code aus der App" name="code" inputMode="numeric" autoComplete="one-time-code" error={error?.fieldError('code')} />
              <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Bestätigen</button><button type="button" className="btn btn-ghost" onClick={() => setSetup(undefined)}>Abbrechen</button></div>
            </form>
          </div>
        ) : (
          <dl className="facts">
            <dt>Status</dt>
            <dd>{me.mfa.enrolled ? <span className="status" data-s="active">eingerichtet</span> : <span className="status" data-s="applicant">nicht eingerichtet</span>}</dd>
            <dt />
            <dd><button className="btn" onClick={() => void start()}>{me.mfa.enrolled ? 'Neues Handy einrichten' : 'Jetzt einrichten'}</button></dd>
          </dl>
        )}
      </section>

      <section className="section" aria-labelledby="sess">
        <h2 id="sess">Angemeldet</h2>
        {note && <p role="status" className="meta">{note}</p>}
        <ul className="timeline" style={{ maxWidth: 720 }}>
          {sessions.data?.map((s) => (
            <li key={s.id} style={{ gridTemplateColumns: '1fr auto' }}>
              <span>{browserName(s.userAgent)}{s.current && <span className="pill" style={{ marginLeft: 8 }}>dieses Gerät</span>}<div className="meta">seit {new Date(s.createdAt).toLocaleString('de-DE')} · zuletzt {new Date(s.lastSeenAt).toLocaleString('de-DE')}</div></span>
            </li>
          ))}
        </ul>
        {(sessions.data?.length ?? 0) > 1 && <div className="actions-row"><button className="btn" onClick={() => void revokeOthers()}>Andere Anmeldungen beenden</button></div>}
      </section>
    </>
  );
}

function browserName(ua: string | null) {
  if (!ua) return 'Unbekanntes Gerät';
  const browser = /Firefox/.test(ua) ? 'Firefox' : /Edg\//.test(ua) ? 'Edge' : /Chrome/.test(ua) ? 'Chrome' : /Safari/.test(ua) ? 'Safari' : 'Browser';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return [browser, os].filter(Boolean).join(' auf ');
}
