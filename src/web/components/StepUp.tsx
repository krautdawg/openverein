import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api, ApiError, setStepUpHandler } from '../lib/api.ts';

/** Asks for a fresh TOTP code when the server wants a step-up, then lets the original request go through. */
export function StepUpPrompt() {
  const [pending, setPending] = useState<((ok: boolean) => void) | null>(null);
  const [error, setError] = useState<string>();
  const dialog = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    setStepUpHandler(() => new Promise<boolean>((resolve) => setPending(() => resolve)));
    return () => setStepUpHandler(null);
  }, []);
  useEffect(() => {
    if (pending) dialog.current?.showModal();
    else dialog.current?.close();
  }, [pending]);

  const finish = (ok: boolean) => {
    pending?.(ok);
    setPending(null);
    setError(undefined);
  };
  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const code = String(new FormData(e.currentTarget).get('code') ?? '').trim().toLowerCase();
    try {
      await api('/auth/step-up', { method: 'POST', body: { code } });
      finish(true);
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.[0]?.message ?? err.problem.title) : 'Das hat nicht geklappt.');
    }
  }

  return (
    <dialog ref={dialog} className="stepup" aria-labelledby="stepup-title" onCancel={(e) => { e.preventDefault(); finish(false); }}>
      <form onSubmit={submit} noValidate className="form">
        <h2 id="stepup-title">Kurz bestätigen</h2>
        <p className="muted">Diese Aktion braucht einen frischen Code aus Deiner Authenticator-App.</p>
        <div className="field">
          <label htmlFor="stepup-code">Code</label>
          <input id="stepup-code" name="code" className="input" inputMode="numeric" autoComplete="one-time-code" autoFocus aria-invalid={!!error} aria-describedby={error ? 'stepup-error' : undefined} />
          {error && <span className="error" id="stepup-error">{error}</span>}
        </div>
        <div className="actions-row" style={{ marginTop: 0 }}>
          <button className="btn btn-primary">Bestätigen</button>
          <button type="button" className="btn btn-ghost" onClick={() => finish(false)}>Abbrechen</button>
        </div>
      </form>
    </dialog>
  );
}
