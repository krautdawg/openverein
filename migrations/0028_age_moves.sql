-- Age-based group change: members of this group move to next_group at age next_group_age,
-- on their birthday or on 1 January of the year they reach it.
alter table club_group
  add column next_group_id uuid references club_group(id),
  add column next_group_age smallint check (next_group_age between 1 and 120),
  add column next_group_on text check (next_group_on in ('birthday', 'year_start')),
  add constraint club_group_age_move_complete check ((next_group_id is null) = (next_group_age is null) and (next_group_id is null) = (next_group_on is null)),
  add constraint club_group_age_move_not_self check (next_group_id <> id);
