import { Kysely, PostgresDialect, type Generated, type ColumnType, type Selectable } from 'kysely';
import type { SystemTemplateKey } from '../shared/mail.ts';
import pg from 'pg';

// DATE columns stay strings ("2026-03-01"): legal dates must never shift with time zones.
pg.types.setTypeParser(1082, (v) => v);
// TIMESTAMP WITHOUT TIME ZONE (event wall-clock times) stays a string too.
pg.types.setTypeParser(1114, (v) => v);
// DATE[] (exdates) as string arrays.
pg.types.setTypeParser(1182 as never, (v: string) => (v === '{}' ? [] : v.slice(1, -1).split(',')));
// BIGINT (money in cents, counts) fits a JS number for every realistic club amount.
pg.types.setTypeParser(20, (v) => Number(v));

type Timestamp = ColumnType<Date, Date | string | undefined, Date | string>;

export interface OrganizationTable {
  id: Generated<string>;
  name: string;
  time_zone: Generated<string>;
  is_demo: Generated<boolean>;
  member_number_pattern: Generated<string>;
  notice_weeks: Generated<number>;
  exit_at: Generated<ExitAt>;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  email: string | null;
  iban: string | null;
  bic: string | null;
  bank_name: string | null;
  invoice_number_pattern: Generated<string>;
  cancellation_number_pattern: Generated<string>;
  payment_terms_days: Generated<number>;
  dunning_levels: Generated<DunningLevel[]>;
  creditor_id: string | null;
  prenotification_days: Generated<number>;
  mail_from_name: string | null;
  mail_from_address: string | null;
  mail_reply_to: string | null;
  mail_per_minute: Generated<number>;
  mail_paused_reason: string | null;
  electronic_mandates_agreed: Generated<boolean>;
  join_rule: Generated<'application_date' | 'acceptance_date' | 'month_first' | 'next_month_first'>;
  exemption_kind: 'freistellung' | 'feststellung' | null;
  exemption_office: string | null;
  exemption_tax_number: string | null;
  exemption_date: string | null;
  exemption_period: string | null;
  exemption_purposes: string | null;
  receipt_signer: string | null;
  erase_after_months: Generated<number>;
  vat_id: string | null;
  tax_number: string | null;
  small_business: Generated<boolean>;
  register_number: string | null;
  einvoice_contact_name: string | null;
  einvoice_contact_phone: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  work_hours_required: string | null;
  work_hours_rate_cents: number | null;
  work_hours_age_from: number | null;
  work_hours_age_to: number | null;
  remittance_template: Generated<string>;
  portal_features: Generated<unknown>;
  invoice_cover_template: string | null;
  invoice_closing_template: string | null;
  fee_schedule_day: number | null;
  fee_schedule_lead_days: Generated<number>;
  fee_schedule_user_id: string | null;
  fee_schedule_last_run: string | null;
  offer_number_pattern: Generated<string>;
  birthday_greetings: Generated<'off' | 'round' | 'all'>;
  anniversary_greetings: Generated<boolean>;
  hostname: string | null;
  oidc_enabled: Generated<boolean>;
  oidc_issuer: string | null;
  oidc_client_id: string | null;
  oidc_client_secret_encrypted: string | null;
  oidc_label: string | null;
}

export interface AppUserTable {
  id: Generated<string>;
  organization_id: string;
  email: string;
  name: string;
  password_hash: string | null;
  status: Generated<'active' | 'disabled'>;
  failed_logins: Generated<number>;
  locked_until: Date | null;
  last_login_at: Date | null;
  invite_token_hash: string | null;
  invite_expires_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  totp_secret_encrypted: string | null;
  totp_pending_secret_encrypted: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: number | null;
  overview_layout: Generated<unknown>;
}

export interface SessionTable {
  token_hash: string;
  user_id: string;
  created_at: Timestamp;
  last_seen_at: Timestamp;
  expires_at: Date;
  user_agent: string | null;
  mfa_at: Date | null;
}

export interface AuditEventTable {
  id: Generated<number>;
  organization_id: string;
  actor_user_id: string | null;
  actor_label: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  diff: unknown;
  at: Timestamp;
}

export type ExitAt = 'any_day' | 'month_end' | 'quarter_end' | 'half_year_end' | 'year_end';
export type MemberStatus = 'applicant' | 'future' | 'active' | 'resigned' | 'former' | 'rejected';
export type Level = 'none' | 'read' | 'write';

export interface NumberSequenceTable {
  organization_id: string;
  kind: string;
  year: number;
  next_value: number;
}

