import { useEffect, useRef, useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { ACTION_LABEL } from '../../shared/access.ts';
import { formatDate } from '../../shared/dates.ts';
import { displayName, type MemberDetail, type Membership } from '../../shared/members.ts';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal, useGroups } from '../lib/hooks.ts';
import { CourtLines } from './CourtLines.tsx';
import { InlineEdit } from './InlineEdit.tsx';
import { MemberFees } from './MemberFees.tsx';
import { MemberContacts } from './MemberContacts.tsx';
import { MemberFiles } from './MemberFiles.tsx';
import { PortalCode } from './PortalCode.tsx';
import { MemberMails } from './MemberMails.tsx';
import { MemberMandate } from './MemberMandate.tsx';
import { MemberPrivacy } from './MemberPrivacy.tsx';
import { MemberCustom } from './CustomFields.tsx';
import { Sheet } from './Sheet.tsx';
import { StatusBadge } from './StatusBadge.tsx';

const CHANNEL = { email: 'E-Mail', letter: 'Brief', none: 'Keine Post' } as const;
const GENDER = { female: 'weiblich', male: 'männlich', diverse: 'divers' } as const;

export function MemberSheet({ id, onClose, canWrite, permissions = {} }: { id: string | null; onClose: () => void; canWrite: boolean; permissions?: Record<string, string> }) {
  const qc = useQueryClient();
  const { data: m, error } = useQuery({ queryKey: ['member', id], queryFn: () => api<MemberDetail>(`/members/${id}`), enabled: !!id });
  const title = m ? displayName(m) : 'Mitglied';

  // The latest version known to this sheet: edits in quick succession each send the newest one.
  const version = useRef<string | undefined>(undefined);
  if (m && version.current === undefined) version.current = m.version;
  useEffect(() => { if (m) version.current = m.version; }, [m]);
  const [sheetError, setSheetError] = useState<string>();
  const refresh = (next: MemberDetail) => {
    version.current = next.version;
    qc.setQueryData(['member', id], next);
    void qc.invalidateQueries({ queryKey: ['members'] });
    void qc.invalidateQueries({ queryKey: ['overview'] });
  };
  // A change made by someone else in the meantime is not overwritten: the sheet reloads and the user tries again.
  const patch = async (body: Record<string, unknown>) => {
    try {
      refresh(await api<MemberDetail>(`/members/${id}`, { method: 'PATCH', body, ifMatch: version.current }));
    } catch (err) {
      if (err instanceof ApiError && err.problem.status === 412) void reload();
      throw err;
    }
  };
  const reload = async () => refresh(await api<MemberDetail>(`/members/${id}`));

  return (
    <Sheet title={title} open={!!id} onClose={onClose}>
      {error && <div className="alert alert-error" role="alert">{(error as Error).message}</div>}
      {sheetError && <div className="alert alert-error" role="alert">{sheetError}</div>}
      {!m && !error && <div className="skeleton" style={{ width: '60%' }} />}
      {m && (
        <>
          <div className="sheet-sub" style={{ marginTop: 'calc(-1 * var(--s-3))', marginBottom: 'var(--s-5)' }}>
            <StatusBadge status={m.status} />
            <span className="num">Nr. {m.membershipNumber}</span>
          </div>
          {m.warnings.length > 0 && (
            <ul className="warnings" aria-label="Hinweise">
              {m.warnings.map((w) => <li key={w}>{w}</li>)}
            </ul>
          )}

          <section className="sheet-section" aria-labelledby="s-contact">
            <h3 id="s-contact">Kontakt</h3>
            <dl className="facts">
              {m.kind === 'natural' ? (
                <>
                  <dt>Vorname</dt>
                  <dd>{canWrite ? <InlineEdit label="Vorname" value={m.firstName} onSave={(v) => patch({ firstName: v })} /> : m.firstName}</dd>
                  <dt>Nachname</dt>
                  <dd>{canWrite ? <InlineEdit label="Nachname" field="lastName" value={m.lastName} onSave={(v) => patch({ lastName: v })} /> : m.lastName}</dd>
                </>
              ) : (
                <>
                  <dt>Firma</dt>
                  <dd>{canWrite ? <InlineEdit label="Firma" field="companyName" value={m.companyName} onSave={(v) => patch({ companyName: v })} /> : m.companyName}</dd>
                </>
              )}
              {m.email !== undefined && (
                <>
                  <dt>E-Mail</dt>
                  <dd>{canWrite ? <InlineEdit label="E-Mail" type="email" field="email" value={m.email} onSave={(v) => patch({ email: v })} /> : m.email}</dd>
                </>
              )}
              {m.phone !== undefined && (
                <>
                  <dt>Telefon</dt>
                  <dd>{canWrite ? <InlineEdit label="Telefon" type="tel" value={m.phone} onSave={(v) => patch({ phone: v })} /> : m.phone}</dd>
                </>
              )}
              <dt>Straße</dt>
              <dd>{canWrite ? <InlineEdit label="Straße" value={m.street} onSave={(v) => patch({ street: v })} /> : m.street}</dd>
              <dt>PLZ</dt>
              <dd>{canWrite ? <InlineEdit label="PLZ" field="postalCode" value={m.postalCode} onSave={(v) => patch({ postalCode: v, country: m.country })} /> : m.postalCode}</dd>
              <dt>Ort</dt>
              <dd>{canWrite ? <InlineEdit label="Ort" value={m.city} onSave={(v) => patch({ city: v })} /> : m.city}</dd>
              {m.birthDate !== undefined && (
                <>
                  <dt>Geburtsdatum</dt>
                  <dd>{canWrite ? <InlineEdit label="Geburtsdatum" type="date" field="birthDate" value={m.birthDate} display={formatDate} onSave={(v) => patch({ birthDate: v || null })} /> : formatDate(m.birthDate)}</dd>
                </>
              )}
              {m.kind === 'natural' && (
                <>
                  <dt>Geschlecht</dt>
                  <dd>
                    {canWrite ? (
                      <select className="select" aria-label="Geschlecht" value={m.gender ?? ''} onChange={(e) => void patch({ gender: e.target.value || null }).catch((err) => setSheetError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.'))}>
                        <option value="">keine Angabe</option>
                        {Object.entries(GENDER).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                      </select>
                    ) : m.gender ? GENDER[m.gender] : 'keine Angabe'}
                  </dd>
                </>
              )}
              <dt>Post per</dt>
              <dd>
                {canWrite ? (
                  <select className="select" aria-label="Bevorzugter Weg" value={m.preferredChannel} onChange={(e) => void patch({ preferredChannel: e.target.value }).catch((err) => setSheetError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.'))}>
                    {Object.entries(CHANNEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                  </select>
                ) : CHANNEL[m.preferredChannel]}
              </dd>
              {m.note !== undefined && (
                <>
                  <dt>Notiz</dt>
                  <dd>{canWrite ? <InlineEdit label="Notiz" type="textarea" value={m.note} onSave={(v) => patch({ note: v })} /> : m.note}</dd>
                </>
              )}
            </dl>
          </section>

          <MembershipSection m={m} canWrite={canWrite} patch={patch} onChanged={refresh} />
          <GroupsSection m={m} canWrite={canWrite} onChanged={reload} />
          <MemberCustom m={m} canWrite={canWrite} onChanged={refresh} ifMatch={() => version.current} />
          {(m.kind === 'organisation' || m.einvoice.format !== 'none') && (
            <section className="sheet-section" aria-labelledby="m-einvoice">
              <h3 id="m-einvoice">E-Rechnung</h3>
              <dl className="facts">
                <dt>Format</dt>
                <dd>{canWrite ? (
                  <select className="select" aria-label="E-Rechnungsformat" value={m.einvoice.format} onChange={(e) => void patch({ einvoiceFormat: e.target.value }).catch((err) => setSheetError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : 'Das hat nicht geklappt.'))}>
                    <option value="none">keine, PDF genügt</option>
                    <option value="xrechnung">XRechnung</option>
                  </select>
                ) : (m.einvoice.format === 'xrechnung' ? 'XRechnung' : 'keine')}</dd>
                {m.einvoice.format === 'xrechnung' && (
                  <>
                    <dt>Leitweg-ID / Referenz</dt>
                    <dd>{canWrite ? <InlineEdit label="Leitweg-ID oder Käuferreferenz" value={m.einvoice.buyerReference} onSave={(v) => patch({ buyerReference: v })} /> : m.einvoice.buyerReference}</dd>
                    <dt>E-Rechnungsadresse</dt>
                    <dd>{canWrite ? <InlineEdit label="E-Rechnungsadresse" value={m.einvoice.address} onSave={(v) => patch({ einvoiceAddress: v })} /> : m.einvoice.address}</dd>
                    <dt>USt-IdNr.</dt>
                    <dd>{canWrite ? <InlineEdit label="USt-IdNr. der empfangenden Stelle" value={m.einvoice.vatId} onSave={(v) => patch({ vatId: v })} /> : m.einvoice.vatId}</dd>
                  </>
                )}
              </dl>
            </section>
          )}
          {permissions.sepa && permissions.sepa !== 'none' && (
            <MemberMandate memberId={m.id} holder={displayName(m).split(', ').reverse().join(' ')} canWrite={permissions.sepa === 'write'} />
          )}
          {permissions.fees && permissions.fees !== 'none' && (
            <MemberFees memberId={m.id} joinDate={m.joinDate} canWrite={permissions.fees === 'write'} canSeeInvoices={!!permissions.invoices && permissions.invoices !== 'none'} />
          )}
          {permissions.communication && permissions.communication !== 'none' && <MemberMails memberId={m.id} />}
          {!m.restricted.includes('note') && <MemberContacts memberId={m.id} canWrite={canWrite} />}
          <MemberFiles memberId={m.id} canWrite={canWrite} />
          <MemberPrivacy personId={m.personId} canWrite={canWrite} onAnonymised={() => void reload()} />

          <section className="sheet-section" aria-labelledby="s-history">
            <h3 id="s-history">Verlauf</h3>
            <ol className="timeline">
              {m.timeline.map((t, i) => (
                <li key={i}>
                  <time dateTime={t.at}>{new Date(t.at).toLocaleDateString('de-DE')}</time>
                  <span>{ACTION_LABEL[t.action] ?? t.action} <span className="muted">· {t.actor}</span></span>
                </li>
              ))}
            </ol>
          </section>
        </>
      )}
    </Sheet>
  );
}

function MembershipSection({ m, canWrite, patch, onChanged }: { m: MemberDetail; canWrite: boolean; patch: (b: Record<string, unknown>) => Promise<void>; onChanged: (m: MemberDetail) => void }) {
  const [form, setForm] = useState<'resign' | 'admit' | null>(null);
  const [error, setError] = useState<string>();
  const [hint, setHint] = useState<string>();
  const [proposal, setProposal] = useState<string>();

  async function act(path: string, body: unknown = {}) {
    setError(undefined);
    try {
      onChanged(await api<MemberDetail>(`/members/${m.id}/${path}`, { method: 'POST', body }));
      setForm(null);
    } catch (e) {
      setError(e instanceof ApiError ? (e.problem.errors?.[0]?.message ?? e.problem.title) : String(e));
    }
  }

  async function proposeExit(noticeDate: string) {
    if (!noticeDate) return;
    const p = await api<{ exitDate: string; rule: string }>(`/members/exit-proposal?noticeDate=${noticeDate}`);
    setProposal(p.exitDate);
    setHint(`Frühester Termin laut Satzung (${p.rule}): ${formatDate(p.exitDate)}`);
  }

  function submitResign(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    void act('resign', { noticeDate: f.get('noticeDate'), exitDate: f.get('exitDate'), exitReason: f.get('exitReason') || null });
  }

  return (
    <section className="sheet-section" aria-labelledby="s-membership">
      <h3 id="s-membership">Mitgliedschaft</h3>
      <dl className="facts">
        <dt>Eintritt</dt>
        <dd>
          {canWrite && ['active', 'future', 'resigned'].includes(m.status)
            ? <InlineEdit label="Eintrittsdatum" type="date" value={m.joinDate} display={formatDate} onSave={(v) => patch({ joinDate: v })} />
            : formatDate(m.joinDate) || '—'}
        </dd>
        {m.applicationDate && (<><dt>Antrag vom</dt><dd>{formatDate(m.applicationDate)}</dd></>)}
        {m.noticeDate && (<><dt>Kündigung am</dt><dd>{formatDate(m.noticeDate)}</dd></>)}
        {m.exitDate && (<><dt>Austritt</dt><dd>{formatDate(m.exitDate)}{m.exitReason && <span className="muted"> · {m.exitReason}</span>}</dd></>)}
      </dl>
      {error && <div className="alert alert-error" role="alert" style={{ marginTop: 'var(--s-3)' }}>{error}</div>}
      {['active', 'future', 'resigned', 'former'].includes(m.status) && <p style={{ marginTop: 'var(--s-3)' }}><a className="btn btn-ghost" href={`/api/v1/members/${m.id}/certificate.pdf`} download>Mitgliedsbescheinigung (PDF)</a></p>}
      {canWrite && (
        <div className="actions-row">
          {(m.status === 'active' || m.status === 'future') && form !== 'resign' && <button className="btn" onClick={() => setForm('resign')}>Kündigung erfassen</button>}
          {m.status === 'resigned' && <button className="btn" onClick={() => void act('withdraw-resignation')}>Kündigung zurücknehmen</button>}
          {m.status === 'applicant' && form !== 'admit' && <button className="btn btn-primary" onClick={() => setForm('admit')}>Aufnehmen</button>}
          {m.status === 'applicant' && <button className="btn btn-danger" onClick={() => void act('reject')}>Ablehnen</button>}
          {['active', 'future', 'resigned'].includes(m.status) && m.email && <PortalCode key={m.id} memberId={m.id} />}
        </div>
      )}
      {form === 'resign' && (
        <form className="inline-form" onSubmit={submitResign}>
          <div className="form-row">
            <div className="field"><label htmlFor="noticeDate">Kündigung eingegangen am</label><input id="noticeDate" name="noticeDate" type="date" className="input" required defaultValue={todayLocal()} onChange={(e) => void proposeExit(e.target.value)} onFocus={(e) => !proposal && void proposeExit(e.target.value)} /></div>
            <div className="field"><label htmlFor="exitDate">Austritt zum</label><input id="exitDate" name="exitDate" type="date" className="input" required key={proposal} defaultValue={proposal} /></div>
          </div>
          {hint && <p className="meta">{hint}</p>}
          <div className="field"><label htmlFor="exitReason">Grund (optional)</label><input id="exitReason" name="exitReason" className="input" placeholder="z. B. Umzug" /></div>
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary">Kündigung speichern</button>
            <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button>
          </div>
        </form>
      )}
      {form === 'admit' && (
        <form className="inline-form" onSubmit={(e) => { e.preventDefault(); void act('admit', { joinDate: new FormData(e.currentTarget).get('joinDate') }); }}>
          <div className="field"><label htmlFor="joinDate">Eintritt zum</label><input id="joinDate" name="joinDate" type="date" className="input" required defaultValue={todayLocal()} /></div>
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary">Aufnehmen</button>
            <button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button>
          </div>
        </form>
      )}
    </section>
  );
}

function GroupsSection({ m, canWrite, onChanged }: { m: MemberDetail; canWrite: boolean; onChanged: () => Promise<void> }) {
  const { data: groups } = useGroups();
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string>();
  const today = todayLocal();

  async function add(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      await api('/group-memberships', { method: 'POST', body: { memberId: m.id, groupId: f.get('groupId'), validFrom: f.get('validFrom') } });
      setAdding(false);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : String(err));
    }
  }

  async function end(ms: Membership) {
    setError(undefined);
    try {
      await api(`/group-memberships/${ms.id}`, { method: 'PATCH', body: { validTo: today } });
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.detail ?? err.problem.title) : String(err));
    }
  }

  return (
    <section className="sheet-section" aria-labelledby="s-groups">
      <h3 id="s-groups">Gruppen</h3>
      <CourtLines memberships={m.memberships} today={today} onEnd={canWrite ? (ms) => void end(ms) : undefined} />
      {error && <div className="alert alert-error" role="alert">{error}</div>}
      {canWrite && !adding && <button className="btn" onClick={() => setAdding(true)}>Gruppe hinzufügen</button>}
      {adding && (
        <form className="inline-form" onSubmit={add}>
          <div className="form-row">
            <div className="field">
              <label htmlFor="groupId">Gruppe</label>
              <select id="groupId" name="groupId" className="select" required style={{ width: '100%' }}>
                {groups?.map((g) => <option key={g.id} value={g.id}>{g.name}</option>)}
              </select>
            </div>
            <div className="field"><label htmlFor="validFrom">ab</label><input id="validFrom" name="validFrom" type="date" className="input" required defaultValue={today} /></div>
          </div>
          <div className="actions-row" style={{ marginTop: 0 }}>
            <button className="btn btn-primary">Hinzufügen</button>
            <button type="button" className="btn btn-ghost" onClick={() => setAdding(false)}>Abbrechen</button>
          </div>
        </form>
      )}
    </section>
  );
}
