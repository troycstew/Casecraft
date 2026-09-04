-- Pro Se Commons — Stripe integration support (Directive 9)
--
-- Adds what the checkout/webhook routes in web/ need that 0001_init.sql
-- didn't yet have: a real numeric amount to charge for a marketplace
-- item, and a table recording completed purchases so a buyer's paid
-- document access can be checked later. Run this after 0001_init.sql.

-- marketplace_items.price is free text ("$20/hr", "$15 flat") for
-- display, which Stripe can't charge directly — Checkout needs an
-- integer amount in cents. Add a real numeric column for that; keep
-- `price` as-is for display so existing listings don't need to change
-- their label format.
alter table marketplace_items
  add column price_cents integer check (price_cents is null or price_cents > 0);

comment on column marketplace_items.price_cents is
  'Amount to charge via Stripe Checkout, in cents. Null means this listing is not yet payable through Checkout (e.g. an hourly-rate service settled off-platform) — the checkout route rejects a purchase attempt on such a listing rather than guessing an amount from the free-text `price` label.';

-- One row per completed marketplace purchase. This is what "grants the
-- buyer secure access to download the seller's original file" once
-- Directive 7's real file storage exists — for now it's the source of
-- truth for "has this buyer paid for this item," which the download
-- endpoint (once built) checks before returning a signed URL.
create table purchases (
  id                   uuid primary key default gen_random_uuid(),
  marketplace_item_id  uuid not null references marketplace_items(id) on delete restrict,
  buyer_id             uuid not null references profiles(id) on delete cascade,
  seller_id            uuid not null references profiles(id) on delete cascade,
  stripe_session_id    text not null unique, -- also doubles as an idempotency key for the webhook
  stripe_payment_intent_id text,
  amount_cents         integer not null,
  created_at           timestamptz not null default now()
);

create index purchases_buyer_idx on purchases(buyer_id);
create index purchases_item_idx on purchases(marketplace_item_id);

alter table purchases enable row level security;

-- Only the buyer or the seller on a purchase can see it. Purchases are
-- only ever written by the webhook handler using the service-role key
-- (which bypasses RLS entirely), so there's deliberately no INSERT
-- policy here for regular authenticated users — the client can never
-- grant itself purchase access directly.
create policy "buyer and seller can read their own purchase records"
  on purchases for select
  using (auth.uid() = buyer_id or auth.uid() = seller_id);