export interface PersonTable {
  id: Generated<string>;
  organization_id: string;
  kind: Generated<'natural' | 'organisation'>;
  first_name: string | null;
  last_name: string | null;
  company_name: string | null;
  gender: 'female' | 'male' | 'diverse' | null;
  birth_date: string | null;
  email: string | null;
  phone: string | null;
  street: string | null;
  postal_code: string | null;
  city: string | null;
  country: Generated<string>;
  preferred_channel: Generated<'email' | 'letter' | 'none'>;
  note: string | null;
  status: Generated<'active' | 'archived'>;
  created_at: Timestamp;
  updated_at: Timestamp;
  import_run_id: Generated<string | null>;
  custom: Generated<Record<string, unknown>>;
  anonymised_at: Date | null;
  einvoice_format: Generated<'none' | 'xrechnung'>;
  buyer_reference: string | null;
  einvoice_address: string | null;
  vat_id: string | null;
  legal_hold_reason: string | null;
}

export interface MemberTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  membership_number: string;
  status: MemberStatus;
  application_date: string | null;
  join_date: string | null;
  notice_date: string | null;
  exit_date: string | null;
  exit_reason: string | null;
  payment_method: Generated<PaymentMethod>;
  created_at: Timestamp;
  updated_at: Timestamp;
  import_run_id: Generated<string | null>;
  household_id: string | null;
}

export interface ClubGroupTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  short_code: string;
  kind: Generated<'division' | 'segment' | 'board' | 'team'>;
  color: Generated<string>;
  parent_id: string | null;
  visible_to_members: Generated<boolean>;
  in_application_form: Generated<boolean>;
  next_group_id: string | null;
  next_group_age: number | null;
  next_group_on: 'birthday' | 'year_start' | null;
  archived_at: Date | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  import_run_id: Generated<string | null>;
  portal_overrides: Generated<unknown>;
}

export interface GroupMembershipTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  group_id: string;
  valid_from: string;
  valid_to: string | null;
  created_at: Timestamp;
  import_run_id: Generated<string | null>;
}

export interface RoleTable {
  id: Generated<string>;
  organization_id: string;
  builtin_key: string | null;
  name: string;
  permissions: Record<string, Level>;
  restricted_fields: Generated<string[]>;
  created_at: Timestamp;
}

export interface RoleGrantTable {
  id: Generated<string>;
  organization_id: string;
  user_id: string;
  role_id: string;
  scope_group_ids: string[] | null;
  created_at: Timestamp;
}

export interface ApiTokenTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  prefix: string;
  token_hash: string;
  role_id: string;
  scope_group_ids: string[] | null;
  created_by: string | null;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Timestamp;
}

export type PaymentMethod = 'none' | 'direct_debit' | 'transfer' | 'cash';
export interface DunningLevel {
  level: number;
  label: string;
  days: number;
  feeCents: number;
}
export type InvoiceKind = 'membership' | 'other' | 'credit_note' | 'cancellation' | 'dunning_fee';
export type InvoiceStatus = 'draft' | 'issued' | 'open' | 'partially_paid' | 'paid' | 'cancelled' | 'written_off';

export interface FeePlanTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  line_text: Generated<string>;
  status: Generated<'active' | 'retired'>;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface FeePlanVersionTable {
  id: Generated<string>;
  organization_id: string;
  fee_plan_id: string;
  valid_from: string;
  amount_cents: number;
  interval_months: number | null;
  anchor: Generated<'calendar' | 'entry'>;
  proration: Generated<'none' | 'month'>;
  admission_fee_cents: Generated<number>;
  created_at: Timestamp;
  age_brackets: Generated<unknown>;
}

export interface FeeAssignmentTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  fee_plan_id: string;
  is_main: Generated<boolean>;
  valid_from: string;
  valid_to: string | null;
  first_period_start: string | null;
  override_cents: number | null;
  override_reason: string | null;
  created_at: Timestamp;
}

export interface FeeRunTable {
  id: Generated<string>;
  organization_id: string;
  until: string;
  issue_date: string;
  due_date: string;
  group_id: string | null;
  status: Generated<'preview' | 'posted' | 'cancelled'>;
  preview: unknown;
  input_hash: string;
  created_by: string | null;
  created_at: Timestamp;
  posted_at: Date | null;
  cancelled_at: Date | null;
}

export interface InvoiceTable {
  id: Generated<string>;
  organization_id: string;
  number: string | null;
  kind: InvoiceKind;
  status: Generated<InvoiceStatus>;
  recipient_person_id: string;
  member_id: string | null;
  recipient: unknown;
  issue_date: string | null;
  due_date: string | null;
  total_cents: Generated<number>;
  paid_cents: Generated<number>;
  cover_text: string | null;
  cancels_invoice_id: string | null;
  fee_run_id: string | null;
  pdf: Buffer | null;
  pdf_sha256: string | null;
  written_off_reason: string | null;
  dunning_hold_until: string | null;
  dunning_hold_reason: string | null;
  created_by: string | null;
  created_at: Timestamp;
  issued_at: Date | null;
  updated_at: Timestamp;
  closing_text: string | null;
}

