import { useState, type FormEvent } from 'react';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, NavLink, useNavigate, useParams, useSearchParams } from 'react-router';
import { FileDown, Plus, Search } from 'lucide-react';
import type { Me } from '../../shared/auth.ts';
import { formatDate } from '../../shared/dates.ts';
import { euro } from '../../shared/fees.ts';
import { INVOICE_KIND_LABEL, INVOICE_STATUS_LABEL, type InvoiceDetail, type InvoiceListItem } from '../../shared/invoices.ts';
import { displayName, type MemberListItem } from '../../shared/members.ts';
import { Field } from '../components/Field.tsx';
import { MoneyField } from '../components/MoneyField.tsx';
import { SendInvoiceMail } from '../components/SendInvoiceMail.tsx';
import { useMe } from '../lib/session.tsx';
import { PageHead } from '../components/PageHead.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { api, ApiError } from '../lib/api.ts';
import { todayLocal } from '../lib/hooks.ts';
import { parseEuro } from '../lib/money.ts';
import { useTitle } from '../lib/useTitle.ts';

type List = { items: InvoiceListItem[]; total: number; nextCursor: string | null; sums: { totalCents: number; openCents: number } };

const VIEWS = [
  { key: 'open', label: 'Offen' },
  { key: 'overdue', label: 'Überfällig' },
  { key: 'draft', label: 'Entwürfe' },
  { key: 'paid', label: 'Bezahlt' },
  { key: 'all', label: 'Alle' },
] as const;

export function InvoiceStatus({ inv }: { inv: Pick<InvoiceListItem, 'status' | 'overdue'> }) {
  const s = inv.overdue ? 'overdue' : inv.status;
  const map: Record<string, string> = { draft: 'future', issued: 'former', open: 'applicant', partially_paid: 'applicant', paid: 'active', cancelled: 'former', written_off: 'rejected', overdue: 'rejected' };
  return <span className="status" data-s={map[s]}>{inv.overdue ? 'Überfällig' : INVOICE_STATUS_LABEL[inv.status]}</span>;
}

export function InvoicesLayout({ children, actions }: { children: React.ReactNode; actions?: React.ReactNode }) {
  return (
    <div className="page">
      <PageHead title="Rechnungen" intro="Ausgestellte Rechnungen sind unveränderlich. Korrekturen laufen über Stornorechnungen." actions={actions} />
      <nav className="subnav" aria-label="Rechnungen">
        <NavLink to="/rechnungen" end>Rechnungen</NavLink>
        <NavLink to="/rechnungen/mahnwesen">Mahnwesen</NavLink>
      </nav>
      {children}
    </div>
  );
}

