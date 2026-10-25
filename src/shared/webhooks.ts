/** Topics a webhook may subscribe to: business records only (no sign-ins, users, keys or exports). */
export const WEBHOOK_TOPICS = {
  member: 'Mitglieder',
  person: 'Personen',
  group: 'Gruppen',
  household: 'Haushalte',
  application: 'Online-Anträge',
  event: 'Termine',
  invoice: 'Rechnungen',
  donation: 'Spenden',
  assembly: 'Versammlungen',
} as const;
export type WebhookTopic = keyof typeof WEBHOOK_TOPICS;
