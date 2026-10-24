import { useQuery } from '@tanstack/react-query';
import type { Group } from '../../shared/groups.ts';
import { api } from './api.ts';

export const courtVar = (color: string) => ({ '--court': `var(--court-${color})` }) as React.CSSProperties;

export function useGroups(includeArchived = false) {
  return useQuery({ queryKey: ['groups', includeArchived], queryFn: () => api<Group[]>(`/groups${includeArchived ? '?includeArchived=true' : ''}`) });
}

export function todayLocal() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Berlin' }).format(new Date());
}
