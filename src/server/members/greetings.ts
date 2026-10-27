import { sql } from 'kysely';
import { isHonouredAnniversary, isRoundBirthday, sameDay } from '../../shared/honours.ts';
import type { Db } from '../db.ts';
import { sendSystemMail } from '../mail/system.ts';
import { emailHash } from '../mail/worker.ts';
import { orgToday } from './query.ts';

/**
 * Greeting mails (spec P10), for clubs that switched them on: birthdays (all or round ones) and honoured membership
 * anniversaries of current members with an e-mail address. Each greeting is claimed before sending, so it goes out
 * at most once per person and year; a failed send is not retried (a greeting a day late is worse than none).
 */
export async function runGreetings(db: Db) {
  const orgs = await db.selectFrom('organization').select(['id', 'birthday_greetings', 'anniversary_greetings']).where((eb) => eb.or([eb('birthday_greetings', '<>', 'off'), eb('anniversary_greetings', '=', true)])).execute();
  let sent = 0;
  for (const o of orgs) {
    const today = await orgToday(db, o.id);
    const year = Number(today.slice(0, 4));
    const rows = await db.selectFrom('member').innerJoin('person', 'person.id', 'member.person_id')
      .select(['person.id as person_id', 'person.kind', 'person.first_name', 'person.last_name', 'person.email', 'person.birth_date', 'member.join_date', 'member.membership_number'])
      .where('member.organization_id', '=', o.id).where('member.status', '=', 'active').where('person.email', 'is not', null).where('person.preferred_channel', '=', 'email').execute(); // "Brief" or "keine" means no greeting mail
    // Greetings are not club business: an unsubscribe (like from newsletters) stops them too.
    const blocked = new Set((await db.selectFrom('suppression').select('email_hash').where('organization_id', '=', o.id).where('reason', 'in', ['bounce', 'manual', 'unsubscribe']).execute()).map((s) => s.email_hash));
    for (const r of rows) {
      if (blocked.has(emailHash(r.email!))) continue;
      const due: { kind: 'birthday' | 'anniversary'; years: number }[] = [];
      if (o.birthday_greetings !== 'off' && r.kind === 'natural' && r.birth_date && sameDay(r.birth_date, year) === today) {
        const age = year - Number(r.birth_date.slice(0, 4));
        if (o.birthday_greetings === 'all' || isRoundBirthday(age)) due.push({ kind: 'birthday', years: age });
      }
      if (o.anniversary_greetings && r.join_date && sameDay(r.join_date, year) === today) {
        const years = year - Number(r.join_date.slice(0, 4));
        if (isHonouredAnniversary(years)) due.push({ kind: 'anniversary', years });
      }
      for (const g of due) {
        const claimed = await db.insertInto('greeting_sent').values({ organization_id: o.id, person_id: r.person_id, kind: g.kind, year }).onConflict((oc) => oc.doNothing()).returning('person_id').executeTakeFirst();
        if (!claimed) continue;
        const name = [r.first_name, r.last_name].filter(Boolean).join(' ');
        if (await sendSystemMail(db, o.id, g.kind, r.email!, { vorname: r.first_name ?? name, nachname: r.last_name ?? '', name, mitgliedsnummer: r.membership_number, jahre: String(g.years) })) sent++;
      }
    }
  }
  return sent;
}

/** Greeting claims older than two years are not needed any more. */
export const pruneGreetings = (db: Db) => db.deleteFrom('greeting_sent').where('sent_at', '<', sql<Date>`now() - interval '2 years'`).execute();
