import { useState, type FormEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useParams } from 'react-router';
import { ageOn, MANDATE_TEXT } from '../../shared/applications.ts';
import { Field } from '../components/Field.tsx';
import { api, ApiError } from '../lib/api.ts';
import { euro } from '../../shared/fees.ts';
import { todayLocal } from '../lib/hooks.ts';
import { useTitle } from '../lib/useTitle.ts';

interface PublicForm {
  title: string;
  intro: string | null;
  clubName: string;
  isDemo: boolean;
  groups: { id: string; name: string }[];
  feePlans: { id: string; name: string; amountCents: number; interval: string }[];
  askMandate: boolean;
  creditorId: string | null;
  consentText: string;
  privacyUrl: string | null;
  token: string;
}

/** Public application form; also embedded by clubs in an iframe, so it carries no app chrome. */
export function ApplicationForm() {
  const { slug } = useParams();
  const form = useQuery({ queryKey: ['public-form', slug], queryFn: () => api<PublicForm>(`/public/forms/${slug}`), retry: false });
  useTitle(form.data?.title ?? 'Mitglied werden');
  const [birthDate, setBirthDate] = useState('');
  const [debit, setDebit] = useState(true);
  const [error, setError] = useState<ApiError>();
  const [busy, setBusy] = useState(false);
  const [sent, setSent] = useState<string>();

  if (form.isError) return <main className="apply"><h1>Dieses Formular gibt es nicht (mehr).</h1></main>;
  const f = form.data;
  if (!f) return null;
  const minor = birthDate ? ageOn(birthDate, todayLocal()) < 18 : false;
  const fe = (name: string) => error?.fieldError(`data.${name}`);

  async function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const d = Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;
    const fd = new FormData(e.currentTarget);
    setError(undefined);
    setBusy(true);
    try {
      await api(`/public/forms/${slug}/submit`, {
        method: 'POST',
        body: {
          token: f!.token,
          website: d.website || undefined,
          consent: d.consent === 'on' ? true : undefined,
          data: {
            firstName: d.firstName, lastName: d.lastName, birthDate: d.birthDate, email: d.email, phone: d.phone || undefined,
            street: d.street, postalCode: d.postalCode, city: d.city,
            groupIds: fd.getAll('groupIds'),
            feePlanId: d.feePlanId || null,
            guardian: minor ? { name: d.guardianName, email: d.guardianEmail, phone: d.guardianPhone || undefined } : null,
            mandate: f!.askMandate && debit ? { accountHolder: d.accountHolder, iban: d.iban } : null,
            note: d.note || undefined,
          },
        },
      });
      setSent(minor ? d.guardianEmail : d.email);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"], .alert-error')?.focus());
    } finally {
      setBusy(false);
    }
  }

  if (sent) {
    return (
      <main className="apply" id="main">
        <h1>Danke!</h1>
        <p>Dein Antrag ist bei {f.clubName} angekommen. Eine Kopie geht an {sent}. Der Vorstand meldet sich, sobald er entschieden hat.</p>
      </main>
    );
  }

  const consentError = error?.fieldError('consent');
  return (
    <main className="apply" id="main">
      {/* Not editable by the club: the public demo must never look like a real form collecting real data. */}
      {f.isDemo && <div className="demo-banner" role="note" style={{ marginBottom: 'var(--s-4)' }}><strong>Demo</strong> Dieses Formular gehört zur öffentlichen Demo. Gib keine echten Daten ein, vor allem keine echte IBAN.</div>}
      <p className="apply-club">{f.clubName}</p>
      <h1>{f.title}</h1>
      {f.intro && <p className="apply-intro">{f.intro}</p>}
      <form onSubmit={submit} noValidate className="form">
        {error && !error.problem.errors && <div className="alert alert-error" role="alert" tabIndex={-1}>{error.problem.title} {error.problem.detail}</div>}
        {error?.problem.errors && <div className="alert alert-error" role="alert" tabIndex={-1}>Bitte prüfe die markierten Felder.</div>}
        {/* Honeypot: hidden from people and screen readers; bots fill it. */}
        <div className="apply-hp" aria-hidden="true"><label>Website<input name="website" tabIndex={-1} autoComplete="off" /></label></div>

        <fieldset className="apply-block">
          <legend>Über Dich</legend>
          <div className="form-row">
            <Field label="Vorname" name="firstName" autoComplete="given-name" required error={fe('firstName')} />
            <Field label="Nachname" name="lastName" autoComplete="family-name" required error={fe('lastName')} />
          </div>
          <Field label="Geburtsdatum" name="birthDate" type="date" required value={birthDate} onChange={(e) => setBirthDate(e.target.value)} error={fe('birthDate')} />
          <Field label="E-Mail" name="email" type="email" autoComplete="email" required error={fe('email')} />
          <Field label="Telefon (freiwillig)" name="phone" type="tel" autoComplete="tel" error={fe('phone')} />
          <Field label="Straße und Hausnummer" name="street" autoComplete="street-address" required error={fe('street')} />
          <div className="form-row">
            <Field label="Postleitzahl" name="postalCode" inputMode="numeric" autoComplete="postal-code" required error={fe('postalCode')} />
            <Field label="Ort" name="city" autoComplete="address-level2" required error={fe('city')} />
          </div>
        </fieldset>

        {minor && (
          <fieldset className="apply-block">
            <legend>Erziehungsberechtigte Person</legend>
            <p className="meta">Unter 18 brauchen wir eine erziehungsberechtigte Person. Sie bekommt die Post vom Verein.</p>
            <Field label="Name" name="guardianName" autoComplete="name" required error={fe('guardian.name') ?? fe('guardian')} />
            <Field label="E-Mail" name="guardianEmail" type="email" autoComplete="email" required error={fe('guardian.email')} />
            <Field label="Telefon (freiwillig)" name="guardianPhone" type="tel" error={fe('guardian.phone')} />
          </fieldset>
        )}

        {f.groups.length > 0 && (
          <fieldset className="apply-block">
            <legend>Was möchtest Du machen?</legend>
            {f.groups.map((g) => <label key={g.id} className="check"><input type="checkbox" name="groupIds" value={g.id} /> {g.name}</label>)}
          </fieldset>
        )}

        {f.feePlans.length > 0 && (
          <fieldset className="apply-block" aria-invalid={!!fe('feePlanId')}>
            <legend>Beitrag</legend>
            {f.feePlans.map((p, i) => (
              <label key={p.id} className="check apply-plan"><input type="radio" name="feePlanId" value={p.id} defaultChecked={i === 0 && f.feePlans.length === 1} /> <span>{p.name}</span> <span className="num">{euro(p.amountCents)} {p.interval}</span></label>
            ))}
            {fe('feePlanId') && <p className="field-error">{fe('feePlanId')}</p>}
          </fieldset>
        )}

        {f.askMandate && (
          <fieldset className="apply-block">
            <legend>Bezahlen</legend>
            <label className="check"><input type="checkbox" checked={debit} onChange={(e) => setDebit(e.target.checked)} /> Beitrag per Lastschrift einziehen</label>
            {debit && (
              <>
                <Field label="Kontoinhaber:in" name="accountHolder" autoComplete="name" required error={fe('mandate.accountHolder')} hint={minor ? 'Bei Minderjährigen die erziehungsberechtigte Person.' : undefined} />
                <Field label="IBAN" name="iban" autoComplete="off" required error={fe('mandate.iban')} />
                <p className="meta apply-mandate">{MANDATE_TEXT(f.clubName, f.creditorId)}</p>
              </>
            )}
          </fieldset>
        )}

        <Field label="Anmerkung (freiwillig)" name="note" error={fe('note')} />

        <div className="apply-consent">
          <label className="check"><input type="checkbox" name="consent" aria-invalid={!!consentError} aria-describedby={consentError ? 'consent-error' : undefined} /> <span>{f.consentText}{f.privacyUrl && <> (<a href={f.privacyUrl} target="_blank" rel="noreferrer">Datenschutzhinweise</a>)</>}</span></label>
          {consentError && <p className="field-error" id="consent-error">{consentError}</p>}
        </div>
        <button className="btn btn-primary btn-block" aria-busy={busy} disabled={busy}>Antrag abschicken</button>
      </form>
    </main>
  );
}