export interface InvoiceLineTable {
  id: Generated<string>;
  organization_id: string;
  invoice_id: string;
  position: number;
  text: string;
  quantity: ColumnType<string, string | number | undefined, string | number>;
  unit_cents: number;
  total_cents: number;
  tax_rate: ColumnType<string, string | number | undefined, string | number>;
  assessment_id: string | null;
  discount: Generated<boolean>;
}

export interface AssessmentTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  assignment_id: string;
  fee_run_id: string | null;
  charge_slot: string;
  period_start: string;
  period_end: string;
  amount_cents: number;
  snapshot: unknown;
  status: Generated<'posted' | 'cancelled'>;
  created_at: Timestamp;
}

export interface AllocationTable {
  id: Generated<string>;
  organization_id: string;
  invoice_id: string;
  amount_cents: number;
  booked_on: string;
  method: 'cash' | 'transfer' | 'direct_debit' | 'other' | 'write_off';
  note: string | null;
  status: Generated<'confirmed' | 'reversed'>;
  created_by: string | null;
  created_at: Timestamp;
  reversed_at: Date | null;
  bank_transaction_id: Generated<string | null>;
  collection_item_id: Generated<string | null>;
}

export interface DunningEventTable {
  id: Generated<string>;
  organization_id: string;
  invoice_id: string;
  level: number;
  label: string;
  fee_cents: Generated<number>;
  fee_invoice_id: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface BankAccountTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  iban: string;
  bic: string | null;
  opening_balance_cents: Generated<number>;
  opening_date: string;
  min_lead_days: Generated<number>;
  order_limit_cents: number | null;
  archived_at: Date | null;
  created_at: Timestamp;
  ledger_account_id: string | null;
}

export interface SepaMandateTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  reference: string;
  signed_on: string;
  account_holder: string;
  iban_encrypted: string;
  iban_hash: string;
  iban_last4: string;
  bic: string | null;
  type: Generated<'recurrent' | 'one_off'>;
  status: Generated<'pending_evidence' | 'active' | 'revoked' | 'expired'>;
  first_collected: Generated<boolean>;
  amended_from_iban_encrypted: string | null;
  amendment_pending: Generated<boolean>;
  last_collected_on: string | null;
  revoked_on: string | null;
  revoke_reason: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  import_run_id: Generated<string | null>;
}

export interface CollectionRunTable {
  id: Generated<string>;
  organization_id: string;
  kind: 'debit' | 'transfer';
  bank_account_id: string;
  collection_date: string;
  status: Generated<'draft' | 'generated' | 'downloaded' | 'submitted' | 'settled' | 'released'>;
  created_by: string | null;
  created_at: Timestamp;
  generated_at: Date | null;
  submitted_at: Date | null;
  released_at: Date | null;
  release_reason: string | null;
}

export interface CollectionFileTable {
  id: Generated<string>;
  organization_id: string;
  run_id: string;
  position: number;
  message_id: string;
  schema: string;
  sequence_type: string | null;
  xml_encrypted: string;
  sha256: string;
  item_count: number;
  control_sum_cents: number;
  first_downloaded_at: Date | null;
  created_at: Timestamp;
}

export interface CollectionItemTable {
  id: Generated<string>;
  organization_id: string;
  run_id: string;
  file_id: string | null;
  mandate_id: string | null;
  person_id: string;
  end_to_end_id: string;
  amount_cents: number;
  sequence_type: string | null;
  status: Generated<'included' | 'settled' | 'returned' | 'withdrawn'>;
  created_at: Timestamp;
  amended_from_iban_encrypted: string | null;
}

export interface CollectionItemInvoiceTable {
  id: Generated<string>;
  organization_id: string;
  item_id: string;
  invoice_id: string;
  amount_cents: number;
  live: Generated<boolean>;
}

export interface BankStatementImportTable {
  id: Generated<string>;
  organization_id: string;
  bank_account_id: string;
  format: 'camt053' | 'csv';
  file_name: string | null;
  file_sha256: string;
  period_from: string | null;
  period_to: string | null;
  opening_cents: number | null;
  closing_cents: number | null;
  transaction_count: Generated<number>;
  raw_encrypted: string | null;
  created_by: string | null;
  created_at: Timestamp;
}

export interface BankTransactionTable {
  id: Generated<string>;
  organization_id: string;
  bank_account_id: string;
  import_id: string | null;
  booking_date: string;
  value_date: string | null;
  amount_cents: number;
  counterparty_name: string | null;
  counterparty_iban_encrypted: string | null;
  counterparty_iban_hash: string | null;
  remittance: Generated<string>;
  end_to_end_id: string | null;
  mandate_reference: string | null;
  return_reason: string | null;
  bank_reference: string | null;
  dedupe_key: string;
  status: Generated<'unmatched' | 'matched' | 'ignored' | 'booked'>;
  note: string | null;
  created_at: Timestamp;
  journal_entry_id: string | null;
}

export interface ReturnDebitTable {
  id: Generated<string>;
  organization_id: string;
  bank_transaction_id: string;
  collection_item_id: string;
  reason_code: string | null;
  fee_cents: Generated<number>;
  created_by: string | null;
  created_at: Timestamp;
}

