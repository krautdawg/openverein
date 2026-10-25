-- Managed hosting (roadmap P2.11): several clubs on one installation, each reached under its own host name.
alter table organization add column hostname text check (hostname ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$');
create unique index organization_hostname_key on organization (hostname) where hostname is not null;
