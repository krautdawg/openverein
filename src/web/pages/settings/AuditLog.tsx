import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ACTION_LABEL } from '../../../shared/access.ts';
import { api } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

interface Ev { id: number; at: string; actor: string; action: string; entityType: string; entityId: string | null; diff: unknown }

const FILTERS = [
  { value: '', label: 'Alles' },
  { value: 'member', label: 'Mitglieder' },
  { value: 'group', label: 'Gruppen' },
  { value: 'auth', label: 'Anmeldungen' },
  { value: 'user', label: 'Zugänge' },
  { value: 'role', label: 'Rollen' },
  { value: 'api_token', label: 'API-Schlüssel' },
];

function describe(diff: unknown) {
  if (!diff || typeof diff !== 'object') return '';
  return Object.entries(diff as Record<string, unknown>)
    .filter(([, v]) => Array.isArray(v) && v.length === 2 && typeof v[1] !== 'object')
    .map(([k, v]) => `${k}: ${(v as unknown[])[0] ?? '–'} → ${(v as unknown[])[1] ?? '–'}`)
    .join(' · ');
}

export function AuditLog() {
  useTitle('Protokoll');
  const [action, setAction] = useState('');
  const q = useInfiniteQuery({
    queryKey: ['audit', action],
    queryFn: ({ pageParam }) => api<{ items: Ev[]; nextCursor: number | null }>(`/audit-events?limit=50${action ? `&action=${action}` : ''}${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: 0,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <>
      <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div><h2>Protokoll</h2><p>Wer hat wann was geändert. Einträge lassen sich nicht ändern oder löschen.</p></div>
        <select className="select" aria-label="Bereich" value={action} onChange={(e) => setAction(e.target.value)}>
          {FILTERS.map((f) => <option key={f.value} value={f.value}>{f.label}</option>)}
        </select>
      </div>
      <div className="table-wrap">
        <table className="table" aria-label="Protokoll">
          <thead><tr><th scope="col">Zeit</th><th scope="col">Wer</th><th scope="col">Was</th><th scope="col" className="hide-sm">Details</th></tr></thead>
          <tbody>
            {rows.map((e) => (
              <tr key={e.id}>
                <td className="num" style={{ whiteSpace: 'nowrap' }}>{new Date(e.at).toLocaleString('de-DE', { dateStyle: 'short', timeStyle: 'short' })}</td>
                <td>{e.actor}</td>
                <td>{ACTION_LABEL[e.action] ?? e.action}</td>
                <td className="hide-sm muted" style={{ maxWidth: 420, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{describe(e.diff)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {q.hasNextPage && <div className="table-foot"><span /><button className="btn" onClick={() => void q.fetchNextPage()}>Ältere laden</button></div>}
    </>
  );
}
