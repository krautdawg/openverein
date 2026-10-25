-- Contact log per person (spec P06): calls, meetings, letters with the board's notes; private entries only for their author.
create table contact_log (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  person_id uuid not null references person(id),
  kind text not null check (kind in ('call', 'meeting', 'letter', 'email', 'other')),
  occurred_on date not null,
  text text not null check (char_length(text) between 1 and 4000),
  file_id uuid references file(id),
  private boolean not null default false,
  created_by uuid not null references app_user(id),
  created_at timestamptz not null default now()
);
create index contact_log_person_idx on contact_log (person_id, occurred_on desc);
