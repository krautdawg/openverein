export interface HouseholdRule {
  kind: 'none' | 'percent' | 'cap' | 'children_free';
  fromNth: number | null;
  percentBp: number | null;
  capCents: number | null;
}

export interface HouseholdMember {
  memberId: string;
  name: string;
  birthDate: string | null;
  /** membership fee of this run (main slot); discounts never touch extra plans or admission fees */
  mainCents: number;
}

const euro = (c: number) => (c / 100).toLocaleString('de-DE', { style: 'currency', currency: 'EUR' });
const ageAt = (birth: string, date: string) => Number(date.slice(0, 4)) - Number(birth.slice(0, 4)) - (date.slice(5) < birth.slice(5) ? 1 : 0);

export function ruleLabel(r: HouseholdRule) {
  switch (r.kind) {
    case 'percent':
      return `Familienrabatt ${(r.percentBp! / 100).toLocaleString('de-DE')} % ab dem ${r.fromNth}. Mitglied`;
    case 'cap':
      return `Familienhöchstbetrag ${euro(r.capCents!)}`;
    case 'children_free':
      return `Kinder ab dem ${r.fromNth}. Kind beitragsfrei`;
    default:
      return 'Kein Familienrabatt';
  }
}

/**
 * The family discount of one household for one run. Percent: the most expensive membership pays in full, the n-th
 * and further (by fee, highest first) get the percentage off. Cap: membership fees above the cap are waived.
 * Children free: members under 18 on `date`, oldest first; the n-th child and younger pay nothing.
 */
export function householdDiscount(rule: HouseholdRule | null, members: HouseholdMember[], date: string): { discountCents: number; label: string; perMember: Record<string, number> } {
  const perMember: Record<string, number> = {};
  if (!rule || rule.kind === 'none') return { discountCents: 0, label: rule ? ruleLabel(rule) : 'Kein Familienrabatt', perMember };
  const paying = members.filter((m) => m.mainCents > 0);
  if (rule.kind === 'percent') {
    const ordered = [...paying].sort((a, b) => b.mainCents - a.mainCents || a.name.localeCompare(b.name));
    ordered.forEach((m, i) => {
      if (i + 1 >= rule.fromNth!) perMember[m.memberId] = Math.round((m.mainCents * rule.percentBp!) / 10_000);
    });
  } else if (rule.kind === 'cap') {
    const total = paying.reduce((s, m) => s + m.mainCents, 0);
    let over = Math.max(0, total - rule.capCents!);
    // Spread the waiver over the cheapest memberships first, so it shows per member.
    for (const m of [...paying].sort((a, b) => a.mainCents - b.mainCents)) {
      if (!over) break;
      const part = Math.min(over, m.mainCents);
      perMember[m.memberId] = part;
      over -= part;
    }
  } else {
    const children = paying.filter((m) => m.birthDate && ageAt(m.birthDate, date) < 18).sort((a, b) => a.birthDate!.localeCompare(b.birthDate!));
    children.forEach((m, i) => {
      if (i + 1 >= rule.fromNth!) perMember[m.memberId] = m.mainCents;
    });
  }
  return { discountCents: Object.values(perMember).reduce((s, v) => s + v, 0), label: ruleLabel(rule), perMember };
}

export interface PreviewHousehold {
  householdId: string;
  name: string;
  payerPersonId: string;
  payerName: string;
  /** member that carries the invoice (payer's own membership, else the first member): number and payment method */
  anchorMemberId: string;
  memberIds: string[];
  discountCents: number;
  perMember: Record<string, number>;
  label: string;
  hash: string;
}

/** Groups previewed members by household and computes each family discount on the membership fees of the run. */
export async function previewHouseholds(db: import('../db.ts').Db, organizationId: string, members: { memberId: string; lines: { slot: string; amountCents: number; key: string }[] }[], date: string, exclude: Set<string> = new Set()): Promise<PreviewHousehold[]> {
  const ids = members.map((m) => m.memberId);
  if (!ids.length) return [];
  const rows = await db
    .selectFrom('member')
    .innerJoin('person', 'person.id', 'member.person_id')
    .innerJoin('household', 'household.id', 'member.household_id')
    .innerJoin('person as payer', 'payer.id', 'household.payer_person_id')
    .select(['member.id', 'member.person_id', 'member.membership_number', 'member.household_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.company_name', 'person.birth_date', 'household.name as hh_name', 'household.payer_person_id', 'payer.kind as payer_kind', 'payer.first_name as payer_first', 'payer.last_name as payer_last', 'payer.company_name as payer_company'])
    .where('member.organization_id', '=', organizationId)
    .where('member.id', 'in', ids)
    .execute();
  const byHousehold = Map.groupBy(rows, (r) => r.household_id!);
  const out: PreviewHousehold[] = [];
  for (const [householdId, hm] of byHousehold) {
    const rule = await db.selectFrom('household_rule').selectAll().where('household_id', '=', householdId).where('valid_from', '<=', date).orderBy('valid_from', 'desc').executeTakeFirst();
    const r = rule ? { kind: rule.kind, fromNth: rule.from_nth, percentBp: rule.percent_bp, capCents: rule.cap_cents === null ? null : Number(rule.cap_cents) } : null;
    const nameOf = (p: { kind: string; first_name: string | null; last_name: string | null; company_name: string | null }) => (p.kind === 'organisation' ? (p.company_name ?? '') : [p.first_name, p.last_name].filter(Boolean).join(' '));
    const inputs = hm.map((m) => ({
      memberId: m.id,
      name: nameOf(m),
      birthDate: m.birth_date,
      mainCents: (members.find((x) => x.memberId === m.id)?.lines ?? []).filter((l) => l.slot === 'main' && !exclude.has(l.key)).reduce((s, l) => s + l.amountCents, 0),
    }));
    const d = householdDiscount(r, inputs, date);
    const sorted = [...hm].sort((a, b) => a.membership_number.localeCompare(b.membership_number));
    const anchor = sorted.find((m) => m.person_id === hm[0]!.payer_person_id) ?? sorted[0]!;
    out.push({
      householdId,
      name: hm[0]!.hh_name,
      payerPersonId: hm[0]!.payer_person_id,
      payerName: nameOf({ kind: hm[0]!.payer_kind, first_name: hm[0]!.payer_first, last_name: hm[0]!.payer_last, company_name: hm[0]!.payer_company }),
      anchorMemberId: anchor.id,
      memberIds: sorted.map((m) => m.id),
      discountCents: d.discountCents,
      perMember: d.perMember,
      label: d.label,
      // Changes to payer, members, birth dates or the rule make a stored preview stale.
      hash: JSON.stringify([hm[0]!.payer_person_id, rule?.id ?? null, sorted.map((m) => [m.id, m.birth_date])]),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}
