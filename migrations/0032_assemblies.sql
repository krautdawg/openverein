-- General assemblies (Mitgliederversammlung): invitation with agenda and notice period, attendance, votes, minutes.
create table assembly (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  title text not null check (length(title) between 1 and 200),
  held_on date not null,
  starts_at text not null check (starts_at ~ '^[0-2][0-9]:[0-5][0-9]$'),
  place text not null check (length(place) between 1 and 300),
  -- Statutory notice in days (Satzung), checked when inviting.
  notice_days smallint not null default 14 check (notice_days between 0 and 120),
  chair text check (length(chair) <= 120),
  minutes_by text check (length(minutes_by) <= 120),
  invited_at timestamptz,
  message_id uuid references message(id),
  closed_at timestamptz,
  created_at timestamptz not null default now()
);
create index assembly_org_idx on assembly (organization_id, held_on desc);

create table assembly_item (
  id uuid primary key default uuidv7(),
  assembly_id uuid not null references assembly(id) on delete cascade,
  position smallint not null,
  title text not null check (length(title) between 1 and 200),
  description text check (length(description) <= 2000),
  is_vote boolean not null default false,
  votes_yes int check (votes_yes >= 0),
  votes_no int check (votes_no >= 0),
  votes_abstain int check (votes_abstain >= 0),
  outcome text check (length(outcome) <= 2000),
  unique (assembly_id, position)
);

create table assembly_attendance (
  assembly_id uuid not null references assembly(id) on delete cascade,
  member_id uuid not null references member(id),
  primary key (assembly_id, member_id)
);

-- A closed assembly is the record of what was decided: no more changes.
create function assembly_closed_guard() returns trigger language plpgsql as $$
declare closed timestamptz;
begin
  select a.closed_at into closed from assembly a where a.id = coalesce(new.assembly_id, old.assembly_id);
  if closed is not null then raise exception 'assembly is closed' using errcode = 'check_violation', constraint = 'assembly_closed'; end if;
  return coalesce(new, old);
end $$;
create trigger assembly_item_closed before insert or update or delete on assembly_item for each row execute function assembly_closed_guard();
create trigger assembly_attendance_closed before insert or update or delete on assembly_attendance for each row execute function assembly_closed_guard();
