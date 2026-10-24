import type { ReactNode } from 'react';

/** Court lines of a sports hall floor, crossing the hall-blue panel. Purely decorative. */
function CourtLines() {
  return (
    <svg viewBox="0 0 400 600" preserveAspectRatio="xMidYMid slice" aria-hidden>
      <g fill="none" strokeWidth="2.5">
        <rect x="40" y="120" width="300" height="420" stroke="#e9eff6" strokeOpacity="0.16" />
        <line x1="40" y1="330" x2="340" y2="330" stroke="#e9eff6" strokeOpacity="0.16" />
        <circle cx="190" cy="330" r="56" stroke="#e9eff6" strokeOpacity="0.16" />
        <path d="M100 540 A 90 90 0 0 1 280 540" stroke="#d9661a" strokeOpacity="0.55" />
        <path d="M100 120 A 90 90 0 0 0 280 120" stroke="#d9661a" strokeOpacity="0.55" />
        <rect x="-20" y="210" width="460" height="240" stroke="#2b7a4b" strokeOpacity="0.5" />
        <line x1="-20" y1="300" x2="440" y2="300" stroke="#c99a06" strokeOpacity="0.5" />
      </g>
    </svg>
  );
}

export function AuthLayout({ children }: { children: ReactNode }) {
  return (
    <div className="auth">
      <aside className="auth-aside">
        <CourtLines />
        <div className="brand">OpenVerein</div>
        <p>Mitglieder, Beiträge und Lastschriften für Deinen Verein. Offen, exportierbar, Deins.</p>
      </aside>
      <main className="auth-main">
        <div className="auth-card">{children}</div>
      </main>
    </div>
  );
}
