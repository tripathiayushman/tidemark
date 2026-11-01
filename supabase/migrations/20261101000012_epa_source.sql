-- Tidemark schema · part 12: EPA as a record source (ECHO / ICIS-Air facility status)
alter type public.record_source add value if not exists 'epa';
