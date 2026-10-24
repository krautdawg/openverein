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
  const res = await fetch(`/api/v1${path}`, {
    method: init.method ?? 'GET',
    headers: init.body === undefined ? undefined : { 'content-type': 'application/json' },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    credentials: 'same-origin',
  });
  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({ title: 'Keine Antwort vom Server.', status: res.status, type: 'network' }));
  if (!res.ok) throw new ApiError(data as ApiProblem);
  return data as T;
}
