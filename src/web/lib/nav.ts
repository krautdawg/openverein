import { CalendarDays, Coins, FileText, Landmark, LayoutGrid, Mail, Settings, Shapes, Users, type LucideIcon } from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  keywords?: string;
  /** Module the user needs at least read access to; undefined = everyone. */
  module?: string;
}

/** Main navigation. Each slice adds its module here; the command palette reads the same list. */
export const nav: NavItem[] = [
  { label: 'Übersicht', path: '/', icon: LayoutGrid, keywords: 'start dashboard home' },
  { label: 'Mitglieder', path: '/mitglieder', icon: Users, keywords: 'personen liste members', module: 'members' },
  { label: 'Gruppen', path: '/gruppen', icon: Shapes, keywords: 'abteilungen mannschaften sparten groups', module: 'groups' },
  { label: 'Termine', path: '/termine', icon: CalendarDays, keywords: 'kalender training spiel sitzung events', module: 'events' },
  { label: 'Kommunikation', path: '/kommunikation', icon: Mail, keywords: 'e-mail rundschreiben newsletter nachricht mail', module: 'communication' },
  { label: 'Beiträge', path: '/beitraege', icon: Coins, keywords: 'beitragsarten beitragslauf gebühren fees', module: 'fees' },
  { label: 'Rechnungen', path: '/rechnungen', icon: FileText, keywords: 'offene posten mahnung zahlung invoices', module: 'invoices' },
  { label: 'Bank', path: '/bank', icon: Landmark, keywords: 'konto kontoauszug camt abgleich lastschrift sepa einzug', module: 'banking' },
  { label: 'Einstellungen', path: '/einstellungen', icon: Settings, keywords: 'verein stammdaten zugänge rollen api protokoll settings' },
];
