import type { Me } from '../../../shared/auth.ts';
import { MODULE_LABEL } from '../../../shared/access.ts';
import { AgentTokens } from '../../components/AgentTokens.tsx';
import { useTitle } from '../../lib/useTitle.ts';

/** The signed-in access's own agent tokens: the agent works with these rights, never more. */
export function Agents({ me }: { me: Me }) {
  useTitle('Agenten');
  const modules = Object.entries(me.permissions).filter(([, l]) => l && l !== 'none').map(([key]) => ({ key, label: MODULE_LABEL[key] ?? key }));
  return (
    <>
      <div className="page-head" style={{ marginBottom: 'var(--s-4)' }}>
        <div>
          <h2>Agenten</h2>
          <p>Lass Claude, ChatGPT oder ein Skript für Dich arbeiten. Ein Token handelt als Du, mit Deinen Rechten oder weniger. Was Deine Rolle nicht darf, darf auch der Agent nicht. Zahlungsexporte und andere Aktionen mit zweitem Faktor bleiben bei Dir.</p>
        </div>
      </div>
      <AgentTokens base="/personal-tokens" whoAmI="/auth/me" modules={modules} />
    </>
  );
}