export interface CalendarTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  color: Generated<string>;
  group_ids: string[] | null;
  feed_token_hash: string | null;
  created_at: Timestamp;
  public: Generated<boolean>;
  public_origins: Generated<string[]>;
}

/** Wall-clock timestamps in the club's time zone, kept as 'YYYY-MM-DD HH:MM:SS' strings. */
export interface EventTable {
  id: Generated<string>;
  organization_id: string;
  calendar_id: string;
  title: string;
  description: string | null;
  location: string | null;
  starts_at: string;
  ends_at: string;
  all_day: Generated<boolean>;
  rrule: string | null;
  exdates: Generated<string[]>;
  max_participants: number | null;
  rsvp: Generated<boolean>;
  registration_closes_hours: number | null;
  price_cents: number | null;
  created_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
  import_uid: string | null;
  child_price_cents: number | null;
  child_up_to_age: number | null;
}

export type ParticipationStatus = 'yes' | 'maybe' | 'no' | 'waitlist' | 'attended' | 'not_attended';
export interface ParticipationTable {
  id: Generated<string>;
  organization_id: string;
  event_id: string;
  occurrence_date: string;
  member_id: string;
  status: ParticipationStatus;
  waitlisted_at: Date | null;
  invoice_id: string | null;
  updated_by: string | null;
  created_at: Timestamp;
  updated_at: Timestamp;
}

export interface MessageTable {
  id: Generated<string>;
  organization_id: string;
  kind: Generated<'free' | 'invoices' | 'donation_receipts'>;
  category: Generated<'notice' | 'newsletter'>;
  subject: string;
  body: string;
  recipient_filter: unknown;
  status: Generated<'sending' | 'sent'>;
  created_by: string | null;
  created_by_label: string;
  created_at: Timestamp;
  finished_at: Date | null;
}

export interface DeliveryTable {
  id: Generated<string>;
  organization_id: string;
  message_id: string;
  person_id: string;
  member_id: string | null;
  email: string;
  invoice_id: string | null;
  status: Generated<'queued' | 'sending' | 'sent' | 'failed' | 'bounced' | 'skipped'>;
  attempts: Generated<number>;
  claimed_at: Date | null;
  next_attempt_at: Generated<Date>;
  error: string | null;
  provider_id: string | null;
  sent_at: Date | null;
  created_at: Timestamp;
  donation_receipt_id: string | null;
}

export interface MailTemplateTable {
  id: Generated<string>;
  organization_id: string;
  key: SystemTemplateKey | null;
  name: string;
  subject: string;
  body: string;
  category: Generated<'notice' | 'newsletter'>;
  updated_at: Generated<Date>;
}

export interface FolderTable {
  id: Generated<string>;
  organization_id: string;
  parent_id: string | null;
  name: string;
  group_ids: string[] | null;
  share_with_members: Generated<boolean>;
  created_at: Generated<Date>;
}

export type RetentionClass = 'document' | 'voucher' | 'temporary';
export interface FileTable {
  id: Generated<string>;
  organization_id: string;
  folder_id: string | null;
  member_id: string | null;
  sha256: string;
  size_bytes: number;
  mime_type: string;
  name: string;
  retention_class: Generated<RetentionClass>;
  retain_until: string | null;
  legal_hold: Generated<boolean>;
  previous_id: string | null;
  superseded_at: Date | null;
  purpose: Generated<'document' | 'receipt' | 'export'>;
  uploaded_by: string | null;
  created_at: Generated<Date>;
  temporary_since: Generated<Date | null>;
}

export interface LoginCodeTable {
  id: Generated<string>;
  organization_id: string;
  email_hash: string;
  code_hash: string;
  expires_at: Date;
  attempts: Generated<number>;
  consumed_at: Date | null;
  issued_by: string | null;
  created_at: Generated<Date>;
}

export interface PortalSessionTable {
  token_hash: string;
  organization_id: string;
  email: string;
  created_at: Generated<Date>;
  last_seen_at: Generated<Date>;
  expires_at: Date;
}

export type ChangeField = 'first_name' | 'last_name' | 'email' | 'phone' | 'address' | 'iban' | 'resignation';
export interface ChangeRequestTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  person_id: string;
  field: ChangeField;
  old_value: string | null;
  new_value: string;
  status: Generated<'pending' | 'accepted' | 'denied' | 'superseded' | 'applied'>;
  reason: string | null;
  requested_by_email: string;
  requested_at: Generated<Date>;
  decided_by: string | null;
  decided_at: Date | null;
}

