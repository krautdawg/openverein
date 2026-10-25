-- Greeting mails on birthdays and membership anniversaries (opt-in per club) and a register of awarded honours (spec P10).
alter table organization add column birthday_greetings text not null default 'off' check (birthday_greetings in ('off', 'round', 'all'));
alter table organization add column anniversary_greetings boolean not null default false;

-- Each greeting at most once per person, kind and year (also across restarts and several instances).
create table greeting_sent (
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  kind text not null check (kind in ('birthday', 'anniversary')),
  year int not null,
  sent_at timestamptz not null default now(),
  primary key (person_id, kind, year)
);

create table honour (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  member_id uuid not null references member(id),
  title text not null check (char_length(title) between 1 and 200),
  awarded_on date not null,
  decision text check (char_length(decision) <= 500),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now()
);
create index honour_member_idx on honour (member_id);

alter table mail_template drop constraint mail_template_key_check;
alter table mail_template add constraint mail_template_key_check check (key in ('invoice', 'dunning', 'invitation', 'login_code', 'change_decided', 'resignation_received', 'application_received', 'application_accepted', 'application_rejected', 'expense_decided', 'donation_receipt', 'birthday', 'anniversary'));
