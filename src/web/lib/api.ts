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

let stepUpHandler: (() => Promise<boolean>) | null = null;
let stepUpInFlight: Promise<boolean> | null = null;
/** The app shell registers a prompt that asks for a fresh TOTP code; api() then retries once. */
export const setStepUpHandler = (h: typeof stepUpHandler) => {
  stepUpHandler = h;
};
// Several requests may need the step-up at once: they share one prompt.
const stepUp = () => (stepUpInFlight ??= stepUpHandler!().finally(() => (stepUpInFlight = null)));

/** The UI talks only to the public REST API, so every UI action is also an API action. */
export async function api<T>(path: string, init: { method?: string; body?: unknown } = {}, retried = false): Promise<T> {
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
  if (!res.ok) {
    if (!retried && res.status === 403 && String((data as ApiProblem).type).endsWith('/step-up-required') && stepUpHandler && (await stepUp())) return api<T>(path, init, true);
    throw new ApiError(data as ApiProblem);
  }
  return data as T;
}

/** Uploads one file as raw bytes (the only non-JSON write the API accepts). */
export async function uploadFile<T>(path: string, file: File, query: Record<string, string | undefined>): Promise<T> {
  const qs = new URLSearchParams(Object.entries({ name: file.name, ...query }).filter((e): e is [string, string] => !!e[1]));
  let res: Response;
  try {
    res = await fetch(`/api/v1${path}?${qs}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream', 'x-file-type': file.type || 'application/octet-stream' }, body: file, credentials: 'same-origin' });
  } catch {
    throw new ApiError({ type: 'network', title: 'Keine Verbindung zum Server. Bitte prüfe Deine Internetverbindung.', status: 0 });
  }
  const data = await res.json().catch(() => ({ title: res.status === 413 ? 'Die Datei ist größer als 20 MB.' : 'Keine Antwort vom Server.', status: res.status, type: 'network' }));
  if (!res.ok) throw new ApiError(data as ApiProblem);
  return data as T;
}

/** Uploads several files one after another; returns the error text of the first failure. */
export async function uploadAll(files: FileList | File[], query: Record<string, string | undefined>) {
  for (const f of Array.from(files)) {
    try {
      await uploadFile('/files', f, query);
    } catch (err) {
      return `${f.name}: ${err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : 'Hochladen fehlgeschlagen.'}`;
    }
  }
  return undefined;
}
