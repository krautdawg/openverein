import { useId, useState } from 'react';
import { euroInput, parseEuro } from '../lib/money.ts';

/** Euro amount input that keeps cents as the value. Accepts "12,50" and "12.50". */
export function MoneyField({ label, name, defaultCents, error, hint }: { label: string; name: string; defaultCents?: number; error?: string; hint?: string }) {
  const id = useId();
  const [text, setText] = useState(defaultCents !== undefined ? euroInput(defaultCents) : '');
  const cents = parseEuro(text);
  const invalid = text !== '' && cents === null;
  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div style={{ position: 'relative' }}>
        <input id={id} className="input num" inputMode="decimal" value={text} onChange={(e) => setText(e.target.value)} aria-invalid={invalid || !!error || undefined} style={{ paddingRight: 28 }} />
        <span aria-hidden style={{ position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', color: 'var(--ink-3)' }}>€</span>
      </div>
      <input type="hidden" name={name} value={cents ?? ''} />
      {hint && !error && !invalid && <span className="hint">{hint}</span>}
      {(invalid || error) && <span className="error" role="alert">{invalid ? 'Bitte einen Betrag wie 12,50 eingeben.' : error}</span>}
    </div>
  );
}
