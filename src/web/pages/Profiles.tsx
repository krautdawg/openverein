import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router';
import type { Me } from '../../shared/auth.ts';
import { CONTACT_VISIBILITY_LABEL, type ProfileDto } from '../../shared/profiles.ts';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { useTitle } from '../lib/useTitle.ts';

interface QueueItem { memberId: string; memberName: string; membershipNumber: string; typeKey: string; typeLabel: string | null; approved: boolean; hidden: boolean; public: boolean; updatedAt: string }
const TABS = [['waiting', 'Warten auf Freigabe'], ['public', 'Öffentlich'], ['all', 'Alle']] as const;

/** One line for where a profile stands, the same words the member reads in the portal. */
const stateOf = (p: { typeKey: string; approved: boolean; hidden: boolean; public: boolean }) =>
  p.typeKey === 'none' ? { s: 'off', text: 'kein öffentliches Profil' } : p.hidden ? { s: 'off', text: 'verborgen' } : p.public ? { s: 'ok', text: 'öffentlich' } : p.approved ? { s: 'off', text: 'freigegeben, Mitgliedschaft beendet' } : { s: 'warn', text: 'wartet auf Freigabe' };

/** The board's view of member profiles for the club's website: approve each version before it goes public. */
export function Profiles({ me }: { me: Me }) {
  useTitle('Profile');
  const { id } = useParams();
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const status = (params.get('status') ?? 'waiting') as (typeof TABS)[number][0];
  const list = useQuery({ queryKey: ['profiles', status], queryFn: () => api<QueueItem[]>(`/profiles?status=${status}`) });
  const suffix = status === 'waiting' ? '' : `?status=${status}`;
  const back = () => navigate(`/mitglieder/profile${suffix}`);
  const open = (memberId: string) => navigate(`/mitglieder/profile/${memberId}${suffix}`);
  return (
    <div className="page">
      <PageHead title="Profile" intro={<>Was Mitglieder für die Website des Vereins über sich schreiben. Öffentlich wird ein Profil erst, wenn Ihr genau diese Fassung freigebt. Die Profilarten legst Du unter <Link to="/einstellungen/profile">Einstellungen → Profile</Link> fest.</>} />
      <div className="toolbar">
        <div className="segmented" role="group" aria-label="Status">
          {TABS.map(([k, label]) => <button key={k} aria-pressed={status === k} onClick={() => setParams(k === 'waiting' ? {} : { status: k })}>{label}</button>)}
        </div>
      </div>
      <div className="table-wrap">
        {list.data?.length === 0 ? (
          <div className="empty-state"><h3>{status === 'waiting' ? 'Nichts wartet auf Freigabe.' : 'Hier ist nichts.'}</h3><p>Mitglieder schreiben ihr Profil im Mitgliederportal unter „Profil“.</p></div>
        ) : (
          <table className="table" aria-label="Profile">
            <thead><tr><th scope="col">Mitglied</th><th scope="col" className="hide-sm">Profilart</th><th scope="col">Stand</th><th scope="col" className="hide-sm">Geändert</th></tr></thead>
            <tbody>
              {list.data?.map((p) => {
                const st = stateOf(p);
                return (
                  <tr key={p.memberId} data-href tabIndex={0} aria-selected={p.memberId === id} onClick={() => open(p.memberId)} onKeyDown={(e) => e.key === 'Enter' && open(p.memberId)}>
                    <td><span className="name">{p.memberName}</span> <span className="meta">Nr. {p.membershipNumber}</span></td>
                    <td className="hide-sm">{p.typeLabel ?? '—'}</td>
                    <td><span className="profile-state" data-s={st.s}>{st.text}</span></td>
                    <td className="hide-sm num">{new Date(p.updatedAt).toLocaleDateString('de-DE')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
      <ProfileSheet memberId={id ?? null} canWrite={me.permissions.members === 'write'} onClose={back} />
    </div>
  );
}

function ProfileSheet({ memberId, canWrite, onClose }: { memberId: string | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const p = useQuery({ queryKey: ['member-profile', memberId], queryFn: () => api<ProfileDto & { updatedAt: string | null }>(`/members/${memberId}/profile`), enabled: !!memberId });
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const d = p.data;

  async function act(path: 'approve' | 'revoke') {
    setBusy(true);
    setError(undefined);
    try {
      await api(`/profiles/${memberId}/${path}`, { method: 'POST', body: path === 'approve' ? { updatedAt: d!.updatedAt } : {} });
      await Promise.all([qc.invalidateQueries({ queryKey: ['profiles'] }), qc.invalidateQueries({ queryKey: ['member-profile', memberId] })]);
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.');
      // Changed meanwhile: show the new version (and the queue) before anyone approves again.
      if (err instanceof ApiError && err.problem.status === 409) await Promise.all([qc.invalidateQueries({ queryKey: ['member-profile', memberId] }), qc.invalidateQueries({ queryKey: ['profiles'] })]);
    } finally {
      setBusy(false);
    }
  }

  const type = d?.types.find((t) => t.key === d.typeKey)?.label;
  const st = d ? stateOf(d) : null;
  return (
    <Sheet
      title={d?.displayName ?? 'Profil'}
      open={!!memberId}
      onClose={onClose}
      footer={canWrite && d && d.typeKey !== 'none' && (
        <>
          {d.approved && <button className="btn btn-ghost btn-danger" disabled={busy} onClick={() => void act('revoke')}>Freigabe zurücknehmen</button>}
          {!d.approved && <button className="btn btn-primary" disabled={busy} aria-busy={busy} onClick={() => void act('approve')}>Diese Fassung freigeben</button>}
        </>
      )}
    >
      {d && st && (
        <div className="profile-review">
          {error && <div className="alert alert-error" role="alert">{error}</div>}
          <p className="profile-state" data-s={st.s}>{st.text}{type ? ` · ${type}` : ''}</p>
          <div className="profile-review-head">
            {d.photo ? <img src={`/api/v1/members/${memberId}/profile/photo?v=${d.photo.size}`} alt={`Foto von ${d.displayName ?? 'dem Mitglied'}`} width={88} height={88} /> : <div className="profile-photo-empty" aria-hidden />}
            <div>
              <h3>{d.displayName ?? '(ohne Namen)'}</h3>
              <p className="meta">{[d.place, d.organisation].filter(Boolean).join(' · ') || 'Kein Ort, keine Organisation'}</p>
            </div>
          </div>
          {d.bio ? <p className="profile-review-bio">{d.bio}</p> : <p className="meta">Kein Text.</p>}
          {d.links.length > 0 && (
            <ul className="profile-review-links">
              {d.links.map((l, i) => <li key={i}><span>{l.label}</span> <a href={l.url} target="_blank" rel="noreferrer noopener">{l.url}</a></li>)}
            </ul>
          )}
          <dl className="facts">
            <dt>E-Mail sehen</dt><dd>{CONTACT_VISIBILITY_LABEL[d.contactVisibility]}</dd>
            <dt>Foto öffentlich</dt><dd>{!d.photo ? 'kein Foto' : d.photoConsent ? 'ja (Einwilligung liegt vor)' : 'nein, keine Einwilligung „Fotos“'}</dd>
          </dl>
        </div>
      )}
    </Sheet>
  );
}
