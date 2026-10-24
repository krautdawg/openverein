import { useQuery } from '@tanstack/react-query';
import { Navigate, Route, Routes } from 'react-router';
import { Shell } from './components/Shell.tsx';
import { api } from './lib/api.ts';
import { useInstanceConfig, useMe } from './lib/session.tsx';
import { Login } from './pages/Login.tsx';
import { Overview } from './pages/Overview.tsx';
import { Settings } from './pages/Settings.tsx';
import { Setup } from './pages/Setup.tsx';

export function App() {
  const setup = useQuery({ queryKey: ['setup'], queryFn: () => api<{ needsSetup: boolean }>('/setup') });
  const me = useMe();
  const cfg = useInstanceConfig();

  if (setup.isPending || me.isPending) return null;
  if (setup.data?.needsSetup) {
    return (
      <Routes>
        <Route path="*" element={<Setup />} />
      </Routes>
    );
  }
  if (!me.data) {
    return (
      <Routes>
        <Route path="/anmelden" element={<Login />} />
        <Route path="*" element={<Navigate to="/anmelden" replace />} />
      </Routes>
    );
  }
  return (
    <Routes>
      <Route element={<Shell me={me.data} demo={!!cfg.data?.demo || me.data.organization.isDemo} />}>
        <Route index element={<Overview me={me.data} />} />
        <Route path="/einstellungen" element={<Settings />} />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Route>
    </Routes>
  );
}
