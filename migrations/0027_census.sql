-- Gender for the sports federations' annual census (LSB/DOSB Bestandserhebung): optional, three values as in the census forms.
alter table person add column gender text check (gender in ('female', 'male', 'diverse'));
