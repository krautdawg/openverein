import { useCallback, useEffect, useMemo, useState } from 'react';
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router';
import { LogOut, Menu, Search, UserPlus } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';
import { nav } from '../lib/nav.ts';
import type { Command } from '../lib/commands.ts';
import type { Me } from '../../shared/auth.ts';
import { CommandPalette } from './CommandPalette.tsx';

const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform);

export function Shell({ me, demo }: { me: Me; demo: boolean }) {
  const navigate = useNavigate();
  const location = useLocation();
  const qc = useQueryClient();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => setNavOpen(false), [location.pathname]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const logout = useCallback(async () => {
    await api('/auth/logout', { method: 'POST' });
    qc.setQueryData(['me'], null);
    navigate('/anmelden');
  }, [qc, navigate]);

  const items = useMemo(() => nav.filter((n) => !n.module || me.permissions[n.module] !== 'none'), [me.permissions]);
  const commands = useMemo<Command[]>(
    () => [
      ...items.map((n) => ({ id: `nav-${n.path}`, label: n.label, hint: 'Gehe zu', icon: n.icon, keywords: n.keywords, run: () => navigate(n.path) })),
      ...(me.permissions.members === 'write' ? [{ id: 'new-member', label: 'Mitglied anlegen', icon: UserPlus, keywords: 'neu hinzufügen', run: () => navigate('/mitglieder?neu=1') }] : []),
      { id: 'logout', label: 'Abmelden', icon: LogOut, keywords: 'logout ausloggen', run: () => void logout() },
    ],
    [items, navigate, logout, me.permissions.members],
  );

  return (
    <div className="shell" data-nav-open={navOpen}>
      <a href="#main" className="sr-only">Zum Inhalt springen</a>
      <aside className="rail" aria-label="Hauptnavigation">
        <div className="rail-club">
          {me.organization.name}
          <small>{me.name}</small>
        </div>
        <button className="rail-search" onClick={() => setPaletteOpen(true)}>
          <Search size={16} aria-hidden /> Suchen
          <kbd>{isMac ? '⌘' : 'Strg'} K</kbd>
        </button>
        <nav>
          {items.map((n) => (
            <NavLink key={n.path} to={n.path} end={n.path === '/'} className="rail-link">
              <n.icon size={18} aria-hidden />
              {n.label}
            </NavLink>
          ))}
        </nav>
        <div className="rail-foot">
          <button onClick={() => void logout()}>Abmelden</button>
        </div>
      </aside>
      {navOpen && <button className="scrim" aria-label="Navigation schließen" onClick={() => setNavOpen(false)} />}
      <div className="main">
        <header className="topbar">
          <button className="icon-btn" aria-label="Navigation öffnen" aria-expanded={navOpen} onClick={() => setNavOpen(true)}><Menu size={20} /></button>
          <strong>{me.organization.name}</strong>
          <button className="icon-btn" aria-label="Suchen" onClick={() => setPaletteOpen(true)}><Search size={20} /></button>
        </header>
        {demo && (
          <div className="demo-banner" role="note">
            <strong>Demo</strong> Alle Personen und Zahlen hier sind erfunden. Die Daten werden regelmäßig zurückgesetzt.
          </div>
        )}
        <main id="main" tabIndex={-1}>
          <Outlet />
        </main>
      </div>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={commands} go={navigate} />
    </div>
  );
}
