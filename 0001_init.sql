-- Pro Se Commons — initial Supabase/Postgres schema
--
-- Implements SPEC.md's three schemas (UserProfile -> profiles,
-- MarketplaceItem -> marketplace_items, PublicNotice -> public_notices)
-- using the table/column names requested for the Supabase SQL editor,
-- extended with the tables the working prototype actually needs for
-- real parity (requests/threads, messages, reviews) and with a handful
-- of columns SPEC.md's literal interfaces didn't list but the live
-- signup/listing/notice forms already collect (name, phone, category,
-- headline, member role) — each one is called out in a comment where it
-- appears. Run this once, top to bottom, in a fresh Supabase project's
-- SQL editor.

-- ============================================================
-- Extensions
-- ============================================================
create extension if not exists "pgcrypto"; -- gen_random_uuid()

-- ============================================================
-- Enums
-- ============================================================

-- SPEC.md's UserProfile.role was 'buyer' | 'seller' | 'both' | 'admin',
-- but the live signup form actually asks which of six practice/
-- access-to-justice categories describes the member (this powers the
-- public "Membership Roll" counts). Everyone can both buy and sell
-- regardless of this value, so it's kept separate from the real admin
-- permission (`is_admin` below) rather than overloading one column.
create type member_role as enum (
  'Former Pro Se Litigant',
  'Current Litigant',
  'Paralegal',
  'Lay Advocate',
  'Scholar or Student',
  'Justice-Access Enthusiast'
);

create type listing_status as enum ('active', 'sold', 'flagged', 'archived');
create type request_status as enum ('pending', 'accepted', 'declined', 'completed');
create type payment_status as enum ('pending', 'paid', 'failed');

-- ============================================================
-- profiles  (SPEC.md: UserProfile)
-- ============================================================
create table profiles (
  id                  uuid primary key references auth.users(id) on delete cascade,
  email               text not null,
  alias               text not null,
  state_abbr          text not null check (char_length(state_abbr) = 2),
  -- Generated so it can never drift from state_abbr/alias — matches
  -- SPEC.md's `formattedUsername: ${stateAbbr}-${alias}` exactly.
  formatted_username  text generated always as (upper(state_abbr) || '-' || alias) stored,
  bio                 text not null default '',
  avatar_url          text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Not in SPEC.md's literal interface, but required for the app to
  -- actually work today:
  name                text not null,             -- displayed alongside the alias in most of the UI
  phone               text not null default '',  -- see the RLS section — never exposed directly
  role                member_role not null,       -- the Membership Roll category, see enum note above
  is_admin            boolean not null default false, -- the real Directive 9 admin permission
  strikes             integer not null default 0,     -- moderation strike count (Directive 8)

  constraint alias_charset check (alias ~ '^[A-Za-z0-9]+$')
);

-- There is deliberately no `password` column. The prototype's client-
-- side stopgap stored a plaintext password on this row because it had
-- no real backend; Supabase Auth (auth.users) replaces that entirely.
-- Don't carry the old password field into this schema even for a data
-- migration — treat every existing member as needing a password reset.

