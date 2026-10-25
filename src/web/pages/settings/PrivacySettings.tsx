import { useState, type FormEvent } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import type { Me } from '../../../shared/auth.ts';
import { formatDate } from '../../../shared/dates.ts';
import { RETENTION_CLASSES, type ReviewItem } from '../../../shared/privacy.ts';
import { api, ApiError } from '../../lib/api.ts';
import { useTitle } from '../../lib/useTitle.ts';

export function PrivacySettings({ me }: { me: Me }) {
  useTitle('Datenschutz');
  const qc = useQueryClient();
  const review = useQuery({ queryKey: ['privacy-review'], queryFn: () => api<{ eraseAfterMonths: number; items: ReviewItem[] }>('/privacy/review'), retry: false });
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<string>();

  async function save(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(undefined);
    try {
      await api('/privacy/settings', { method: 'PUT', body: { eraseAfterMonths: Number(new FormData(e.currentTarget).get('months')) } });
      await qc.invalidateQueries({ queryKey: ['privacy-review'] });
      setDone('Gespeichert.');
    } catch (err) {
      setError(err instanceof ApiError ? (err.problem.errors?.map((x) => x.message).join(' ') ?? err.problem.title) : undefined);
    }
  }
  async function anonymise(item: ReviewItem) {
    setError(undefined);
    setDone(undefined);
    try {
      await api(`/persons/${item.personId}/anonymise`, { method: 'POST' });
      setDone(`${item.name} anonymisiert.`);
      await qc.invalidateQueries({ queryKey: ['privacy-review'] });
    } catch (err) {
      setError(err instanceof ApiError ? [err.problem.title, err.problem.detail].filter(Boolean).join(' ') : undefined);
    }
  }

  return (
    <>
      <section aria-labelledby="retention" style={{ marginBottom: 'var(--s-7)' }}>
        <h2 id="retention" style={{ marginBottom: 'var(--s-2)' }}>Aufbewahrung</h2>
        <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>Was wie lange aufbewahrt wird. Fristen laufen ab dem Ende des Kalenderjahres, in dem die Unterlage entstanden ist. Gelöscht wird nur nach Deiner Prüfung.</p>
        <div className="table-wrap">
          <table className="table" aria-label="Aufbewahrungsfristen">
            <thead><tr><th scope="col">Was</th><th scope="col">Wie lange</th><th scope="col" className="hide-sm">Grundlage</th></tr></thead>
            <tbody>{RETENTION_CLASSES.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.period}</td><td className="hide-sm muted">{r.basis}</td></tr>)}</tbody>
          </table>
        </div>
      </section>

      {review.data && (
        <section aria-labelledby="review">
          <h2 id="review" style={{ marginBottom: 'var(--s-2)' }}>Zur Löschung fällig</h2>
          <p className="muted" style={{ maxWidth: '72ch', marginBottom: 'var(--s-4)' }}>Ehemalige, deren Austritt länger als die Löschfrist zurückliegt. Anonymisieren entfernt Name, Anschrift und Kontaktdaten; Rechnungen und Buchungen behalten ihre Angaben bis zum Ende ihrer eigenen Frist.</p>
          {me.permissions.settings === 'write' && (
            <form className="toolbar" noValidate onSubmit={(e) => void save(e)}>
              <label htmlFor="months">Löschfrist nach Austritt</label>
              <input id="months" name="months" className="input num" style={{ width: 88 }} inputMode="numeric" defaultValue={review.data.eraseAfterMonths} key={review.data.eraseAfterMonths} />
              <span className="muted">Monate</span>
              <button className="btn">Speichern</button>
            </form>
          )}
          {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-4)' }}>{error}</div>}
          {done && <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-4)' }}>{done}</div>}
          {review.data.items.length === 0 ? (
            <p className="empty">Niemand ist fällig.</p>
          ) : (
            <div className="table-wrap">
              <table className="table" aria-label="Zur Löschung fällig">
                <thead><tr><th scope="col">Name</th><th scope="col" className="num">Ausgetreten</th><th scope="col">Stand</th></tr></thead>
                <tbody>
                  {review.data.items.map((i) => (
                    <tr key={i.personId}>
                      <td><span className="name">{i.name}</span></td>
                      <td className="num">{formatDate(i.exitDate)}</td>
                      <td>
                        {i.blockers.length ? <span className="muted">{i.blockers.join(' ')}</span> : me.permissions.members === 'write' ? <button className="btn btn-ghost" aria-label={`${i.name} anonymisieren`} onClick={() => void anonymise(i)}>Anonymisieren</button> : <span className="muted">fällig</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="muted" style={{ marginTop: 'var(--s-4)' }}>Auskunft und Einwilligungen einzelner Personen findest Du in der <Link to="/mitglieder">Mitgliederliste</Link> im Abschnitt Datenschutz.</p>
        </section>
      )}
    </>
  );
}
