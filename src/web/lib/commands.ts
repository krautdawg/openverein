import type { LucideIcon } from 'lucide-react';

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon?: LucideIcon;
  keywords?: string;
  run: () => void;
}

/** Async sources for the command palette (members, invoices …). Modules push their provider here. */
export type SearchProvider = (query: string, go: (path: string) => void) => Promise<Command[]>;
export const searchProviders: SearchProvider[] = [];

export function matches(c: Command, q: string) {
  const hay = `${c.label} ${c.keywords ?? ''}`.toLowerCase();
  return q.toLowerCase().split(/\s+/).every((part) => hay.includes(part));
}