export function Invoices({ me }: { me: Me }) {
  useTitle('Rechnungen');
  const canWrite = me.permissions.invoices === 'write';
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const { id } = useParams();
  const view = params.get('ansicht') ?? 'open';
  const run = params.get('lauf');
  const [q, setQ] = useState(params.get('q') ?? '');
  const [creating, setCreating] = useState(false);
  const query = `status=${run ? 'all' : view}${run ? `&feeRunId=${run}` : ''}${params.get('q') ? `&q=${encodeURIComponent(params.get('q')!)}` : ''}`;
  const list = useInfiniteQuery({
    queryKey: ['invoices', query],
    queryFn: ({ pageParam }) => api<List>(`/invoices?${query}&limit=50${pageParam ? `&cursor=${pageParam}` : ''}`),
    initialPageParam: '',
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });
  const rows = list.data?.pages.flatMap((p) => p.items) ?? [];
  const first = list.data?.pages[0];

  const set = (k: string, v: string) => {
    const n = new URLSearchParams(params);
    if (v) n.set(k, v);
    else n.delete(k);
    setParams(n, { replace: true });
  };

  return (
    <InvoicesLayout actions={canWrite && <button className="btn btn-primary" onClick={() => setCreating(true)}><Plus size={16} aria-hidden /> Rechnung schreiben</button>}>
      <div className="toolbar" role="search">
        <form className="search" onSubmit={(e) => { e.preventDefault(); set('q', q); }}>
          <Search size={16} aria-hidden />
          <input className="input" type="search" aria-label="Rechnungen suchen" placeholder="Nummer oder Name" value={q} onChange={(e) => setQ(e.target.value)} onBlur={() => set('q', q)} />
        </form>
        {run ? (
          <span className="pill">Nur Beitragslauf <Link to="/rechnungen">× aufheben</Link></span>
        ) : (
          <div className="segmented" role="group" aria-label="Ansicht">
            {VIEWS.map((v) => <button key={v.key} aria-pressed={view === v.key} onClick={() => set('ansicht', v.key === 'open' ? '' : v.key)}>{v.label}</button>)}
          </div>
        )}
      </div>
      {first && (
        <p className="muted" style={{ marginBottom: 'var(--s-3)' }}>
          {first.total} {first.total === 1 ? 'Rechnung' : 'Rechnungen'} · Summe <span className="num">{euro(first.sums.totalCents)}</span> · offen <strong className="num">{euro(first.sums.openCents)}</strong>
        </p>
      )}
      <div className="table-wrap">
        {list.data && rows.length === 0 ? (
          <div className="empty-state"><h3>Keine Rechnungen in dieser Ansicht.</h3><p>Beitragsrechnungen entstehen über einen Beitragslauf; einzelne Rechnungen schreibst Du über „Rechnung schreiben“.</p></div>
        ) : (
          <table className="table" aria-label="Rechnungen">
            <thead><tr><th scope="col">Nummer</th><th scope="col">Empfänger:in</th><th scope="col" className="hide-sm">Art</th><th scope="col" className="num hide-sm">Fällig</th><th scope="col">Status</th><th scope="col" className="num hide-sm">Betrag</th><th scope="col" className="num">Offen</th></tr></thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-href tabIndex={0} onClick={() => navigate({ pathname: `/rechnungen/${r.id}`, search: params.toString() })} onKeyDown={(e) => e.key === 'Enter' && navigate({ pathname: `/rechnungen/${r.id}`, search: params.toString() })}>
                  <td className="name" style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>{r.number ?? 'Entwurf'}</td>
                  <td>{r.recipientName}</td>
                  <td className="hide-sm">{INVOICE_KIND_LABEL[r.kind]}{r.dunningLevel > 0 && <span className="pill" style={{ marginLeft: 6 }}>Mahnstufe {r.dunningLevel}</span>}</td>
                  <td className="num hide-sm">{formatDate(r.dueDate)}</td>
                  <td><InvoiceStatus inv={r} /></td>
                  <td className="num hide-sm">{r.kind === 'cancellation' ? '−' : ''}{euro(r.totalCents)}</td>
                  <td className="num">{r.openCents > 0 ? euro(r.openCents) : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {list.hasNextPage && <div className="table-foot"><span /><button className="btn" onClick={() => void list.fetchNextPage()}>Weitere laden</button></div>}
      <InvoiceSheet id={id ?? null} canWrite={canWrite} onClose={() => navigate({ pathname: '/rechnungen', search: params.toString() })} />
      {creating && <CreateInvoice onClose={() => setCreating(false)} onCreated={(nid) => { setCreating(false); navigate(`/rechnungen/${nid}`); }} />}
    </InvoicesLayout>
  );
}

export function InvoiceSheet({ id, canWrite, onClose }: { id: string | null; canWrite: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const me = useMe().data;
  const canMail = me?.permissions.communication === 'write';
  const { data: inv } = useQuery({ queryKey: ['invoice', id], queryFn: () => api<InvoiceDetail>(`/invoices/${id}`), enabled: !!id });
  const [form, setForm] = useState<'payment' | 'writeoff' | 'hold' | 'cancel' | null>(null);
  const [error, setError] = useState<ApiError>();

  async function run(path: string, body: unknown = {}, method = 'POST') {
    setError(undefined);
    try {
      const next = await api<InvoiceDetail>(`/invoices/${id}${path}`, { method, body });
      if (next) qc.setQueryData(['invoice', id], next);
      void qc.invalidateQueries({ queryKey: ['invoices'] });
      void qc.invalidateQueries({ queryKey: ['dunning'] });
      setForm(null);
      return true;
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
      return false;
    }
  }

  async function reverse(allocationId: string) {
    setError(undefined);
    try {
      await api(`/allocations/${allocationId}/reverse`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['invoice', id] });
      void qc.invalidateQueries({ queryKey: ['invoices'] });
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  const open = inv && ['open', 'partially_paid'].includes(inv.status);
  const receivable = inv && ['membership', 'other', 'dunning_fee'].includes(inv.kind);
  const sign = inv?.kind === 'cancellation' ? '−' : '';

  return (
    <Sheet title={inv ? `${INVOICE_KIND_LABEL[inv.kind]} ${inv.number ?? '(Entwurf)'}` : 'Rechnung'} open={!!id} onClose={() => { setForm(null); setError(undefined); onClose(); }}>
      {!inv && <div className="skeleton" style={{ width: '60%' }} />}
      {inv && (
        <>
          <div className="sheet-sub" style={{ marginTop: 'calc(-1 * var(--s-3))', marginBottom: 'var(--s-5)' }}>
            <InvoiceStatus inv={inv} />
            {inv.issueDate && <span>vom {formatDate(inv.issueDate)}</span>}
            {inv.dueDate && <span>fällig {formatDate(inv.dueDate)}</span>}
          </div>
          {error && <div className="alert alert-error" role="alert" style={{ marginBottom: 'var(--s-4)' }}><strong>{error.problem.title}</strong> {error.problem.detail}</div>}

          <section className="sheet-section">
            <dl className="facts">
              <dt>An</dt>
              <dd>{inv.recipient ? inv.recipient.lines.map((l) => <div key={l}>{l}</div>) : inv.recipientName}{inv.memberId && <div><Link to={`/mitglieder/${inv.memberId}`}>Zum Mitglied</Link></div>}</dd>
              {inv.cancelsInvoice && (<><dt>Storniert</dt><dd><Link to={`/rechnungen/${inv.cancelsInvoice.id}`}>{inv.cancelsInvoice.number}</Link></dd></>)}
              {inv.cancelledBy && (<><dt>Storno</dt><dd><Link to={`/rechnungen/${inv.cancelledBy.id}`}>{inv.cancelledBy.number}</Link></dd></>)}
              {inv.writtenOffReason && (<><dt>Ausgebucht</dt><dd>{inv.writtenOffReason}</dd></>)}
              {inv.dunningHoldUntil && (<><dt>Mahnpause</dt><dd>bis {formatDate(inv.dunningHoldUntil)} · {inv.dunningHoldReason}</dd></>)}
            </dl>
          </section>

          <section className="sheet-section" aria-labelledby="inv-lines">
            <h3 id="inv-lines">Positionen</h3>
            <table className="table" style={{ border: 0 }}>
              <tbody>
                {inv.lines.map((l) => (
                  <tr key={l.id}>
                    <td style={{ paddingLeft: 0 }}>{l.text}{l.quantity !== 1 && <span className="muted"> · {l.quantity.toLocaleString('de-DE')} × {euro(l.unitCents)}</span>}{l.taxRate > 0 && <span className="muted"> · inkl. {l.taxRate} % USt</span>}</td>
                    <td className="num" style={{ paddingRight: 0 }}>{sign}{euro(l.totalCents)}</td>
                  </tr>
                ))}
                <tr>
                  <td style={{ paddingLeft: 0 }}><strong>Gesamt</strong></td>
                  <td className="num" style={{ paddingRight: 0 }}><strong>{sign}{euro(inv.totalCents)}</strong></td>
                </tr>
                {inv.openCents > 0 && inv.openCents !== inv.totalCents && (
                  <tr><td style={{ paddingLeft: 0 }}>Noch offen</td><td className="num" style={{ paddingRight: 0 }}>{euro(inv.openCents)}</td></tr>
                )}
              </tbody>
            </table>
            {inv.status !== 'draft' && (
              <div className="actions-row">
                <a className="btn" href={`/api/v1/invoices/${inv.id}/pdf`} target="_blank" rel="noreferrer"><FileDown size={16} aria-hidden /> PDF</a>
                {inv.hasEinvoice && <a className="btn" href={`/api/v1/invoices/${inv.id}/xrechnung.xml`}><FileDown size={16} aria-hidden /> XRechnung</a>}
              </div>
            )}
          </section>

          {inv.allocations.length > 0 && (
            <section className="sheet-section" aria-labelledby="inv-pay">
              <h3 id="inv-pay">Zahlungen</h3>
              <ol className="timeline">
                {inv.allocations.map((a) => (
                  <li key={a.id} style={{ gridTemplateColumns: '6.5rem 1fr auto' }}>
                    <time>{formatDate(a.bookedOn)}</time>
                    <span style={a.status === 'reversed' ? { textDecoration: 'line-through', color: 'var(--ink-3)' } : undefined}>
                      <span className="num">{euro(a.amountCents)}</span> · {{ cash: 'bar', transfer: 'Überweisung', direct_debit: 'Lastschrift', other: 'sonstige', write_off: 'ausgebucht' }[a.method]}{a.note && ` · ${a.note}`}
                    </span>
                    {canWrite && a.status === 'confirmed' && <button className="btn btn-ghost" onClick={() => void reverse(a.id)}>Zurücknehmen</button>}
                  </li>
                ))}
              </ol>
            </section>
          )}

          {inv.dunning.length > 0 && (
            <section className="sheet-section" aria-labelledby="inv-dun">
              <h3 id="inv-dun">Mahnungen</h3>
              <ol className="timeline">
                {inv.dunning.map((d) => (
                  <li key={d.level}><time>{new Date(d.at).toLocaleDateString('de-DE')}</time><span>{d.label}{d.feeCents > 0 && <> · Gebühr {euro(d.feeCents)} {d.feeInvoiceId && <Link to={`/rechnungen/${d.feeInvoiceId}`}>(eigene Rechnung)</Link>}</>}</span></li>
                ))}
              </ol>
            </section>
          )}

          {canWrite && (
            <section className="sheet-section">
              <div className="actions-row" style={{ marginTop: 0 }}>
                {inv.status === 'draft' && <button className="btn btn-primary" onClick={() => void run('/issue')}>Ausstellen</button>}
                {inv.status === 'draft' && <button className="btn btn-ghost btn-danger" onClick={async () => { if (await run('', {}, 'DELETE')) onClose(); }}>Entwurf löschen</button>}
                {open && <button className="btn btn-primary" onClick={() => setForm('payment')}>Zahlung erfassen</button>}
                {canMail && inv.number && inv.status !== 'cancelled' && <SendInvoiceMail key={`${inv.id}-mail`} invoiceIds={[inv.id]} label="Per E-Mail senden" />}
                {canMail && open && receivable && inv.dunning.length > 0 && <SendInvoiceMail key={`${inv.id}-dun`} invoiceIds={[inv.id]} template="dunning" label="Mahnung per E-Mail" />}
                {open && receivable && <button className="btn" onClick={() => setForm('hold')}>Mahnpause</button>}
                {open && receivable && <button className="btn" onClick={() => setForm('writeoff')}>Ausbuchen</button>}
                {['open', 'partially_paid', 'paid', 'written_off'].includes(inv.status) && inv.kind !== 'cancellation' && <button className="btn btn-ghost btn-danger" onClick={() => setForm('cancel')}>Stornieren</button>}
              </div>
              {form === 'payment' && (
                <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void run('/payments', { amountCents: Number(f.get('amountCents') || NaN), bookedOn: f.get('bookedOn'), method: f.get('method'), note: f.get('note') || null }); }}>
                  <div className="form-row">
                    <MoneyField label="Betrag" name="amountCents" defaultCents={inv.openCents} error={error?.fieldError('amountCents')} />
                    <Field label="Eingegangen am" name="bookedOn" type="date" defaultValue={todayLocal()} />
                  </div>
                  <div className="form-row">
                    <div className="field"><label htmlFor="pm">Art</label><select id="pm" name="method" className="select" style={{ width: '100%' }}><option value="transfer">Überweisung</option><option value="cash">bar</option><option value="other">sonstige</option></select></div>
                    <Field label="Notiz" name="note" />
                  </div>
                  <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Zahlung buchen</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
                </form>
              )}
              {form === 'writeoff' && (
                <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); void run('/write-off', { reason: new FormData(e.currentTarget).get('reason') }); }}>
                  <Field label={`Grund für die Ausbuchung von ${euro(inv.openCents)}`} name="reason" placeholder="z. B. Mitglied verzogen, unbekannt" error={error?.fieldError('reason')} />
                  <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Ausbuchen</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
                </form>
              )}
              {form === 'hold' && (
                <form className="inline-form" noValidate onSubmit={(e) => { e.preventDefault(); const f = new FormData(e.currentTarget); void run('/dunning-hold', { until: f.get('until') || null, reason: f.get('reason') || null }); }}>
                  <div className="form-row">
                    <Field label="Keine Mahnung bis" name="until" type="date" />
                    <Field label="Grund" name="reason" placeholder="z. B. Ratenzahlung vereinbart" error={error?.fieldError('reason')} />
                  </div>
                  <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-primary">Speichern</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
                </form>
              )}
              {form === 'cancel' && (
                <div className="inline-form">
                  <p>Es wird eine Stornorechnung mit eigener Nummer erstellt. Die Rechnung bleibt sichtbar, gilt aber als aufgehoben. Beitragszeiträume werden wieder frei.</p>
                  <div className="actions-row" style={{ marginTop: 0 }}><button className="btn btn-danger" onClick={() => void run('/cancel')}>Stornorechnung erstellen</button><button type="button" className="btn btn-ghost" onClick={() => setForm(null)}>Abbrechen</button></div>
                </div>
              )}
            </section>
          )}
        </>
      )}
    </Sheet>
  );
}

