import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../../shared/auth.ts';
import type { Organization } from '../../../shared/organization.ts';
import { InlineEdit } from '../../components/InlineEdit.tsx';
import { api } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

const EXIT_AT = { any_day: 'zu jedem Tag', month_end: 'zum Monatsende', quarter_end: 'zum Quartalsende', half_year_end: 'zum Halbjahresende', year_end: 'zum Jahresende' } as const;

export function ClubSettings({ me }: { me: Me }) {
  useTitle('Einstellungen');
  const qc = useQueryClient();
  const canWrite = me.permissions.settings === 'write';
  const { data: org } = useQuery({ queryKey: ['organization'], queryFn: () => api<Organization>('/organization') });

  async function save(body: Partial<Organization>) {
    const updated = await api<Organization>('/organization', { method: 'PATCH', body });
    qc.setQueryData(['organization'], updated);
    await qc.invalidateQueries({ queryKey: ['me'] });
  }

  if (!org) return <div className="skeleton" style={{ width: 280 }} />;
  return (
    <>
      <section aria-labelledby="club">
        <h2 id="club" style={{ marginBottom: 'var(--s-4)' }}>Verein</h2>
        <dl className="facts">
          <dt>Name</dt>
          <dd>{canWrite ? <InlineEdit label="Name des Vereins" value={org.name} onSave={(name) => save({ name })} /> : org.name}</dd>
          <dt>Zeitzone</dt>
          <dd>{org.timeZone}</dd>
        </dl>
      </section>
      <section className="section" aria-labelledby="membership">
        <h2 id="membership">Mitgliedschaft</h2>
        <dl className="facts">
          <dt>Mitgliedsnummern</dt>
          <dd>
            {canWrite ? <InlineEdit label="Muster für Mitgliedsnummern" field="memberNumberPattern" value={org.memberNumberPattern} onSave={(memberNumberPattern) => save({ memberNumberPattern })} /> : org.memberNumberPattern}
            <p className="meta">Platzhalter: {'{seq}'} fortlaufend, {'{seq:4}'} vierstellig, {'{YYYY}'} Eintrittsjahr (zählt dann pro Jahr neu).</p>
          </dd>
          <dt>Kündigungsfrist</dt>
          <dd>
            <div className="inline-edit">
              <input className="input" type="number" min={0} max={104} style={{ width: 88 }} aria-label="Kündigungsfrist in Wochen" disabled={!canWrite} defaultValue={org.noticeWeeks} onBlur={(e) => Number(e.target.value) !== org.noticeWeeks && void save({ noticeWeeks: Number(e.target.value) })} />
              <span>Wochen</span>
              <select className="select" aria-label="Austritt möglich" disabled={!canWrite} value={org.exitAt} onChange={(e) => void save({ exitAt: e.target.value as Organization['exitAt'] })}>
                {Object.entries(EXIT_AT).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
              </select>
            </div>
            <p className="meta">So steht es meist in der Satzung. OpenVerein schlägt damit das Austrittsdatum vor.</p>
          </dd>
        </dl>
      </section>
    </>
  );
}
