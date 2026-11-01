import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { Plus, Trash2 } from 'lucide-react';
import { CONTACT_VISIBILITY_LABEL, PROFILE_PHOTO_TYPES, type ProfileDto } from '../../shared/profiles.ts';
import { Field } from '../components/Field.tsx';
import { api, ApiError, uploadFile } from '../lib/api.ts';
import { bytes } from '../lib/format.ts';
import { useTitle } from '../lib/useTitle.ts';

/** Where the profile stands, in one line the member understands. */
function statusOf(p: ProfileDto) {
  if (p.typeKey === 'none') return { s: 'off', text: 'Nicht öffentlich: Du hast keine Profilart gewählt.' };
  if (p.hidden) return { s: 'off', text: 'Verborgen: der Verein zeigt Dein Profil gerade nicht.' };
  if (p.public) return { s: 'ok', text: 'Öffentlich auf der Website des Vereins.' };
  return { s: 'warn', text: 'Wartet auf die Freigabe durch den Vorstand. Erst dann ist es öffentlich.' };
}

/** The member's own profile for the club's website: edit, add a photo, hide at any time. */
export function PortalProfile() {
  useTitle('Profil');
  const { id = '' } = useParams();
  const qc = useQueryClient();
  const key = ['portal-profile', id];
  const profile = useQuery({ queryKey: key, queryFn: () => api<ProfileDto>(`/portal/profiles/${id}`) });
  const [links, setLinks] = useState<{ label: string; url: string }[] | null>(null);
  const [error, setError] = useState<ApiError>();
  const [saved, setSaved] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!profile.data) return profile.isError ? <p className="alert alert-error" role="alert">{profile.error instanceof ApiError ? profile.error.problem.title : 'Fehler beim Laden.'}</p> : null;
  const p = profile.data;
  const rows = links ?? p.links;
  const status = statusOf(p);

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await api<ProfileDto>(`/portal/profiles/${id}`, {
        method: 'PUT',
        body: { displayName: f.get('displayName'), bio: f.get('bio'), place: f.get('place'), organisation: f.get('organisation'), typeKey: f.get('typeKey'), contactVisibility: f.get('contactVisibility'), hidden: f.get('hidden') === 'on', links: rows.filter((l) => l.label || l.url) },
      });
      qc.setQueryData(key, next);
      setLinks(null);
      setSaved(true);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    } finally {
      setBusy(false);
    }
  }

  async function photo(file: File | undefined) {
    if (!file) return;
    setError(undefined);
    try {
      qc.setQueryData(key, await uploadFile<ProfileDto>(`/portal/profiles/${id}/photo`, file, {}));
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }
  async function dropPhoto() {
    qc.setQueryData(key, await api<ProfileDto>(`/portal/profiles/${id}/photo`, { method: 'DELETE' }));
  }

  const linkError = (i: number, field: 'label' | 'url') => error?.fieldError(`links.${i}.${field}`);
  return (
    <>
      <h1 className="portal-h1">Dein Profil</h1>
      <p className="muted">Für die Website des Vereins. Was Du hier einträgst, sieht die Öffentlichkeit erst, wenn Du eine Profilart wählst und der Vorstand es freigibt.</p>
      <p className="profile-status" data-s={status.s} role="status">{status.text}</p>

      <section className="portal-card profile-photo" aria-labelledby="photo-h">
        <h2 id="photo-h">Foto</h2>
        <div className="profile-photo-row">
          {p.photo ? <img src={`/api/v1/portal/profiles/${id}/photo?v=${p.photo.size}`} alt="Dein Profilfoto" width={96} height={96} /> : <div className="profile-photo-empty" aria-hidden />}
          <div>
            <label className="btn">
              {p.photo ? 'Anderes Foto' : 'Foto hochladen'}
              <input type="file" accept={PROFILE_PHOTO_TYPES.join(',')} className="sr-only" onChange={(e) => void photo(e.currentTarget.files?.[0])} />
            </label>
            {p.photo && <button type="button" className="btn btn-ghost" onClick={() => void dropPhoto()}>Foto löschen</button>}
            <p className="meta">JPG, PNG oder WebP, höchstens 2 MB{p.photo ? ` (jetzt ${bytes(p.photo.size)})` : ''}.</p>
          </div>
        </div>
        {!p.photoConsent && <p className="meta">Der Verein zeigt Dein Foto nur öffentlich, wenn Du in Fotos auf Website und in sozialen Medien eingewilligt hast. Diese Einwilligung erteilst Du beim Verein.</p>}
      </section>

      <form className="form profile-form" onSubmit={(e) => void save(e)} noValidate>
        {error && !error.problem.errors && <div className="alert alert-error" role="alert">{error.problem.title} {error.problem.detail}</div>}
        <Field label="Name im Profil" name="displayName" defaultValue={p.displayName ?? ''} maxLength={80} error={error?.fieldError('displayName')} />
        <div className="field">
          <label htmlFor="bio">Über Dich</label>
          <textarea id="bio" name="bio" className="textarea" defaultValue={p.bio ?? ''} maxLength={2000} rows={5} />
        </div>
        <div className="form-row">
          <Field label="Ort" name="place" defaultValue={p.place ?? ''} maxLength={80} />
          <Field label="Organisation" name="organisation" defaultValue={p.organisation ?? ''} maxLength={120} />
        </div>
        <fieldset className="profile-links">
          <legend>Links</legend>
          {rows.map((l, i) => (
            <div key={i} className="profile-link-row">
              <Field label="Bezeichnung" name={`label-${i}`} value={l.label} onChange={(e) => setLinks(rows.map((x, j) => (j === i ? { ...x, label: e.target.value } : x)))} error={linkError(i, 'label')} />
              <Field label="Adresse" name={`url-${i}`} type="url" value={l.url} placeholder="https://" onChange={(e) => setLinks(rows.map((x, j) => (j === i ? { ...x, url: e.target.value } : x)))} error={linkError(i, 'url')} />
              <button type="button" className="icon-btn" aria-label={`Link ${l.label || i + 1} entfernen`} onClick={() => setLinks(rows.filter((_, j) => j !== i))}><Trash2 size={16} aria-hidden /></button>
            </div>
          ))}
          {rows.length < 10 && <button type="button" className="btn btn-ghost" onClick={() => setLinks([...rows, { label: '', url: '' }])}><Plus size={16} aria-hidden /> Link hinzufügen</button>}
        </fieldset>
        <div className="field">
          <label htmlFor="typeKey">Profilart</label>
          <select id="typeKey" name="typeKey" className="select" defaultValue={p.typeKey}>
            <option value="none">Kein öffentliches Profil</option>
            {p.types.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
          </select>
        </div>
        <fieldset className="agents-access">
          <legend>Deine E-Mail-Adresse sehen</legend>
          {(['board', 'members', 'public'] as const).map((v) => (
            <label key={v} className="radio-row"><input type="radio" name="contactVisibility" value={v} defaultChecked={p.contactVisibility === v} /><span>{CONTACT_VISIBILITY_LABEL[v]}</span></label>
          ))}
        </fieldset>
        <label className="radio-row"><input type="checkbox" name="hidden" defaultChecked={p.hidden} /><span><strong>Profil verbergen</strong><span className="meta"> wirkt sofort, ohne Freigabe</span></span></label>
        {saved && <p className="profile-saved" role="status">Gespeichert.</p>}
        <button className="btn btn-primary btn-block" disabled={busy} aria-busy={busy}>Speichern</button>
      </form>
    </>
  );
}
