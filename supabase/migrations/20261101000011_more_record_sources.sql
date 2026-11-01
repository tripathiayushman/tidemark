-- Tidemark schema · part 11: record sources for the second connector wave
--   federal_register — Foreign-Trade Zones Board notices (production activity, subzones)
--   ucc              — UCC-1 financing statements (Connecticut SOTS open data)
--   warn             — WARN Act layoff notices (WARN Feed, CC BY 4.0) — negative signal
alter type public.record_source add value if not exists 'federal_register';
alter type public.record_source add value if not exists 'ucc';
alter type public.record_source add value if not exists 'warn';
