-- Pro Se Commons — request expiry, review window, disclaimers, term
-- flagging
--
-- Closes the gaps between 0001_init.sql/0002_purchases_and_stripe.sql
-- and the full marketplace spec: a 72-hour auto-expire on pending
-- requests (public_notices already had its own 7-day version of this),
-- a 48-hour cutoff on the buyer review window, a disclaimer-acceptance
-- record on listings and requests (backing the UPL checkbox at listing
-- creation and request-sending), and a check constraint blocking listing
-- titles that claim to offer legal advice/representation/court
-- appearances. Run this after 0001_init.sql and 0002_purchases_and_stripe.sql.
--
-- Chromebook/Supabase SQL editor note: paste this in the four chunks
-- marked below rather than all at once — long single pastes have gotten
-- silently truncated on this setup before.

-- ============================================================
-- CHUNK 1 — new request status
-- ============================================================
alter type request_status add value if not exists 'expired';

-- ============================================================
-- CHUNK 2 pre-check (run this first, not part of the migration) —
-- ADD CONSTRAINT validates every existing row immediately, so any
-- listing already titled e.g. "Court Appearance Prep" will make chunk 2
-- fail outright. Confirm this returns zero rows before running chunk 2;
-- if it doesn't, rename/archive those listings first.
--
--   select id, title from marketplace_items
--   where title ~* '(legal advice|representation|court appearance)';
-- ============================================================
-- CHUNK 2 — disclaimer acceptance + prohibited-term flagging on listings
-- ============================================================
alter table marketplace_items
  add column disclaimer_accepted_at timestamptz;

update marketplace_items
  set disclaimer_accepted_at = created_at
  where disclaimer_accepted_at is null;

alter table marketplace_items
  alter column disclaimer_accepted_at set not null,
  add constraint marketplace_items_prohibited_terms
    check (title !~* '(legal advice|representation|court appearance)');

comment on column marketplace_items.disclaimer_accepted_at is
  'When the seller confirmed the UPL micro-disclaimer checkbox at listing creation. Backfilled to created_at for listings that predate this requirement.';

-- ============================================================
-- CHUNK 3 — disclaimer acceptance on requests, 72-hour auto-expiry
-- ============================================================
alter table requests
  add column disclaimer_accepted_at timestamptz;

update requests
  set disclaimer_accepted_at = created_at
  where disclaimer_accepted_at is null;

alter table requests
  alter column disclaimer_accepted_at set not null;

comment on column requests.disclaimer_accepted_at is
  'When the buyer confirmed the UPL micro-disclaimer checkbox while sending this request. Backfilled to created_at for requests that predate this requirement.';

create or replace function expire_pending_requests()
returns void
language sql
as $$
  update requests
  set status = 'expired'
  where status = 'pending'
    and created_at < now() - interval '72 hours';
$$;

select cron.schedule(
  'expire-pending-requests',
  '*/15 * * * *',
  $$select expire_pending_requests();$$
);

-- ============================================================
-- CHUNK 4 — 48-hour review window
--
-- This policy only works once something actually sets completed_at.
-- requests.completed_at already exists as a column, but nothing writes
-- to it yet — that happens in the (not-yet-built) "provider marks
-- complete" API endpoint. Whatever that endpoint turns out to be, the
-- update that flips status to 'completed' must set
-- completed_at = now() in the same write, or every review attempt will
-- silently fail this policy with no completed_at to measure the
-- 48-hour window from.
-- ============================================================
alter policy "buyers review their own completed requests"
  on reviews
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from requests r
      where r.id = reviews.request_id
        and r.buyer_id = auth.uid()
        and r.status = 'completed'
        and r.completed_at is not null
        and now() <= r.completed_at + interval '48 hours'
    )
  );
