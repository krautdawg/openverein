import { LayoutGrid, Settings, type LucideIcon } from 'lucide-react';

export interface NavItem {
  label: string;
  path: string;
  icon: LucideIcon;
  keywords?: string;
}

/** Main navigation. Each slice adds its module here; the command palette reads the same list. */
export const nav: NavItem[] = [
  { label: 'Übersicht', path: '/', icon: LayoutGrid, keywords: 'start dashboard home' },
  { label: 'Einstellungen', path: '/einstellungen', icon: Settings, keywords: 'verein stammdaten settings' },
];
