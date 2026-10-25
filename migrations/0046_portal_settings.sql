-- Portal functions per club (missing key = on), overridable per group with 'allow' / 'deny'.
alter table organization add column portal_features jsonb not null default '{}';
alter table club_group add column portal_overrides jsonb not null default '{}';
