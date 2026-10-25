-- Per-installation facts. data_key_check proves at start-up that DATA_KEY is the key this database was written with.
create table instance_setting (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