export interface ApplicationFormTable {
  id: Generated<string>;
  organization_id: string;
  slug: string;
  title: string;
  intro: string | null;
  group_ids: Generated<string[]>;
  fee_plan_ids: Generated<string[]>;
  ask_mandate: Generated<boolean>;
  consent_text: string;
  consent_version: Generated<number>;
  privacy_url: string | null;
  allowed_origins: Generated<string[]>;
  active: Generated<boolean>;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ApplicationTable {
  id: Generated<string>;
  organization_id: string;
  form_id: string;
  payload: unknown;
  consent: unknown;
  application_date: string;
  email_hash: string;
  iban_encrypted: string | null;
  iban_last4: string | null;
  token_mac: string | null;
  status: Generated<'new' | 'accepted' | 'rejected' | 'spam'>;
  reason: string | null;
  member_id: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  created_at: Generated<Date>;
}

export interface ImportRunTable {
  id: Generated<string>;
  organization_id: string;
  kind: Generated<'members'>;
  file_name: string | null;
  file_sha256: string;
  preset: string | null;
  counts: Generated<unknown>;
  created_by: string | null;
  created_at: Generated<Date>;
  rolled_back_at: Date | null;
}

export interface TotpRecoveryCodeTable {
  id: Generated<string>;
  user_id: string;
  code_hash: string;
  used_at: Date | null;
}

export type Sphere = 'ideell' | 'vermoegen' | 'zweck' | 'wirtschaft';
export interface LedgerAccountTable {
  id: Generated<string>;
  organization_id: string;
  number: string;
  name: string;
  kind: 'money' | 'income' | 'expense' | 'tax' | 'transit' | 'other';
  default_sphere: Generated<Sphere>;
  datev_number: string | null;
  hidden: Generated<boolean>;
  retired_at: Date | null;
  created_at: Generated<Date>;
}

export interface TaxRateTable {
  id: Generated<string>;
  organization_id: string;
  label: string;
  rate_bp: number;
  valid_from: string;
  valid_to: string | null;
  output_account_id: string | null;
  input_account_id: string | null;
}

export interface CostCenterTable {
  id: Generated<string>;
  organization_id: string;
  code: string;
  name: string;
}

export interface LedgerSettingTable {
  organization_id: string;
  bank_account_id: string | null;
  cash_account_id: string | null;
  fee_account_id: string | null;
  other_income_account_id: string | null;
  dunning_account_id: string | null;
  lock_date: string | null;
  datev_consultant: number | null;
  datev_client: number | null;
  datev_account_length: Generated<number>;
  fiscal_year_start_month: Generated<number>;
}

export interface DatevExportTable {
  id: Generated<string>;
  organization_id: string;
  mode: 'delta' | 'full';
  period_from: string;
  period_to: string;
  entry_count: number;
  file: Buffer;
  sha256: string;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface DatevExportEntryTable {
  export_id: string;
  entry_id: string;
}

export interface JournalEntryTable {
  id: Generated<string>;
  organization_id: string;
  number: number;
  entry_date: string;
  text: string;
  source: 'manual' | 'allocation' | 'allocation_reversal' | 'reversal' | 'receipt' | 'import' | 'donation';
  source_id: string | null;
  reverses_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface JournalLineTable {
  id: Generated<string>;
  organization_id: string;
  entry_id: string;
  account_id: string;
  debit_cents: Generated<number>;
  credit_cents: Generated<number>;
  sphere: Sphere;
  cost_center_id: string | null;
  tax_rate_id: string | null;
  text: string | null;
}

export interface SuppressionTable {
  id: Generated<string>;
  organization_id: string;
  email_hash: string;
  reason: 'unsubscribe' | 'bounce' | 'manual';
  created_at: Timestamp;
}

export interface ContactLogTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  kind: 'call' | 'meeting' | 'letter' | 'email' | 'other';
  occurred_on: string;
  text: string;
  file_id: string | null;
  private: Generated<boolean>;
  created_by: string;
  created_at: Generated<Date>;
}

export interface OfferTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  person_id: string;
  number: string | null;
  status: Generated<'draft' | 'sent' | 'accepted' | 'declined' | 'converted'>;
  issue_date: string | null;
  valid_until: string | null;
  recipient: unknown;
  cover_text: string | null;
  closing_text: string | null;
  total_cents: Generated<string | number>;
  pdf: Buffer | null;
  invoice_id: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface OfferLineTable {
  id: Generated<string>;
  organization_id: string;
  offer_id: string;
  position: number;
  text: string;
  quantity: number | string;
  unit_cents: number | string;
  total_cents: number | string;
  tax_rate: number | string;
}

export interface TaskTable {
  id: Generated<string>;
  organization_id: string;
  title: string;
  note: string | null;
  due_on: string | null;
  assignee_user_id: string | null;
  member_id: string | null;
  done_at: Date | null;
  done_by: string | null;
  created_by: string;
  created_at: Generated<Date>;
}

export interface GreetingSentTable {
  organization_id: string;
  person_id: string;
  kind: 'birthday' | 'anniversary';
  year: number;
  sent_at: Generated<Date>;
}

export interface HonourTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  title: string;
  awarded_on: string;
  decision: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface PortalVerifyFailureTable {
  email_hash: string;
  day: string;
  n: Generated<number>;
}

export interface Database {
  organization: OrganizationTable;
  app_user: AppUserTable;
  session: SessionTable;
  audit_event: AuditEventTable;
  number_sequence: NumberSequenceTable;
  person: PersonTable;
  member: MemberTable;
  club_group: ClubGroupTable;
  group_membership: GroupMembershipTable;
  role: RoleTable;
  role_grant: RoleGrantTable;
  api_token: ApiTokenTable;
  fee_plan: FeePlanTable;
  fee_plan_version: FeePlanVersionTable;
  fee_assignment: FeeAssignmentTable;
  fee_run: FeeRunTable;
  invoice: InvoiceTable;
  invoice_line: InvoiceLineTable;
  assessment: AssessmentTable;
  allocation: AllocationTable;
  dunning_event: DunningEventTable;
  bank_account: BankAccountTable;
  sepa_mandate: SepaMandateTable;
  collection_run: CollectionRunTable;
  collection_file: CollectionFileTable;
  collection_item: CollectionItemTable;
  collection_item_invoice: CollectionItemInvoiceTable;
  bank_statement_import: BankStatementImportTable;
  bank_transaction: BankTransactionTable;
  return_debit: ReturnDebitTable;
  calendar: CalendarTable;
  event: EventTable;
  participation: ParticipationTable;
  message: MessageTable;
  delivery: DeliveryTable;
  suppression: SuppressionTable;
  mail_template: MailTemplateTable;
  folder: FolderTable;
  file: FileTable;
  login_code: LoginCodeTable;
  portal_session: PortalSessionTable;
  change_request: ChangeRequestTable;
  application_form: ApplicationFormTable;
  application: ApplicationTable;
  import_run: ImportRunTable;
  totp_recovery_code: TotpRecoveryCodeTable;
  ledger_account: LedgerAccountTable;
  tax_rate: TaxRateTable;
  cost_center: CostCenterTable;
  ledger_setting: LedgerSettingTable;
  journal_entry: JournalEntryTable;
  journal_line: JournalLineTable;
  datev_export: DatevExportTable;
  datev_export_entry: DatevExportEntryTable;
  donation: DonationTable;
  donation_receipt: DonationReceiptTable;
  donation_receipt_item: DonationReceiptItemTable;
  custom_field: CustomFieldTable;
  consent: ConsentTable;
  erasure_log: ErasureLogTable;
  operator_event: OperatorEventTable;
  oidc_identity: OidcIdentityTable;
  personal_token: PersonalTokenTable;
  agent_call: AgentCallTable;
  oauth_code: { nonce: string; used_at: Generated<Date> };
  idempotency_key: IdempotencyKeyTable;
  invoice_einvoice: InvoiceEinvoiceTable;
  duplicate_dismissal: DuplicateDismissalTable;
  saved_view: SavedViewTable;
  household: HouseholdTable;
  household_rule: HouseholdRuleTable;
  receipt: ReceiptTable;
  receipt_line: ReceiptLineTable;
  job: JobTable;
  expense_claim: ExpenseClaimTable;
  work_hour_entry: WorkHourEntryTable;
  work_hour_settlement: WorkHourSettlementTable;
  work_hour_rule: WorkHourRuleTable;
  assembly: AssemblyTable;
  assembly_item: AssemblyItemTable;
  assembly_attendance: AssemblyAttendanceTable;
  article: ArticleTable;
  instance_setting: InstanceSettingTable;
  allowance_payment: AllowancePaymentTable;
  allowance_declaration: AllowanceDeclarationTable;
  webhook: WebhookTable;
  webhook_delivery: WebhookDeliveryTable;
  budget_line: BudgetLineTable;
  poll: PollTable;
  poll_vote: PollVoteTable;
  inventory_item: InventoryItemTable;
  inventory_loan: InventoryLoanTable;
  contact_log: ContactLogTable;
  offer: OfferTable;
  offer_line: OfferLineTable;
  task: TaskTable;
  greeting_sent: GreetingSentTable;
  honour: HonourTable;
  portal_verify_failure: PortalVerifyFailureTable;
}

export interface InventoryItemTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  category: string | null;
  location: string | null;
  serial: string | null;
  quantity: Generated<number>;
  value_cents: number | null;
  note: string | null;
  archived_at: Date | null;
  created_at: Generated<Date>;
}
export interface InventoryLoanTable {
  id: Generated<string>;
  organization_id: string;
  item_id: string;
  member_id: string;
  quantity: Generated<number>;
  lent_on: string;
  due_on: string | null;
  returned_on: string | null;
  note: string | null;
  lent_by: string | null;
}

export interface PollTable {
  id: Generated<string>;
  organization_id: string;
  question: string;
  description: string | null;
  options: string[];
  multiple: Generated<boolean>;
  group_id: string | null;
  closes_on: string;
  created_by: string | null;
  created_at: Generated<Date>;
}
export interface PollVoteTable {
  poll_id: string;
  member_id: string;
  choices: number[];
  voted_at: Generated<Date>;
}

export interface BudgetLineTable {
  organization_id: string;
  year: number;
  account_id: string;
  planned_cents: number;
}

export interface WebhookTable {
  id: Generated<string>;
  organization_id: string;
  url: string;
  secret_encrypted: string;
  topics: string[];
  active: Generated<boolean>;
  created_at: Generated<Date>;
}
export interface WebhookDeliveryTable {
  id: Generated<string>;
  organization_id: string;
  webhook_id: string;
  event: string;
  entity_type: string;
  entity_id: string | null;
  occurred_at: Date;
  status: Generated<'queued' | 'sending' | 'sent' | 'failed'>;
  attempts: Generated<number>;
  next_attempt_at: Generated<Date>;
  claimed_at: Date | null;
  response_status: number | null;
  error: string | null;
  sent_at: Date | null;
}

export interface AllowancePaymentTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  kind: 'uebungsleiter' | 'ehrenamt';
  paid_on: string;
  amount_cents: number;
  text: string;
  created_by: string | null;
  created_at: Generated<Date>;
  voided_at: Date | null;
  voided_by: string | null;
  void_reason: string | null;
}
export interface AllowanceDeclarationTable {
  organization_id: string;
  person_id: string;
  year: number;
  kind: 'uebungsleiter' | 'ehrenamt';
  other_cents: number;
  declared_on: string;
}

