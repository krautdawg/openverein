import { NavLink, Outlet } from 'react-router';
import type { Me } from '../../../shared/auth.ts';
import { PageHead } from '../../components/PageHead.tsx';

export function SettingsLayout({ me }: { me: Me }) {
  const tabs = [
    { to: '/einstellungen', label: 'Verein', show: true },
    { to: '/einstellungen/sicherheit', label: 'Sicherheit', show: true },
    { to: '/einstellungen/email', label: 'E-Mail', show: me.permissions.communication !== 'none' },
    { to: '/einstellungen/aufnahme', label: 'Aufnahme', show: me.permissions.members !== 'none' },
    { to: '/einstellungen/felder', label: 'Felder', show: me.permissions.settings !== 'none' },
    { to: '/einstellungen/datenschutz', label: 'Datenschutz', show: me.permissions.members !== 'none' },
    { to: '/einstellungen/import', label: 'Import', show: me.permissions.imports !== 'none' && me.permissions.imports !== undefined },
    { to: '/einstellungen/zugaenge', label: 'Zugänge', show: me.permissions.settings !== 'none' },
    { to: '/einstellungen/rollen', label: 'Rollen', show: me.permissions.settings !== 'none' },
    { to: '/einstellungen/api', label: 'API-Schlüssel', show: me.permissions.api !== 'none' },
    { to: '/einstellungen/export', label: 'Gesamtexport', show: me.roles.includes('Admin') },
    { to: '/einstellungen/protokoll', label: 'Protokoll', show: me.permissions.audit !== 'none' },
  ];
  return (
    <div className="page">
      <PageHead title="Einstellungen" />
      <nav className="subnav" aria-label="Einstellungen">
        {tabs.filter((t) => t.show).map((t) => <NavLink key={t.to} to={t.to} end>{t.label}</NavLink>)}
      </nav>
      <Outlet />
    </div>
  );
}
