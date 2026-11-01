# Tidemark

Signal-based B2B prospecting for teams that sell to US manufacturers. Tidemark watches **dated public records** (loans, permits, contract awards, fleet registrations, trade press), matches each record to one company, reads each company's records as a timeline, and only calls something a **reason to buy** when several independent records agree. Example: a loan funds, a permit closes out on the new building, then machines clear customs, so the company is fitting out a new production floor.

Each prospect comes with the evidence, a contact window, the people to reach, and who on your team can introduce you. Prospects sync to HubSpot and Attio, and can be sent through Gmail or Instantly campaigns.

> Independent product. It implements the same category of workflow as tools like Clean (tryclean.ai). The design is based only on that product's public marketing pages, and Tidemark has its own name, schema, code and design.

## Stack

| Layer | Choice |
|---|---|
| App | Next.js 16 (App Router, server actions), Tailwind v4, shadcn/ui (Base UI) |
| Data, auth, files | Supabase: Postgres with row-level security, Auth (magic link and Google), Storage, pg_trgm, pgvector, pg_cron |
| AI | Provider-neutral layer (`src/lib/ai/llm.ts`). **OpenRouter** (default; free `nvidia/nemotron-3.5-super-vl:free`, JSON-schema outputs + tool calling) or **Claude** (`LLM_PROVIDER=anthropic`, `claude-opus-5-5`) |
| Jobs | A Postgres queue (`jobs`) drained by `/api/worker/tick` (pg_cron every minute) or `npm run worker` |

## How it works

```
public datasets ──► source_records ──► entity resolution ──► companies + aliases
                                              │
                                              ▼
                                         signals (dated, categorized)
                                              │   per workspace ICP
                                              ▼
 knowledge base ──► seller profile ──► account research ──► fit score + activity score (deterministic)
                                              │            ──► Claude reads the timeline → reason to buy,
                                              │                evidence notes, contact window (citations re-checked in code)
                                              ▼
                     qualified prospects ──► contacts (licensed provider) + verification ──► warm paths
                                              │
                         HubSpot / Attio sync · Gmail / Instantly campaigns · tasks · insights · chat
```

* **Signal categories:** Money moving (SBA 504/7(a) loans), Building (city permits), Equipment & supply (customs and supplier switches, which need a licensed provider), Contracts (USASpending), Operations (FMCSA new registrations and fleet growth). Trade press via RSS is extracted by Claude.
* **Scoring:** fit is scored first (industry by NAICS prefix, size, geography, keywords), then activity. Activity uses a 120-day half-life time decay, source reliability, entity-match confidence and event de-duplication. Fewer than *N* independent records (default 2) caps activity. Tiers: S ≥ 80, A ≥ 65, B ≥ 50, otherwise C. `npm run check` tests the scorer against the demo stories.
* **Entity resolution:** registry IDs first (UEI, USDOT), then domain, then exact normalized name, then trigram fuzzy match with location agreement. If nothing matches, a new company is created. Every spelling seen is stored as an alias.

## Setup

1. **Install:** `npm install`
2. **Environment:** copy `.env.example` to `.env.local` and fill in:
   * `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`. Get these from Supabase → Project Settings → API Keys.
   * `SUPABASE_SECRET_KEY`: the `sb_secret_…` key. It is server-only and bypasses RLS.
   * `SUPABASE_DB_PASSWORD`: used only by `npm run db:push`.
   * `OPENROUTER_API_KEY` (or `LLM_PROVIDER=anthropic` + `ANTHROPIC_API_KEY`). Free OpenRouter models allow 20 requests/min and 50/day (1,000/day after buying $10 of credits); jobs that hit the limit wait and retry automatically.
   * `TIDEMARK_ENCRYPTION_KEY` (`openssl rand -base64 32`) and `CRON_SECRET` (`openssl rand -hex 32`)
3. **Database:** `npm run db:push` applies `supabase/migrations/*` to the project ref pinned in `scripts/db-push.sh`, using only that project's password.
4. **Auth URLs:** in Supabase → Authentication → URL Configuration, set Site URL to your app URL and add `<app>/auth/callback` to the Redirect URLs. Enable Google under Providers if you want Google sign-in.
5. **Run:** `npm run dev` (app) and `npm run worker` (background jobs) in two terminals.
6. **Dev login (local only):** set `DEV_LOGIN_ENABLED=true` and `DEV_LOGIN_EMAIL` in `.env.local` to get a one-click "Dev login" button on /login with no email round trip. It never works in production builds.
7. **Try it:** sign up, finish onboarding, and leave "Add demo data" on. The demo set is 120 fictional manufacturers marked **Demo**, using reserved `.example` domains so nothing can be emailed. Real public-record connectors run on their schedule, or from Settings → Data sources → Run now.

### Production

Deploy the Next.js app (for example to Vercel). Connector runs and record matching work in time-boxed chunks that fit serverless limits; the SBA CSV download is large, so for big SBA backfills run `npm run ingest -- sba.foia_504` from a machine or a scheduled CI job. Then run `supabase/cron.sql` in the Supabase SQL editor, which calls `/api/worker/tick` every minute with your `CRON_SECRET`. Also set `NEXT_PUBLIC_APP_URL`, which is used for OAuth redirects and unsubscribe links.

## Data sources