export interface InstanceSettingTable {
  key: string;
  value: string;
  updated_at: Generated<Date>;
}

export interface ArticleTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  unit_cents: number;
  tax_rate: Generated<number>;
  archived_at: Date | null;
  created_at: Generated<Date>;
}

export interface AssemblyTable {
  id: Generated<string>;
  organization_id: string;
  title: string;
  held_on: string;
  starts_at: string;
  place: string;
  notice_days: Generated<number>;
  chair: string | null;
  minutes_by: string | null;
  invited_at: Date | null;
  message_id: string | null;
  closed_at: Date | null;
  created_at: Generated<Date>;
  kind: Generated<'general' | 'board'>;
  group_id: string | null;
}
export interface AssemblyItemTable {
  id: Generated<string>;
  assembly_id: string;
  position: number;
  title: string;
  description: string | null;
  is_vote: Generated<boolean>;
  votes_yes: number | null;
  votes_no: number | null;
  votes_abstain: number | null;
  outcome: string | null;
}
export interface AssemblyAttendanceTable {
  assembly_id: string;
  member_id: string;
}

export interface WorkHourEntryTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  worked_on: string;
  hours: string;
  text: string;
  logged_by: string | null;
  created_at: Generated<Date>;
}

export interface WorkHourSettlementTable {
  organization_id: string;
  member_id: string;
  year: number;
  invoice_id: string;
  required: string | null;
  done: string | null;
  missing: string | null;
  rate_cents: string | null;
}

