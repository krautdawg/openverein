-- Board meetings use the same record as general assemblies, invited to one group (the board) instead of all members.
alter table assembly
  add column kind text not null default 'general' check (kind in ('general', 'board')),
  add column group_id uuid references club_group(id),
  add constraint assembly_board_group check ((kind = 'board') = (group_id is not null));
