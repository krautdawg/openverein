import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Organization } from '../../shared/organization.ts';
import { InlineEdit } from '../components/InlineEdit.tsx';
import { api } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

export function Settings() {
  useTitle('Einstellungen');
  const qc = useQueryClient();
  const { data: org } = useQuery({ queryKey: ['organization'], queryFn: () => api<Organization>('/organization') });

  async function rename(name: string) {
    const updated = await api<Organization>('/organization', { method: 'PATCH', body: { name } });
    qc.setQueryData(['organization'], updated);
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  return (
    <div className="page">
      <div className="page-head">
        <h1>Einstellungen</h1>
        <p>Stammdaten Deines Vereins. Klick auf einen Wert, um ihn zu ändern.</p>
      </div>
      <section className="section" aria-labelledby="club">
        <h2 id="club">Verein</h2>
        {org ? (
          <dl className="facts">
            <dt>Name</dt>
            <dd><InlineEdit label="Name des Vereins" value={org.name} onSave={rename} /></dd>
            <dt>Zeitzone</dt>
            <dd>{org.timeZone}</dd>
          </dl>
        ) : (
          <div className="skeleton" style={{ width: 280 }} />
        )}
      </section>
    </div>
  );
}
