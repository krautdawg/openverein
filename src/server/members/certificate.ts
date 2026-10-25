import PDFDocument from 'pdfkit';
import { formatDate } from '../../shared/dates.ts';
import type { Db } from '../db.ts';
import { FONT, FONT_BOLD } from '../invoices/pdf.ts';
import { orgToday } from './query.ts';

const mm = (v: number) => (v * 72) / 25.4;

/** Membership certificate (Mitgliedsbescheinigung) as of today, e.g. for student discounts or the tax office. */
export async function membershipCertificate(db: Db, organizationId: string, memberId: string, opts: { birthDate: boolean }): Promise<{ pdf: Buffer; name: string }> {
  const today = await orgToday(db, organizationId);
  const m = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id').innerJoin('organization', 'organization.id', 'member.organization_id')
    .select(['member.membership_number', 'member.join_date', 'member.exit_date', 'member.status', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.birth_date', 'organization.name as club', 'organization.street', 'organization.postal_code', 'organization.city', 'organization.is_demo'])
    .where('member.id', '=', memberId).where('member.organization_id', '=', organizationId).executeTakeFirstOrThrow();
  const groups = await db.selectFrom('group_membership').innerJoin('club_group', 'club_group.id', 'group_membership.group_id').select('club_group.name')
    .where('group_membership.member_id', '=', memberId).where('group_membership.valid_from', '<=', today).where((eb) => eb.or([eb('group_membership.valid_to', 'is', null), eb('group_membership.valid_to', '>=', today)])).where('club_group.visible_to_members', '=', true).orderBy('club_group.name').execute();
  const name = m.kind === 'organisation' ? (m.company_name ?? '') : [m.first_name, m.last_name].filter(Boolean).join(' ');
  const doc = new PDFDocument({ size: 'A4', margins: { top: mm(25), left: mm(25), right: mm(20), bottom: mm(20) }, info: { Title: `Mitgliedsbescheinigung ${name}`, Author: m.club } });
  doc.registerFont('text', FONT);
  doc.registerFont('bold', FONT_BOLD);
  const width = doc.page.width - mm(45);
  const ink = '#14202e';
  if (m.is_demo) doc.save().rotate(-35, { origin: [doc.page.width / 2, doc.page.height / 2] }).font('bold').fontSize(80).fillColor('#f2c230').opacity(0.25).text('DEMO', 0, doc.page.height / 2 - 60, { width: doc.page.width, align: 'center' }).restore().opacity(1);
  // The watermark moves the text cursor: start the letter at the top-left margin.
  doc.font('bold').fontSize(13).fillColor(ink).text(m.club, doc.page.margins.left, doc.page.margins.top, { width, align: 'right' });
  doc.font('text').fontSize(9).fillColor('#5f6874').text([m.street, [m.postal_code, m.city].filter(Boolean).join(' ')].filter(Boolean).join(', '), { width, align: 'right' });
  doc.moveDown(4).font('bold').fontSize(18).fillColor(ink).text('Mitgliedsbescheinigung', { width });
  doc.moveDown(1.2).font('text').fontSize(11).fillColor(ink);
  const current = m.status === 'active' || m.status === 'resigned' || (m.status === 'future' && m.join_date !== null && m.join_date <= today);
  const since = m.join_date ? formatDate(m.join_date) : '…';
  doc.text(`Hiermit bestätigen wir, dass ${name}${opts.birthDate && m.birth_date ? `, geboren am ${formatDate(m.birth_date)},` : ''} ${current ? `seit dem ${since} Mitglied` : `vom ${since} bis zum ${m.exit_date ? formatDate(m.exit_date) : '…'} Mitglied`} im ${m.club} ${current ? 'ist' : 'war'}.`, { width, lineGap: 3 });
  if (current && m.exit_date) doc.moveDown(0.6).text(`Die Mitgliedschaft ist zum ${formatDate(m.exit_date)} gekündigt.`, { width });
  if (groups.length) doc.moveDown(0.6).text(`Abteilungen und Gruppen: ${groups.map((g) => g.name).join(', ')}.`, { width });
  doc.moveDown(0.6).text(`Mitgliedsnummer: ${m.membership_number}`, { width });
  doc.moveDown(4).text(`${m.city ?? ''}, ${formatDate(today)}`, { width });
  doc.moveDown(2.5);
  const y = doc.y;
  doc.moveTo(doc.page.margins.left, y).lineTo(doc.page.margins.left + width * 0.45, y).lineWidth(0.5).strokeColor(ink).stroke();
  doc.font('text').fontSize(8).fillColor('#5f6874').text('Unterschrift für den Vorstand', doc.page.margins.left, y + 4, { width: width * 0.45 });
  doc.end();
  const pdf = await new Promise<Buffer>((resolve, reject) => {
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });
  return { pdf, name };
}