| Connector | Source | Key | Notes |
|---|---|---|---|
| `usaspending.contracts` | USASpending.gov API | none | New federal contracts over $250K to NAICS 31–33 |
| `permits.chicago_building_permits` | City of Chicago (Socrata `ydr8-5enu`) | none | Industrial or manufacturing work with a business owner. Add cities in `src/lib/sources/permits.ts` |
| `fmcsa.carriers` | FMCSA Company Census (`az4n-8mr2`) | none | New private-property fleets plus weekly fleet-size snapshots that trigger `fleet_growth` |
| `sba.foia_504` / `sba.foia_7a` | SBA FOIA CSVs (data.sba.gov) | none | Finds the latest quarterly file on its own. Can be overridden with `SBA_*_CSV_URL` |
| `press.rss` | Your `PRESS_RSS_FEEDS` (default: Area Development project announcements) | — | The LLM extracts company-specific events; only headlines, one-line summaries and links are stored. Check each publication's reuse terms |
| `federal_register.ftz` | Federal Register API (Foreign-Trade Zones Board) | none | Production authorizations and subzone filings: named company, site and products |
| `ucc.ct` | Connecticut UCC lien filings (Socrata `xfev-8smz`) | none | New UCC-1s by equipment lenders against manufacturer-like debtors (public domain) |
| `warn.feed` | WARN Feed (CC BY 4.0) | none | Layoff notices as a **negative** signal; attaches only to companies already tracked |
| `epa.air_new_facilities` | EPA ECHO / ICIS-Air (public domain) | none | Manufacturing plants listed as **planned** or **under construction**. ECHO has no status date, so signals are dated when first observed |
| `osha.ita_300a` | OSHA ITA Form 300A (public domain) | none | Plant headcount, NAICS and EIN for tracked companies, plus year-over-year headcount growth. osha.gov blocks some non-US networks; run from US hosting or set `OSHA_300A_CSV_URL` |
| `seed.demo` | Generated | — | Fictional, clearly labelled |

Dry-run any connector without the database: `npm run try-connector -- usaspending.contracts 10 60`.

**Not included, on purpose.** Shipment-level customs and supplier-switch data have no free source; it needs a licensed bill-of-lading provider (ImportGenius, Panjiva or Descartes Datamyne). ImportYeti's terms forbid embedding it in a product. Austin and LA permit feeds have no owner field, and NYC's owner field is usually a property-holding LLC, so those need address matching before they are useful. **LinkedIn is not scraped.** Warm paths come from the team's own Gmail, Granola, CRM and LinkedIn connections export.

## Contact data and licensing

Most contact vendors (Apollo, ZoomInfo, RocketReach) license their data for internal use only. **People Data Labs** offers a product-use licence on its Enterprise tier and is the default (`PDL_API_KEY`). Hunter is supported for domain search. Apollo stays off unless `CONTACTS_ALLOW_APOLLO=true` (use it only with a written agreement). Emails are verified with ZeroBounce, falling back to Hunter, and invalid emails are dropped. Confirm every vendor's current terms before you ship.

## Integrations

| Provider | Auth | Env | Behaviour |
|---|---|---|---|
| HubSpot | OAuth | `HUBSPOT_CLIENT_ID/SECRET` | Pushes companies, contacts, lists and custom columns. Pulls back person edits. Never deletes |
| Attio | OAuth | `ATTIO_CLIENT_ID/SECRET` | Same rules as HubSpot |
| Gmail | Google OAuth, per member | `GOOGLE_CLIENT_ID/SECRET` | Read-only for prospect threads. Optional sending: weekdays, inside sending hours, at most 40/day per mailbox, unsubscribe link plus RFC 8058 headers, stops on reply, bounce or unsubscribe. Disconnecting deletes synced mail |
| Instantly | API key, admin only | — | Adds leads with `{{tidemark_subject}}` / `{{tidemark_body}}` and reads replies, bounces and unsubscribes via webhook |
| Granola | API key, per member | `GRANOLA_API_BASE` | Read-only, and only for meetings a prospect attended |

OAuth redirect URIs are `<NEXT_PUBLIC_APP_URL>/api/oauth/<provider>/callback`.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js |
| `npm run worker` | Drains the job queue continuously (`-- --once` for a single tick) |
| `npm run seed [-- --workspace <id>]` | Loads the demo dataset |
| `npm run ingest -- <connector> [limit] [sinceDays]` | Runs a connector against the DB now |
| `npm run try-connector -- <connector>` | Dry-runs a connector, with no DB |
| `npm run check` | Scoring sanity check |
| `npm run db:push` | Applies migrations to the pinned Tidemark project |
| `npm run doctor` | Checks env, DB, RLS, storage, queue and the LLM |
| `npm run typecheck` / `lint` | Static checks |

## Repository map

```
supabase/migrations/   schema, RLS, queue, RPCs (01–09)
src/lib/sources/       public-data connectors
src/lib/pipeline/      ingest, resolve, scoring, research (Claude), match, contacts, warm paths, insights
src/lib/knowledge/     extraction, chunking, embeddings, seller profile, ICP drafting
src/lib/integrations/  connections (encrypted secrets, OAuth), crm/, gmail/, outreach/
src/lib/worker/        job handlers + runner/scheduler
src/app/(app)/         home, prospects, buyer profile, tasks, insights, knowledge, chat, campaigns, settings
src/app/api/           chat (SSE), worker tick, OAuth, webhooks, unsubscribe
```
