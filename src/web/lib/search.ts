import { UserRound } from 'lucide-react';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { api } from './api.ts';
import { searchProviders } from './commands.ts';

// Members in the command palette: type a name, number or town and jump to the record.
searchProviders.push(async (q, go) => {
  const res = await api<{ items: MemberListItem[] }>(`/members?q=${encodeURIComponent(q)}&limit=6&includeFormer=true`);
  return res.items.map((m) => ({ id: `member-${m.id}`, label: displayName(m), hint: `Nr. ${m.membershipNumber}`, icon: UserRound, run: () => go(`/mitglieder/${m.id}`) }));
});