function CreateInvoice({ onClose, onCreated }: { onClose: () => void; onCreated: (id: string) => void }) {
  const qc = useQueryClient();
  const [member, setMember] = useState<MemberListItem | null>(null);
  const [term, setTerm] = useState('');
  const found = useQuery({ queryKey: ['member-pick', term], queryFn: () => api<{ items: MemberListItem[] }>(`/members?q=${encodeURIComponent(term)}&limit=6`), enabled: term.length >= 2 && !member });
  const [lines, setLines] = useState([{ text: '', quantity: '1', price: '', taxRate: '0' }]);
  const [error, setError] = useState<ApiError>();

  async function submit(e: FormEvent<HTMLFormElement>, issue: boolean) {
    e.preventDefault();
    if (!member) return;
    const f = new FormData(e.currentTarget);
    setError(undefined);
    try {
      const body = {
        memberId: member.id,
        kind: f.get('kind'),
        dueDate: f.get('dueDate') || null,
        coverText: f.get('coverText') || null,
        lines: lines.map((l) => ({ text: l.text, quantity: Number(l.quantity.replace(',', '.')), unitCents: parseEuro(l.price) ?? NaN, taxRate: Number(l.taxRate) })),
      };
      const inv = await api<InvoiceDetail>('/invoices', { method: 'POST', body });
      if (issue) await api(`/invoices/${inv.id}/issue`, { method: 'POST' });
      await qc.invalidateQueries({ queryKey: ['invoices'] });
      onCreated(inv.id);
    } catch (err) {
      setError(err instanceof ApiError ? err : undefined);
    }
  }

  return (
    <Sheet title="Rechnung schreiben" open onClose={onClose}>
      <form className="form" noValidate onSubmit={(e) => void submit(e, (e.nativeEvent as SubmitEvent).submitter?.getAttribute('value') === 'issue')}>
        {error && <div className="alert alert-error" role="alert">{error.problem.errors?.map((x) => x.message).join(' ') ?? error.problem.detail ?? error.problem.title}</div>}
        {member ? (
          <div className="field"><span className="label">An</span><div className="inline-edit">{displayName(member)} <span className="muted">Nr. {member.membershipNumber}</span><button type="button" className="btn btn-ghost" onClick={() => setMember(null)}>ändern</button></div></div>
        ) : (
          <div className="field">
            <label htmlFor="pick">An (Mitglied suchen)</label>
            <input id="pick" className="input" autoFocus value={term} onChange={(e) => setTerm(e.target.value)} placeholder="Name oder Nummer" />
            <ul className="timeline">{found.data?.items.map((m) => <li key={m.id} style={{ gridTemplateColumns: '1fr auto' }}><span>{displayName(m)}</span><button type="button" className="btn btn-ghost" onClick={() => setMember(m)}>wählen</button></li>)}</ul>
          </div>
        )}
        <div className="form-row">
          <div className="field"><label htmlFor="kind">Art</label><select id="kind" name="kind" className="select" style={{ width: '100%' }}><option value="other">Rechnung</option><option value="credit_note">Gutschrift</option></select></div>
          <Field label="Fällig am" name="dueDate" type="date" hint="Leer: Zahlungsziel aus den Einstellungen." />
        </div>
        <div className="field"><label htmlFor="cover">Text über den Positionen (optional)</label><textarea id="cover" name="coverText" className="textarea" /></div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="label" style={{ marginBottom: 'var(--s-2)' }}>Positionen (Bruttopreise)</legend>
          {lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 64px 96px 80px', gap: 'var(--s-2)', marginBottom: 'var(--s-2)' }}>
              <input className="input" aria-label={`Position ${i + 1}: Text`} placeholder="Beschreibung" value={l.text} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, text: e.target.value } : x)))} />
              <input className="input num" aria-label={`Position ${i + 1}: Menge`} inputMode="decimal" value={l.quantity} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, quantity: e.target.value } : x)))} />
              <input className="input num" aria-label={`Position ${i + 1}: Einzelpreis in Euro`} inputMode="decimal" placeholder="0,00 €" value={l.price} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, price: e.target.value } : x)))} />
              <select className="select" aria-label={`Position ${i + 1}: Umsatzsteuer`} value={l.taxRate} onChange={(e) => setLines(lines.map((x, j) => (j === i ? { ...x, taxRate: e.target.value } : x)))}><option value="0">0 %</option><option value="7">7 %</option><option value="19">19 %</option></select>
            </div>
          ))}
          <button type="button" className="btn btn-ghost" onClick={() => setLines([...lines, { text: '', quantity: '1', price: '', taxRate: '0' }])}>Position hinzufügen</button>
        </fieldset>
        <div className="actions-row">
          <button className="btn btn-primary" value="issue" disabled={!member}>Ausstellen</button>
          <button className="btn" value="draft" disabled={!member}>Als Entwurf speichern</button>
          <button type="button" className="btn btn-ghost" onClick={onClose}>Abbrechen</button>
        </div>
      </form>
    </Sheet>
  );
}

