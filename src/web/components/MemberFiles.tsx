import { useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { FileDto } from '../../shared/documents.ts';
import { api, uploadAll } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';

/** Files kept with one member (signed application, mandate scan, certificates). */
export function MemberFiles({ memberId, canWrite }: { memberId: string; canWrite: boolean }) {
  const qc = useQueryClient();
  const { data } = useQuery({ queryKey: ['files', 'member', memberId], queryFn: () => api<FileDto[]>(`/files?memberId=${memberId}`) });
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function upload(list: FileList) {
    setBusy(true);
    setError(await uploadAll(list, { memberId }));
    setBusy(false);
    await qc.invalidateQueries({ queryKey: ['files', 'member', memberId] });
  }

  if (!data || (!data.length && !canWrite)) return null;
  return (
    <section className="sheet-section" aria-labelledby="m-files">
      <h3 id="m-files">Dateien</h3>
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {data.length === 0 && <p className="muted">Zum Beispiel der unterschriebene Aufnahmeantrag oder ein eingescanntes Mandat.</p>}
      <ul className="timeline">
        {data.map((f) => (
          <li key={f.id} style={{ gridTemplateColumns: '1fr auto' }}>
            <a href={`/api/v1/files/${f.id}/content`} download={f.name}>{f.name}</a>
            <span className="meta num">{bytes(f.sizeBytes)}</span>
          </li>
        ))}
      </ul>
      {canWrite && (
        <div className="actions-row">
          <button className="btn" aria-busy={busy} disabled={busy} onClick={() => input.current?.click()}>Datei hinzufügen</button>
          <input ref={input} type="file" multiple hidden onChange={(e) => { if (e.target.files?.length) void upload(e.target.files); e.target.value = ''; }} />
        </div>
      )}
    </section>
  );
}