export interface WorkHourRuleTable {
  organization_id: string;
  from_year: number;
  required: string | null;
  rate_cents: string | null;
  age_from: number | null;
  age_to: number | null;
}

export interface ExpenseClaimTable {
  id: Generated<string>;
  organization_id: string;
  member_id: string;
  person_id: string;
  purpose: string;
  spent_on: string;
  amount_cents: number;
  account_holder: string;
  iban_encrypted: string;
  file_id: string;
  status: Generated<'submitted' | 'approved' | 'rejected'>;
  receipt_id: string | null;
  decided_by: string | null;
  decided_at: Date | null;
  reject_reason: string | null;
  created_at: Generated<Date>;
}

export type JobKind = 'full_export' | 'member_bulk';
export interface JobTable {
  id: Generated<string>;
  organization_id: string;
  kind: JobKind;
  status: Generated<'queued' | 'running' | 'done' | 'failed'>;
  progress: Generated<number>;
  detail: string | null;
  error: string | null;
  result_file_id: string | null;
  params: Generated<unknown>;
  result: unknown;
  attempts: Generated<number>;
  created_by: string | null;
  token_id: Generated<string | null>;
  created_at: Generated<Date>;
  claimed_at: Date | null;
  finished_at: Date | null;
}

export interface HouseholdTable {
  id: Generated<string>;
  organization_id: string;
  name: string;
  payer_person_id: string;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface HouseholdRuleTable {
  id: Generated<string>;
  household_id: string;
  valid_from: string;
  kind: 'none' | 'percent' | 'cap' | 'children_free';
  from_nth: number | null;
  percent_bp: number | null;
  cap_cents: number | null;
  created_at: Generated<Date>;
}

export interface ReceiptTable {
  id: Generated<string>;
  organization_id: string;
  supplier: string;
  number: string | null;
  receipt_date: string;
  due_date: string | null;
  status: Generated<'open' | 'paid' | 'void'>;
  total_cents: number;
  file_id: string | null;
  self_issued: Generated<boolean>;
  self_reason: string | null;
  paid_on: string | null;
  money_account_id: string | null;
  journal_entry_id: string | null;
  void_reason: string | null;
  note: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
  updated_at: Generated<Date>;
}

export interface ReceiptLineTable {
  id: Generated<string>;
  receipt_id: string;
  position: number;
  text: string | null;
  gross_cents: number;
  account_id: string;
  tax_rate_id: string | null;
  sphere: Sphere | null;
  cost_center_id: string | null;
}

export type CustomFieldType = 'text' | 'multiline' | 'number' | 'date' | 'checkbox' | 'select' | 'multiselect';
export interface CustomFieldTable {
  id: Generated<string>;
  organization_id: string;
  key: string;
  label: string;
  type: CustomFieldType;
  options: Generated<string[]>;
  required: Generated<boolean>;
  position: Generated<number>;
  visible_to_member: Generated<boolean>;
  editable_by_member: Generated<boolean>;
  needs_approval: Generated<boolean>;
  sensitive: Generated<boolean>;
  gdpr_relevant: Generated<boolean>;
  archived_at: Date | null;
  created_at: Generated<Date>;
}

export type ConsentPurpose = 'newsletter' | 'photos' | 'phone_list' | 'other';
export type ConsentSource = 'form' | 'portal' | 'paper' | 'admin';
export interface ConsentTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  purpose: ConsentPurpose;
  label: string | null;
  source: ConsentSource;
  text_version: string | null;
  granted_at: Generated<Date>;
  withdrawn_at: Date | null;
  withdrawn_source: ConsentSource | null;
  created_by: string | null;
}