export function Dunning({ me }: { me: Me }) {
  useTitle('Mahnwesen');
  const qc = useQueryClient();
  const canWrite = me.permissions.invoices === 'write';
  const navigate = useNavigate();
  const { id } = useParams();
  const proposal = useQuery({ queryKey: ['dunning'], queryFn: () => api<{ invoice: InvoiceListItem; nextLevel: number; label: string; feeCents: number; daysOverdue: number }[]>('/dunning/proposal') });
  const [done, setDone] = useState<string>();

  async function apply(invoiceId: string, level: number) {
    await api(`/invoices/${invoiceId}/dunning`, { method: 'POST', body: { level } });
    setDone(`Mahnstufe ${level} angewendet. Der Versand per E-Mail oder Brief ist ein eigener Schritt.`);
    await qc.invalidateQueries({ queryKey: ['dunning'] });
    void qc.invalidateQueries({ queryKey: ['invoices'] });
  }

  return (
    <InvoicesLayout>
      <p className="muted" style={{ marginBottom: 'var(--s-4)', maxWidth: '70ch' }}>Diese Rechnungen haben die nächste Mahnstufe erreicht. Rechnungen mit Mahnpause erscheinen hier erst nach deren Ende. Die Stufen stellst Du in den Einstellungen ein.</p>
      {done && <div className="alert alert-ok" role="status" style={{ marginBottom: 'var(--s-3)' }}>{done}</div>}
      <div className="table-wrap">
        {proposal.data?.length === 0 ? (
          <div className="empty-state"><h3>Nichts zu mahnen.</h3><p>Keine überfällige Rechnung hat die nächste Mahnstufe erreicht.</p></div>
        ) : (
          <table className="table" aria-label="Mahnvorschlag">
            <thead><tr><th scope="col">Rechnung</th><th scope="col">Empfänger:in</th><th scope="col" className="num">Offen</th><th scope="col" className="num">Tage über&shy;fällig</th><th scope="col">Nächste Stufe</th><th scope="col" /></tr></thead>
            <tbody>
              {proposal.data?.map((p) => (
                <tr key={p.invoice.id}>
                  <td style={{ whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}><Link to={`/rechnungen/mahnwesen/${p.invoice.id}`}>{p.invoice.number}</Link></td>
                  <td>{p.invoice.recipientName}</td>
                  <td className="num">{euro(p.invoice.openCents)}</td>
                  <td className="num">{p.daysOverdue}</td>
                  <td>{p.label}{p.feeCents > 0 && <span className="muted"> · Gebühr {euro(p.feeCents)}</span>}</td>
                  <td className="r">{canWrite && <button className="btn" onClick={() => void apply(p.invoice.id, p.nextLevel)}>Anwenden</button>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      <InvoiceSheet id={id ?? null} canWrite={canWrite} onClose={() => navigate('/rechnungen/mahnwesen')} />
    </InvoicesLayout>
  );
}
