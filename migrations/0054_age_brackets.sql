-- Age-based fees within one plan (spec P08, age brackets): [{ "upToAge": 17, "amountCents": 6000 }, ...], ascending;
-- the member's age at the start of each period picks the amount, otherwise the version's amount applies.
alter table fee_plan_version add column age_brackets jsonb not null default '[]';
