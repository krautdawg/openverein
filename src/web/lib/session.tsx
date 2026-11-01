import { useQuery, useQueryClient } from '@tanstack/react-query';
import type { Me } from '../../shared/auth.ts';
import { api, ApiError } from './api.ts';

export function useMe() {
  return useQuery<Me | null>({
    queryKey: ['me'],
    queryFn: async () => {
      try {
        return await api<Me>('/auth/me');
      } catch (e) {
        if (e instanceof ApiError && e.problem.status === 401) return null;
        throw e;
      }
    },
    staleTime: 60_000,
  });
}

export function useInstanceConfig() {
  return useQuery({ queryKey: ['config'], queryFn: () => api<{ demo: boolean; demoLogin: { email: string; password: string } | null; demoResetHours: number | null }>('/config'), staleTime: Infinity });
}

export function useSetMe() {
  const qc = useQueryClient();
  return (me: Me | null) => qc.setQueryData(['me'], me);
}