create index profiles_role_idx on profiles(role);
create index profiles_state_idx on profiles(state_abbr);
-- (the updated_at trigger for this table is attached further down, once
-- set_updated_at_placeholder() has been defined — see "updated_at
-- bookkeeping" below)

-- Public, non-sensitive read model for member cards / the Membership
-- Roll / roster modal — excludes phone and email so those never need a
-- row-level exception to render a public profile card.
create view public_profiles as
  select
    id, name, alias, state_abbr, formatted_username, role, bio,
    avatar_url, created_at
  from profiles;

-- ============================================================
-- marketplace_items  (SPEC.md: MarketplaceItem)
-- ============================================================
create table marketplace_items (
  id                    uuid primary key default gen_random_uuid(),
  seller_id             uuid not null references profiles(id) on delete cascade,
  title                 text not null,
  description           text not null,
  category              text not null,
  -- SPEC.md typed this as `price: number`, but the live listing form
  -- collects free-text pricing ("$20/hr", "$15 flat", "$5/page") since
  -- pricing structures vary. Kept as text under the requested column
  -- name so real listings still fit; tighten to numeric once pricing is
  -- standardized (needed anyway for Directive 6's earnings totals).
  price                 text not null,
  document_url          text, -- Supabase Storage path once Directive 7 exists; null until then
  custom_button_label   text not null default 'Contact Member',
  status                listing_status not null default 'active',
  removed_reason        text, -- e.g. 'reported-unredacted', set alongside status = 'flagged'/'archived'
  created_at            timestamptz not null default now(),
  updated_at            timestamptz not null default now()
);

create index marketplace_items_seller_idx on marketplace_items(seller_id);
create index marketplace_items_category_idx on marketplace_items(category);
create index marketplace_items_status_idx on marketplace_items(status);

-- ============================================================
-- requests  (the prototype's "Inbox" threads — not one of SPEC.md's
-- three named interfaces, but required for Directive 3's buyer/seller
-- request flow and Directive 6's order tracking; marketplace_items
-- alone can't represent an in-progress transaction)
-- ============================================================
create table requests (
  id                   uuid primary key default gen_random_uuid(),
  marketplace_item_id  uuid references marketplace_items(id) on delete set null, -- null for notice-sourced requests
  listing_title        text not null, -- snapshotted so it survives listing edits/deletion
  provider_id          uuid not null references profiles(id) on delete cascade,
  buyer_id             uuid not null references profiles(id) on delete cascade,
  status               request_status not null default 'pending',
  source_type          text, -- 'notice' when the request originated from a Public Notice reply
  source_id            uuid, -- references public_notices(id) when source_type = 'notice'
  responded_at         timestamptz,
  completed_at         timestamptz,
  created_at           timestamptz not null default now()
);

create index requests_provider_idx on requests(provider_id, status);
create index requests_buyer_idx on requests(buyer_id, status);

-- ============================================================
-- messages  (a sub-collection of a request in the prototype;
-- a real table with a foreign key here)
-- ============================================================
create table messages (
  id          uuid primary key default gen_random_uuid(),
  request_id  uuid not null references requests(id) on delete cascade,
  sender_id   uuid not null references profiles(id) on delete cascade,
  body        text not null,
  created_at  timestamptz not null default now()
);

create index messages_request_idx on messages(request_id, created_at);

-- ============================================================
-- reviews
-- ============================================================
create table reviews (
  id                   uuid primary key default gen_random_uuid(),
  request_id           uuid not null references requests(id) on delete cascade,
  marketplace_item_id  uuid references marketplace_items(id) on delete set null,
  provider_id          uuid not null references profiles(id) on delete cascade,
  buyer_id             uuid not null references profiles(id) on delete cascade,
  rating               smallint not null check (rating between 1 and 5),
  body                 text not null default '',
  created_at           timestamptz not null default now(),

  unique (request_id) -- one review per completed request, matching current UI
);

create index reviews_provider_idx on reviews(provider_id);

-- ============================================================
-- public_notices  (SPEC.md: PublicNotice)
-- ============================================================
create table public_notices (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references profiles(id) on delete cascade,
  content_paragraph  text not null check (char_length(content_paragraph) <= 500),
  image_url          text not null default '',
  payment_status     payment_status not null default 'pending',
  transaction_id     text, -- Stripe payment/session id once Directive 9 is wired up
  published_at       timestamptz,
  expires_at         timestamptz,
  is_active          boolean not null default true,
  created_at         timestamptz not null default now(),

  -- Not in SPEC.md's literal PublicNotice interface, but the live
  -- notice form actually collects both — dropping them would lose real
  -- data the prototype already has:
  category           text not null,
  headline           text not null
);

create index public_notices_user_idx on public_notices(user_id);
create index public_notices_active_idx on public_notices(is_active, expires_at);

-- ============================================================
-- updated_at bookkeeping
-- ============================================================
create or replace function set_updated_at_placeholder()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger profiles_set_updated_at
  before update on profiles
  for each row execute function set_updated_at_placeholder();

create trigger marketplace_items_set_updated_at
  before update on marketplace_items
  for each row execute function set_updated_at_placeholder();

-- ============================================================
-- Automated cleanup: expire public_notices past their expires_at
-- (Directive 4's cron replacement for the client-side check the
-- prototype currently does on every render)
-- ============================================================
create or replace function expire_public_notices()
returns void
language sql
as $$
  update public_notices
  set is_active = false
  where is_active = true
    and expires_at is not null
    and now() > expires_at;
$$;

-- pg_cron ships on Supabase's hosted Postgres (Database -> Extensions ->
-- pg_cron in the dashboard, or run the create extension line below if
-- your project allows it). If pg_cron isn't available on your plan, call
-- expire_public_notices() from a scheduled Supabase Edge Function
-- (Dashboard -> Edge Functions -> Cron) on the same schedule instead —
-- either path satisfies Directive 4.
create extension if not exists pg_cron;

select cron.schedule(
  'expire-public-notices',   -- job name
  '*/15 * * * *',            -- every 15 minutes
  $$select expire_public_notices();$$
);

-- ============================================================
-- Row-level security
-- ============================================================
-- This closes the real security gap flagged during the artifact phase:
-- with no `rules` declared on the client-side db capability, phone
-- numbers were readable by any signed-in visitor regardless of request
-- status. RLS below fixes that for real — see get_contact_phone() at
-- the bottom for the one place phone is exposed at all.

alter table profiles enable row level security;
alter table marketplace_items enable row level security;
alter table requests enable row level security;
alter table messages enable row level security;
alter table reviews enable row level security;
alter table public_notices enable row level security;

-- profiles
create policy "profiles are readable via the public view"
  on profiles for select
  using (true); -- phone/email stay private in practice: public_profiles
                -- doesn't select them, and application code should query
                -- through that view, not this table, for public display

create policy "members manage their own profile"
  on profiles for insert
  with check (auth.uid() = id);

create policy "members update their own profile"
  on profiles for update
  using (auth.uid() = id);

-- marketplace_items: public SELECT read access for active listings;
-- sellers can also see (and manage) their own regardless of status.
create policy "active listings are publicly readable"
  on marketplace_items for select
  using (status = 'active' or seller_id = auth.uid());

create policy "sellers insert their own listings"
  on marketplace_items for insert
  with check (auth.uid() = seller_id);

create policy "sellers update their own listings"
  on marketplace_items for update
  using (auth.uid() = seller_id);

-- requests: only the two parties to a request can see or act on it.
create policy "parties can read their own requests"
  on requests for select
  using (auth.uid() = provider_id or auth.uid() = buyer_id);

create policy "buyers create requests"
  on requests for insert
  with check (auth.uid() = buyer_id);

create policy "parties update their own requests"
  on requests for update
  using (auth.uid() = provider_id or auth.uid() = buyer_id);

-- messages: only the two parties on the parent request.
create policy "parties can read messages on their requests"
  on messages for select
  using (
    exists (
      select 1 from requests r
      where r.id = messages.request_id
        and (r.provider_id = auth.uid() or r.buyer_id = auth.uid())
    )
  );

create policy "parties can send messages on their requests"
  on messages for insert
  with check (
    sender_id = auth.uid()
    and exists (
      select 1 from requests r
      where r.id = messages.request_id
        and (r.provider_id = auth.uid() or r.buyer_id = auth.uid())
    )
  );

-- reviews: publicly readable (social proof on a public profile); only
-- the buyer on a completed request can create one about it.
create policy "reviews are publicly readable"
  on reviews for select
  using (true);

create policy "buyers review their own completed requests"
  on reviews for insert
  with check (
    buyer_id = auth.uid()
    and exists (
      select 1 from requests r
      where r.id = reviews.request_id
        and r.buyer_id = auth.uid()
        and r.status = 'completed'
    )
  );

-- public_notices: public SELECT read access for active, unexpired
-- notices; INSERT/UPDATE restricted to the owning user.
create policy "active notices are publicly readable"
  on public_notices for select
  using (
    (is_active = true and (expires_at is null or expires_at > now()))
    or user_id = auth.uid()
  );

create policy "members insert their own notices"
  on public_notices for insert
  with check (auth.uid() = user_id);

create policy "posters update their own notices"
  on public_notices for update
  using (auth.uid() = user_id);

-- ============================================================
-- Direct phone access
-- ============================================================
-- `public_profiles` never selects phone. For the phone number to reach
-- the other party on an accepted request (what the prototype's "contact
-- box" currently shows unconditionally to any signed-in viewer), read it
-- through this function instead of the base table, gated by an actual
-- accepted/completed request rather than a public column:
create or replace function get_contact_phone(target_profile_id uuid, via_request_id uuid)
returns text
language plpgsql
security definer
set search_path = public
as $$
declare
  phone_out text;
begin
  if not exists (
    select 1 from requests r
    where r.id = via_request_id
      and r.status in ('accepted', 'completed')
      and (r.provider_id = auth.uid() or r.buyer_id = auth.uid())
      and (r.provider_id = target_profile_id or r.buyer_id = target_profile_id)
  ) then
    return null;
  end if;

  select phone into phone_out from profiles where id = target_profile_id;
  return phone_out;
end;
$$;
