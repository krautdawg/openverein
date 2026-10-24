import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { api } from '../lib/api.ts';

const LABEL: Record<string, string> = { queued: 'wartet', sending: 'wird gesendet', sent: 'zugestellt', failed: 'fehlgeschlagen', bounced: 'unzustellbar' };

/** E-mails sent to one member, newest first. */
export function MemberMails({ memberId }: { memberId: string }) {
  const { data } = useQuery({ queryKey: ['member-mails', memberId], queryFn: () => api<{ messageId: string; subject: string; status: string; at: string }[]>(`/members/${memberId}/deliveries`) });
  if (!data?.length) return null;
  return (
    <section className="sheet-section" aria-labelledby="mails">
      <h3 id="mails">E-Mails</h3>
      <ul className="timeline">
        {data.slice(0, 8).map((d) => (
          <li key={`${d.messageId}`} style={{ gridTemplateColumns: 'auto 1fr auto' }}>
            <span className="meta num">{new Date(d.at).toLocaleDateString('de-DE')}</span>
            <Link to={`/kommunikation/${d.messageId}`}>{d.subject}</Link>
            <span className="meta">{LABEL[d.status]}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
