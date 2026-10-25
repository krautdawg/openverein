import { BookOpen, CalendarDays, Coins, FileText, FolderOpen, HandHeart, Landmark, LayoutGrid, ListChecks, type LucideIcon, Mail, Settings, Shapes, Users, Vote } from 'lucide-react';

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
  { label: 'Aufgaben', path: '/aufgaben', icon: ListChecks, keywords: 'todo erledigen zuständig frist tasks' },
  { label: 'Mitglieder', path: '/mitglieder', icon: Users, keywords: 'personen liste members', module: 'members' },
  { label: 'Gruppen', path: '/gruppen', icon: Shapes, keywords: 'abteilungen mannschaften sparten groups', module: 'groups' },
  { label: 'Termine', path: '/termine', icon: CalendarDays, keywords: 'kalender training spiel sitzung events', module: 'events' },
  { label: 'Versammlungen', path: '/versammlungen', icon: Vote, keywords: 'mitgliederversammlung jahreshauptversammlung einladung tagesordnung protokoll abstimmung', module: 'members' },
  { label: 'Kommunikation', path: '/kommunikation', icon: Mail, keywords: 'e-mail rundschreiben newsletter nachricht mail', module: 'communication' },
  { label: 'Dokumente', path: '/dokumente', icon: FolderOpen, keywords: 'dateien ordner satzung protokoll formulare upload files', module: 'documents' },
  { label: 'Beiträge', path: '/beitraege', icon: Coins, keywords: 'beitragsarten beitragslauf gebühren fees', module: 'fees' },
  { label: 'Rechnungen', path: '/rechnungen', icon: FileText, keywords: 'offene posten mahnung zahlung invoices', module: 'invoices' },
  { label: 'Buchhaltung', path: '/buchhaltung', icon: BookOpen, keywords: 'eür journal buchung konten kasse datev steuer sphäre', module: 'ledger' },
  { label: 'Spenden', path: '/spenden', icon: HandHeart, keywords: 'spende zuwendungsbestätigung spendenquittung sammelbestätigung', module: 'donations' },
  { label: 'Bank', path: '/bank', icon: Landmark, keywords: 'konto kontoauszug camt abgleich lastschrift sepa einzug', module: 'banking' },
  { label: 'Einstellungen', path: '/einstellungen', icon: Settings, keywords: 'verein stammdaten zugänge rollen api protokoll settings' },
];
