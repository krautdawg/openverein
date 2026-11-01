import { useState } from 'react';
import { Link } from 'react-router';
import { Check, ChevronRight, Copy } from 'lucide-react';
import { AuthLayout } from '../components/AuthLayout.tsx';
import { useTitle } from '../lib/useTitle.ts';

/** A command or address to copy, with its own copy button. */
function CopyLine({ label, text }: { label: string; text: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle');
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState('copied');
      setTimeout(() => setState('idle'), 2000);
    } catch {
      // No clipboard (plain HTTP, permission denied): say so; the text stays focusable and selectable.
      setState('failed');
    }
  }
  return (
    <div className="demo-copy">
      <span className="demo-copy-label">{label}</span>
      <div className="demo-copy-row">
        <pre tabIndex={0} aria-label={label}>{text}</pre>
        <button type="button" className="icon-btn" onClick={() => void copy()} aria-label={`${label}: kopieren`}>
          {state === 'copied' ? <Check size={16} aria-hidden /> : <Copy size={16} aria-hidden />}
        </button>
      </div>
      <p className="demo-copy-status" role="status">{state === 'copied' ? 'Kopiert.' : state === 'failed' ? 'Kopieren geht hier nicht. Markier den Text und kopier ihn selbst.' : ''}</p>
    </div>
  );
}

/**
 * The public demo's front door (DEMO_MODE only): look as the board, as a member, or connect an agent. Each way in is
 * a row led by its own court line, like a group in the app.
 */
export function DemoStart({ resetHours }: { resetHours: number | null }) {
  useTitle('Demo');
  const origin = window.location.origin;
  return (
    <AuthLayout>
      <h1>OpenVerein ausprobieren</h1>
      <p>Ein erfundener Sportverein mit Mitgliedern, Beiträgen, Terminen und Buchhaltung. Schau ihn Dir an, wie Du magst.</p>
      <ul className="demo-ways">
        <li>
          <Link to="/anmelden" className="demo-way" style={{ ['--court' as string]: 'var(--court-blau)' }}>
            <span>
              <span className="demo-way-title">Als Vorstand ansehen</span>
              <span className="demo-way-meta">Die Verwaltung mit allen Rechten. Die Zugangsdaten stehen auf der Anmeldeseite.</span>
            </span>
            <ChevronRight size={18} aria-hidden />
          </Link>
        </li>
        <li>
          <a href="/portal" className="demo-way" style={{ ['--court' as string]: 'var(--court-gruen)' }}>
            <span>
              <span className="demo-way-title">Als Mitglied ansehen</span>
              <span className="demo-way-meta">Das Mitgliederportal. Statt einer E-Mail steht der Code gleich im Feld.</span>
            </span>
            <ChevronRight size={18} aria-hidden />
          </a>
        </li>
      </ul>

      <section className="demo-agent" aria-labelledby="demo-agent-h">
        <h2 id="demo-agent-h">KI-Agent verbinden</h2>
        <p>Claude, ChatGPT oder ein Skript sehen dann genau, was Du nach der Anmeldung siehst.</p>
        <CopyLine label="claude.ai oder ChatGPT: Adresse für einen eigenen Connector" text={`${origin}/mcp`} />
        <CopyLine label="Claude Code: das Plugin installieren" text={`/plugin marketplace add krautdawg/openverein\n/plugin install openverein@openverein`} />
        <CopyLine label="Adresse des Vereins, wenn das Plugin danach fragt (club_url)" text={origin} />
        <CopyLine label="Terminal: die Kommandozeile ov laden (Token unter Agenten)" text={`curl -fsSLO ${origin}/ov.mjs`} />
      </section>

      <p className="demo-note">
        Alle Personen, Zahlen und Vorgänge hier sind erfunden.{' '}
        {resetHours ? `Die Demo fängt ${resetHours === 1 ? 'jede Stunde' : `alle ${resetHours} Stunden`} von vorn an.` : 'Gib keine echten Daten ein.'}{' '}
        <a href="https://github.com/krautdawg/openverein">Quellcode auf GitHub</a>
      </p>
    </AuthLayout>
  );
}
