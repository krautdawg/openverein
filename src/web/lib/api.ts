/** Problem document (RFC 9457) as returned by the API. */
export interface ApiProblem {
  type: string;
  title: string;
  status: number;
  detail?: string;
  errors?: { field: string; message: string }[];
}

export class ApiError extends Error {
  readonly problem: ApiProblem;
  constructor(problem: ApiProblem) {
    super(problem.detail ?? problem.title);
    this.problem = problem;
  }
  fieldError(field: string) {
    return this.problem.errors?.find((e) => e.field === field)?.message;
  }
}

/** The UI talks only to the public REST API, so every UI action is also an API action. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
  const method = init.method ?? 'GET';
  // Every write is JSON, even without payload: the server rejects other content types (CSRF guard).
  const body = method === 'GET' ? undefined : JSON.stringify(init.body ?? {});
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}`, { method, headers: body ? { 'content-type': 'application/json' } : undefined, body, credentials: 'same-origin' });
  } catch {
    throw new ApiError({ type: 'network', title: 'Keine Verbindung zum Server. Bitte prüfe Deine Internetverbindung.', status: 0 });
  }
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({ title: 'Keine Antwort vom Server.', status: res.status, type: 'network' }));
  if (!res.ok) throw new ApiError(data as ApiProblem);
  return data as T;
}
