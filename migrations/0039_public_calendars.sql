-- Public calendars for the club website: a read-only widget that sites listed in public_origins may embed.
alter table calendar
  add column public boolean not null default false,
  add column public_origins text[] not null default '{}';