export interface OidcIdentityTable {
  id: Generated<string>;
  organization_id: string;
  issuer: string;
  subject: string;
  user_id: string;
  created_at: Generated<Date>;
}

export interface OperatorEventTable {
  id: Generated<string>;
  at: Generated<Date>;
  action: 'tenant.exported' | 'tenant.purged';
  organization_id: string;
  hostname: string | null;
  detail: unknown;
}

export interface ErasureLogTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  at: Generated<Date>;
}

export interface DuplicateDismissalTable {
  organization_id: string;
  person_a: string;
  person_b: string;
  dismissed_by: string | null;
  dismissed_at: Generated<Date>;
}

export interface SavedViewTable {
  id: Generated<string>;
  organization_id: string;
  owner_id: string;
  name: string;
  params: string;
  shared_role_id: string | null;
  created_at: Generated<Date>;
}

export interface InvoiceEinvoiceTable {
  invoice_id: string;
  organization_id: string;
  format: 'xrechnung-cii';
  xml: Buffer;
  sha256: string;
  created_at: Generated<Date>;
}

export interface IdempotencyKeyTable {
  organization_id: string;
  actor: string;
  key: string;
  route: string;
  request_hash: string;
  grants_hash: string | null;
  status_code: number | null;
  response: string | null;
  content_type: string | null;
  created_at: Generated<Date>;
}

export interface DonationTable {
  id: Generated<string>;
  organization_id: string;
  person_id: string;
  donated_on: string;
  amount_cents: number;
  waiver: Generated<boolean>;
  note: string | null;
  journal_entry_id: string | null;
  kind: Generated<'money' | 'in_kind'>;
  in_kind_description: string | null;
  in_kind_source: 'business' | 'private' | 'unknown' | null;
  in_kind_valuation_docs: boolean | null;
  voided_at: Date | null;
  void_reason: string | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface DonationReceiptTable {
  id: Generated<string>;
  organization_id: string;
  number: string;
  kind: 'single' | 'collective';
  person_id: string;
  issued_on: string;
  total_cents: number;
  template: string;
  pdf: Buffer;
  sha256: string;
  status: Generated<'issued' | 'cancelled'>;
  cancel_reason: string | null;
  cancelled_at: Date | null;
  created_by: string | null;
  created_at: Generated<Date>;
}

export interface DonationReceiptItemTable {
  receipt_id: string;
  donation_id: string;
  live: Generated<boolean>;
}

export type AppUser = Selectable<AppUserTable>;

export function createDb(connectionString: string) {
  return new Kysely<Database>({
    dialect: new PostgresDialect({ pool: new pg.Pool({ connectionString, max: 10 }) }),
  });
}

export type Db = Kysely<Database>;

export interface PersonalTokenTable {
  id: Generated<string>;
  organization_id: string;
  kind: 'admin' | 'member';
  user_id: string | null;
  email: string | null;
  name: string;
  prefix: string;
  token_hash: string;
  access: 'read' | 'write';
  cap: Record<string, 'read' | 'write'> | null;
  audience: 'mcp' | null;
  oauth_client: string | null;
  expires_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  created_at: Generated<Date>;
}

export interface AgentCallTable {
  id: Generated<string>;
  token_id: string;
  at: Generated<Date>;
  operation: string;
  channel: 'rest' | 'mcp' | 'cli';
  status: number;
}
