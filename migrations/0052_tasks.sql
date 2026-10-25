-- Tasks for the board and volunteers (spec P25): assignee, due date, optional member; open to every user of the club.
create table task (
  id uuid primary key default uuidv7(),
  organization_id uuid not null references organization(id),
  title text not null check (char_length(title) between 1 and 200),
  note text check (char_length(note) <= 2000),
  due_on date,
  assignee_user_id uuid references app_user(id),
  member_id uuid references member(id),
  done_at timestamptz,
  done_by uuid references app_user(id),
  created_by uuid not null references app_user(id),
  created_at timestamptz not null default now()
);
create index task_open_idx on task (organization_id, due_on) where done_at is null;
