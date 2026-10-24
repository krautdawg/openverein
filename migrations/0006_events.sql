-- Slice 4: calendars, events (single and recurring), participations with RSVP, waitlist and attendance.
-- Event times are wall-clock times in the club's time zone (timestamp without time zone).

create table calendar (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  name text not null check (length(name) between 1 and 80),
  color text not null default 'blau',
  -- null = visible to every member; otherwise only to members of these groups
  group_ids uuid[],
  feed_token_hash text unique,
  created_at timestamptz not null default now()
);

create table event (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  calendar_id uuid not null references calendar(id),
  title text not null check (length(title) between 1 and 200),
  description text,
  location text,
  starts_at timestamp not null,
  ends_at timestamp not null,
  all_day boolean not null default false,
  rrule text,
  exdates date[] not null default '{}',
  max_participants int check (max_participants > 0),
  rsvp boolean not null default true,
  registration_closes_hours int check (registration_closes_hours between 0 and 720),
  price_cents bigint check (price_cents >= 0),
  created_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (ends_at >= starts_at)
);
create index event_calendar_idx on event (calendar_id, starts_at);

create table participation (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  event_id uuid not null references event(id) on delete cascade,
  occurrence_date date not null,
  member_id uuid not null references member(id),
  status text not null check (status in ('yes', 'maybe', 'no', 'waitlist', 'attended', 'not_attended')),
  waitlisted_at timestamptz,
  invoice_id uuid references invoice(id),
  updated_by uuid references app_user(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (event_id, occurrence_date, member_id)
);
create index participation_occurrence_idx on participation (event_id, occurrence_date);
