/** Membership anniversaries honoured: from 10 years, every 5 years. */
export const isHonouredAnniversary = (years: number) => years >= 10 && years % 5 === 0;
const ROUND = new Set([18, 30, 40, 50, 60, 65, 70, 75, 80, 85, 90, 95]);
/** Round birthdays: 18, every 10 from 30, the 5s from 65, and every year from 100. */
export const isRoundBirthday = (age: number) => ROUND.has(age) || age >= 100;

const isLeap = (y: number) => y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
/** The same calendar day in `year`; 29 February falls on 28 February in other years. */
export const sameDay = (date: string, year: number) => (date.slice(5) === '02-29' && !isLeap(year) ? `${year}-02-28` : `${year}${date.slice(4)}`);
