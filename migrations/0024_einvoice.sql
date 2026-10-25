-- Outgoing e-invoices (XRechnung, CII syntax) for recipients that ask for them.
alter table organization
  add column vat_id text check (vat_id ~ '^[A-Z]{2}[A-Za-z0-9]{2,13}$'),
  add column tax_number text check (length(tax_number) between 5 and 30),
  add column small_business boolean not null default false,
  -- Vereinsregister (e.g. "VR 1234, Amtsgericht Musterstadt"): identifies the seller in e-invoices (BT-30)
  add column register_number text check (length(register_number) <= 100),
  add column einvoice_contact_name text check (length(einvoice_contact_name) <= 100),
  add column einvoice_contact_phone text check (length(einvoice_contact_phone) <= 40);

alter table person
  add column einvoice_format text not null default 'none' check (einvoice_format in ('none', 'xrechnung')),
  -- Leitweg-ID for public buyers, otherwise the buyer's own reference (BT-10)
  add column buyer_reference text check (length(buyer_reference) <= 100),
  -- the buyer's e-invoice address (BT-49), usually an e-mail address
  add column einvoice_address text check (length(einvoice_address) <= 200),
  add column vat_id text check (vat_id ~ '^[A-Z]{2}[A-Za-z0-9]{2,13}$');

-- Created once at issue, never changed (like the PDF).
create table invoice_einvoice (
  invoice_id uuid primary key references invoice(id),
  organization_id uuid not null references organization(id),
  format text not null check (format in ('xrechnung-cii')),
  xml bytea not null,
  sha256 text not null,
  created_at timestamptz not null default now()
);
create trigger invoice_einvoice_append_only before update or delete on invoice_einvoice for each row execute function ov_reject_change();
