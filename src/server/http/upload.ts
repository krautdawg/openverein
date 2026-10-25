import { Problem } from './problem.ts';

/**
 * File name of an upload from the X-File-Name header (percent-encoded UTF-8). Names can hold personal data
 * ("Attest-Max-Mustermann.pdf") and URLs end up in access logs, so the name never travels in the query string;
 * the old `?name=` stays readable as a fallback for existing API clients.
 */
export function uploadName(req: { headers: Record<string, string | string[] | undefined> }, fallback: string | undefined, max = 255) {
  const raw = req.headers['x-file-name'];
  let name = fallback;
  if (typeof raw === 'string') {
    try {
      name = decodeURIComponent(raw);
    } catch {
      throw new Problem(400, 'validation', 'Der Dateiname ist nicht lesbar.');
    }
  }
  // Control characters (line breaks in headers, NUL) never belong in a file name.
  // eslint-disable-next-line no-control-regex
  name = name?.replace(/[\u0000-\u001f]/g, '').trim();
  if (!name || name.length > max) throw new Problem(400, 'validation', 'Die Eingaben sind nicht gültig.', undefined, { errors: [{ field: 'name', message: `Bitte einen Dateinamen mit höchstens ${max} Zeichen angeben (Header X-File-Name).` }] });
  return name;
}
