import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import { X } from 'lucide-react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api.ts';

export interface Job {
  id: string;
  kind: string;
  label: string;
  status: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  detail: string | null;
  error: string | null;
  resultFileId: string | null;
  resultPath: string;
  createdAt: string;
  finishedAt: string | null;
}

export const isActive = (j: Job) => j.status === 'queued' || j.status === 'running';
/** Queries that show a job's result, refreshed when the job finishes. */
const RESULT_QUERY: Record<string, string[]> = { full_export: ['full-exports'] };
const SHOW_FINISHED_MS = 10 * 60_000;

/** The signed-in user's jobs. Polls only while one of them is still running. */
export function useJobs() {
  return useQuery({
    queryKey: ['jobs'],
    queryFn: () => api<Job[]>('/jobs'),
    refetchInterval: (q) => (q.state.data?.some(isActive) ? 1500 : false),
  });
}

const statusText = (j: Job) => (j.status === 'queued' ? 'Wartet' : j.status === 'running' ? `${j.progress} %` : j.status === 'done' ? 'Fertig' : 'Fehlgeschlagen');

/** Bottom-right tray for background jobs: visible only while the user has a running or recently finished job. */
export function JobTray() {
  const qc = useQueryClient();
  const { data } = useJobs();
  const [dismissed, setDismissed] = useState<Set<string>>(() => new Set());
  const [announce, setAnnounce] = useState('');
  const seen = useRef(new Map<string, Job['status']>());

  useEffect(() => {
    for (const j of data ?? []) {
      const before = seen.current.get(j.id);
      if (before && before !== j.status && !isActive(j)) {
        if (RESULT_QUERY[j.kind]) void qc.invalidateQueries({ queryKey: RESULT_QUERY[j.kind] });
        setAnnounce(`${j.label}: ${j.status === 'done' ? 'fertig' : `fehlgeschlagen. ${j.error ?? ''}`}`);
      }
      seen.current.set(j.id, j.status);
    }
  }, [data, qc]);

  const visible = (data ?? []).filter((j) => !dismissed.has(j.id) && (isActive(j) || Date.now() - Date.parse(j.finishedAt ?? j.createdAt) < SHOW_FINISHED_MS));

  return (
    <>
      <div className="sr-only" aria-live="polite">{announce}</div>
      {visible.length > 0 && (
        <aside className="job-tray" aria-label="Hintergrundaufgaben">
          <ul>
            {visible.map((j) => (
              <li key={j.id} data-status={j.status}>
                <div className="job-head">
                  <strong>{j.label}</strong>
                  <span className="meta num">{statusText(j)}</span>
                  {!isActive(j) && (
                    <button className="icon-btn" aria-label={`${j.label} ausblenden`} onClick={() => setDismissed((d) => new Set(d).add(j.id))}><X size={14} /></button>
                  )}
                </div>
                {isActive(j) && (
                  <>
                    <div className="job-line" role="progressbar" aria-label={j.label} aria-valuemin={0} aria-valuemax={100} aria-valuenow={j.progress}><span style={{ width: `${j.progress}%` }} /></div>
                    {j.detail && <p className="meta">{j.detail}</p>}
                  </>
                )}
                {j.status === 'failed' && <p className="job-error">{j.error}</p>}
                {j.status === 'done' && <Link to={j.resultPath}>Ergebnis ansehen</Link>}
              </li>
            ))}
          </ul>
        </aside>
      )}
    </>
  );
}
