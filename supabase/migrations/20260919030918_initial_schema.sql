-- =============================================================================
-- Initial schema for the poker home-game tracker.
--
-- Implements the data model in ARCHITECTURE.md: users, houses, memberships,
-- games, game_players, buy_ins - plus the house_leaderboards view and the two
-- integrity triggers a CHECK constraint could not express.
--
-- Invariants carried over from CLAUDE.md:
--   * All money is integer cents. Nothing here divides by 100.
--   * Net is NEVER stored. It is always final_stack_cents - sum(buy_ins), so
--     there is deliberately no `net_cents` or leaderboard-total column anywhere.
--   * Only status = 'settled' games count toward stats. Enforced at query time;
--     this migration keeps settled games immutable so they cannot drift.
--   * Access is governed by Row Level Security: you can only reach a house you
--     are a member of.
-- =============================================================================


-- -----------------------------------------------------------------------------
-- Types
-- -----------------------------------------------------------------------------

create type public.game_status as enum ('active', 'settled');


-- -----------------------------------------------------------------------------
-- Tables
-- -----------------------------------------------------------------------------

-- One row per person. Mirrors auth.users, which remains the source of truth for
-- credentials; this table holds only what the app needs to display someone.
create table public.users (
  id uuid primary key references auth.users (id) on delete cascade,
  email text not null,
  display_name text not null,
  created_at timestamptz not null default now(),

  constraint users_display_name_not_blank
    check (length(btrim(display_name)) > 0)
);

comment on table public.users is
  'App-level profile for an auth.users row. Credentials live in auth.users.';


-- A group of friends. The owner picks a unique name; the join code is generated
-- for them (see the default on join_code, added below once the generator exists).
create table public.houses (
  id uuid primary key default gen_random_uuid(),
  name text not null unique,
  join_code text not null unique,
  owner_id uuid not null references public.users (id) on delete restrict,
  created_at timestamptz not null default now(),

  constraint houses_name_not_blank
    check (length(btrim(name)) > 0)
);

comment on column public.houses.owner_id is
  'ON DELETE RESTRICT: a user who still owns a house cannot be deleted, so a '
  'house is never orphaned. Transfer or delete the house first.';


-- Join table: a user belongs to many houses, a house has many users.
create table public.memberships (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete cascade,
  created_at timestamptz not null default now(),

  unique (house_id, user_id)
);


-- One cash-game session belonging to a house.
create table public.games (
  id uuid primary key default gen_random_uuid(),
  house_id uuid not null references public.houses (id) on delete cascade,
  status public.game_status not null default 'active',
  created_at timestamptz not null default now()
);


-- One row per player per game. final_stack_cents stays NULL while the game is in
-- progress and is filled in once, at the end, when the player cashes out.
create table public.game_players (
  id uuid primary key default gen_random_uuid(),
  game_id uuid not null references public.games (id) on delete cascade,
  user_id uuid not null references public.users (id) on delete restrict,
  final_stack_cents integer,
  created_at timestamptz not null default now(),

  unique (game_id, user_id),

  constraint game_players_final_stack_non_negative
    check (final_stack_cents is null or final_stack_cents >= 0)
);

comment on column public.game_players.final_stack_cents is
  'Chips cashed out, in cents. NULL until the game is settled. The player''s net '
  'is always computed as this minus the sum of their buy_ins - never stored.';

comment on column public.game_players.user_id is
  'ON DELETE RESTRICT: removing a player would break the zero-sum property of '
  'every game they played, so past results pin the user row in place.';


-- One row per buy-in. The first buy-in and every rebuy are identical rows, so a
-- player can add money any number of times. No cap.
create table public.buy_ins (
  id uuid primary key default gen_random_uuid(),
  game_player_id uuid not null references public.game_players (id) on delete cascade,
  amount_cents integer not null,
  created_at timestamptz not null default now(),

  constraint buy_ins_amount_positive check (amount_cents > 0)
);


-- -----------------------------------------------------------------------------
-- Join codes
--
-- Created after public.houses so the uniqueness probe can reference the table.
-- SECURITY DEFINER so the probe sees every house, not just the caller's - without
-- it RLS would hide collisions and we would lean entirely on the unique index.
-- -----------------------------------------------------------------------------

create or replace function public.generate_join_code()
returns text
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  -- No I, L, O, 0 or 1: these codes get read aloud and typed by hand.
  alphabet constant text := 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
  code text;
begin
  loop
    code := '';
    for i in 1..6 loop
      code := code || substr(alphabet, 1 + floor(random() * length(alphabet))::int, 1);
    end loop;

    exit when not exists (
      select 1 from public.houses h where h.join_code = code
    );
  end loop;

  return code;
end;
$$;

alter table public.houses
  alter column join_code set default public.generate_join_code();


-- -----------------------------------------------------------------------------
-- Indexes
--
-- Postgres indexes primary keys and UNIQUE constraints automatically; these cover
-- the foreign keys and the sort orders the screens actually use.
-- -----------------------------------------------------------------------------

create index houses_owner_id_idx on public.houses (owner_id);

-- "Your houses": every house for the signed-in user.
create index memberships_user_id_idx on public.memberships (user_id);

-- House view: past games, most recent first.
create index games_house_id_created_at_idx on public.games (house_id, created_at desc);

create index game_players_game_id_idx on public.game_players (game_id);

-- Leaderboard: every game row for one player.
create index game_players_user_id_idx on public.game_players (user_id);

create index buy_ins_game_player_id_idx on public.buy_ins (game_player_id);


-- -----------------------------------------------------------------------------
-- A game may only be settled once every player has cashed out
--
-- ARCHITECTURE.md: "A game becomes settled once every player's final stack is
-- recorded." Until now that was a convention; this makes it a rule. It matters
-- because settling is the moment a game starts counting toward the leaderboard -
-- a missing final stack would make that player's net NULL and poison the sum.
--
-- SECURITY DEFINER so the count is authoritative: the check must see every player
-- on the game, not just the ones the caller's policies would return.
-- -----------------------------------------------------------------------------

create or replace function public.enforce_settled_games_complete()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  player_count int;
  missing_count int;
begin
  select
    count(*),
    count(*) filter (where gp.final_stack_cents is null)
  into player_count, missing_count
  from public.game_players gp
  where gp.game_id = new.id;

  if player_count = 0 then
    raise exception 'cannot settle game %: it has no players', new.id
      using errcode = '23514';
  end if;

  if missing_count > 0 then
    raise exception
      'cannot settle game %: % of % player(s) have no final stack recorded',
      new.id, missing_count, player_count
      using errcode = '23514';
  end if;

  return new;
end;
$$;

-- UPDATE only, and only on the active -> settled edge. Settling is the one
-- transition that needs guarding: a game is born 'active' (the INSERT policy
-- requires it), and RLS already freezes a game once it is settled.
create trigger games_settle_requires_final_stacks
  before update on public.games
  for each row
  when (new.status = 'settled' and old.status is distinct from 'settled')
  execute function public.enforce_settled_games_complete();


-- -----------------------------------------------------------------------------
-- A game's players must belong to the game's house
--
-- RLS stops a non-member writing to a game; it does not stop a member adding
-- somebody from outside the house as a player. This closes that gap.
--
-- Deliberately a trigger and not a composite foreign key to
-- memberships (house_id, user_id): an FK would follow the membership row, so a
-- player leaving the house would either drag their past results out with them or
-- be blocked from leaving at all. Membership is checked when the player is added
-- to the game and never re-checked afterwards, so history survives someone
-- leaving.
--
-- Likewise this fires only when game_id or user_id changes - recording a final
-- stack for someone who has since left the house still works.
-- -----------------------------------------------------------------------------

create or replace function public.enforce_game_player_is_house_member()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not exists (
    select 1
    from public.games g
    join public.memberships m
      on m.house_id = g.house_id
     and m.user_id = new.user_id
    where g.id = new.game_id
  ) then
    raise exception
      'game_players: user % is not a member of the house that owns game %',
      new.user_id, new.game_id
      using errcode = '23503';
  end if;

  return new;
end;
$$;

create trigger game_players_must_be_house_member
  before insert or update of game_id, user_id on public.game_players
  for each row
  execute function public.enforce_game_player_is_house_member();


-- -----------------------------------------------------------------------------
-- Leaderboard
--
-- ARCHITECTURE.md: "The leaderboard is that net summed across the house's settled
-- games, grouped by user." This view is that sentence and nothing more - it stores
-- no totals, so the numbers cannot drift out of sync with the rows beneath them.
--
-- `security_invoker = true` is load-bearing. A normal view runs with its OWNER's
-- rights, which would read straight through RLS and hand every caller the standings
-- of every house in the database. With the invoker flag the underlying policies on
-- games / game_players / buy_ins apply to whoever is querying, so a member sees
-- exactly the houses they belong to.
-- -----------------------------------------------------------------------------

create view public.house_leaderboards
with (security_invoker = true)
as
select
  g.house_id,
  gp.user_id,
  count(*)::int as games_played,
  -- Cast to bigint: sum() over bigint yields numeric, which PostgREST serialises
  -- as a string. bigint keeps this a plain number on the client.
  sum(gp.final_stack_cents - coalesce(bi.buy_in_cents, 0))::bigint as net_cents
from public.game_players gp
join public.games g on g.id = gp.game_id
-- Aggregate the buy-ins first. Joining buy_ins directly would repeat the
-- game_players row once per rebuy and multiply final_stack_cents along with it.
left join lateral (
  select sum(b.amount_cents) as buy_in_cents
  from public.buy_ins b
  where b.game_player_id = gp.id
) bi on true
where g.status = 'settled'
group by g.house_id, gp.user_id;

comment on view public.house_leaderboards is
  'All-time net per player per house, over settled games only. Derived on every '
  'read - never stored. Join public.users for display names.';


-- -----------------------------------------------------------------------------
-- Access helpers
--
-- Every one of these is SECURITY DEFINER on purpose. A policy on `memberships`
-- that queried `memberships` directly would re-enter its own policy and fail with
-- infinite recursion; running the lookup as the definer sidesteps RLS for that
-- one narrow question. `search_path = ''` with fully-qualified names stops the
-- definer rights from being redirected at a shadowed table.
--
-- These answer yes/no about the *caller* only, so they leak nothing a member
-- could not already read.
-- -----------------------------------------------------------------------------

create or replace function public.is_house_member(house uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships m
    where m.house_id = house
      and m.user_id = (select auth.uid())
  );
$$;


create or replace function public.is_house_owner(house uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.houses h
    where h.id = house
      and h.owner_id = (select auth.uid())
  );
$$;


-- Does the caller share at least one house with this person? Gates reading
-- someone's display name for a leaderboard row.
create or replace function public.shares_house_with(other_user uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.memberships mine
    join public.memberships theirs on theirs.house_id = mine.house_id
    where mine.user_id = (select auth.uid())
      and theirs.user_id = other_user
  );
$$;


-- Read access to a game: caller is a member of the house that owns it.
create or replace function public.is_game_house_member(game uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.games g
    join public.memberships m on m.house_id = g.house_id
    where g.id = game
      and m.user_id = (select auth.uid())
  );
$$;


-- Write access to a game: caller is a member AND the game is still active.
--
-- Settled games are frozen. "Editing or voiding a settled game" is an open
-- question in ARCHITECTURE.md, and until it is answered the safe default is that
-- results stop moving once the money has changed hands.
create or replace function public.is_game_editable(game uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.games g
    join public.memberships m on m.house_id = g.house_id
    where g.id = game
      and m.user_id = (select auth.uid())
      and g.status = 'active'
  );
$$;


create or replace function public.is_game_player_house_member(game_player uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_players gp
    join public.games g on g.id = gp.game_id
    join public.memberships m on m.house_id = g.house_id
    where gp.id = game_player
      and m.user_id = (select auth.uid())
  );
$$;


create or replace function public.is_game_player_editable(game_player uuid)
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (
    select 1
    from public.game_players gp
    join public.games g on g.id = gp.game_id
    join public.memberships m on m.house_id = g.house_id
    where gp.id = game_player
      and m.user_id = (select auth.uid())
      and g.status = 'active'
  );
$$;


-- -----------------------------------------------------------------------------
-- Row Level Security
--
-- Default deny: RLS is on for every table and each policy names `authenticated`,
-- so an anonymous caller matches nothing anywhere.
-- -----------------------------------------------------------------------------

alter table public.users        enable row level security;
alter table public.houses       enable row level security;
alter table public.memberships  enable row level security;
alter table public.games        enable row level security;
alter table public.game_players enable row level security;
alter table public.buy_ins      enable row level security;


-- users -----------------------------------------------------------------------
-- You can see yourself, and anyone you share a house with (their name has to
-- render on a leaderboard). Everyone else is invisible.

create policy "users are readable by housemates"
  on public.users for select to authenticated
  using (id = (select auth.uid()) or public.shares_house_with(id));

create policy "users can create their own profile"
  on public.users for insert to authenticated
  with check (id = (select auth.uid()));

create policy "users can update their own profile"
  on public.users for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- No delete policy: accounts are removed through auth.users, which cascades.


-- houses ----------------------------------------------------------------------
-- Members see their houses. The owner is included explicitly so that the
-- INSERT ... RETURNING that creates a house can read the row back, in the moment
-- before the owner's own membership row exists.

create policy "houses are readable by members"
  on public.houses for select to authenticated
  using (
    public.is_house_member(id)
    or owner_id = (select auth.uid())
  );

create policy "users can create a house they own"
  on public.houses for insert to authenticated
  with check (owner_id = (select auth.uid()));

create policy "owners can update their house"
  on public.houses for update to authenticated
  using (public.is_house_owner(id))
  with check (owner_id = (select auth.uid()));

create policy "owners can delete their house"
  on public.houses for delete to authenticated
  using (public.is_house_owner(id));


-- memberships -----------------------------------------------------------------
-- Members see the roster. Direct INSERT only covers the owner enrolling
-- themselves at creation time; everyone else arrives through public.join_house,
-- because finding a house by its code requires reading a house you cannot yet see.

create policy "memberships are readable by house members"
  on public.memberships for select to authenticated
  using (public.is_house_member(house_id));

create policy "owners can enrol themselves in their own house"
  on public.memberships for insert to authenticated
  with check (
    user_id = (select auth.uid())
    and public.is_house_owner(house_id)
  );

create policy "members can leave and owners can remove members"
  on public.memberships for delete to authenticated
  using (
    user_id = (select auth.uid())
    or public.is_house_owner(house_id)
  );


-- games -----------------------------------------------------------------------
-- Any member can record a game; no per-action permission flags. Settled games
-- become read-only.

create policy "games are readable by house members"
  on public.games for select to authenticated
  using (public.is_house_member(house_id));

create policy "members can start a game"
  on public.games for insert to authenticated
  with check (
    public.is_house_member(house_id)
    and status = 'active'
  );

create policy "members can update an active game"
  on public.games for update to authenticated
  using (
    public.is_house_member(house_id)
    and status = 'active'
  )
  with check (public.is_house_member(house_id));

create policy "members can delete an active game"
  on public.games for delete to authenticated
  using (
    public.is_house_member(house_id)
    and status = 'active'
  );


-- game_players ----------------------------------------------------------------

create policy "game players are readable by house members"
  on public.game_players for select to authenticated
  using (public.is_game_house_member(game_id));

create policy "members can add a player to an active game"
  on public.game_players for insert to authenticated
  with check (public.is_game_editable(game_id));

create policy "members can update a player in an active game"
  on public.game_players for update to authenticated
  using (public.is_game_editable(game_id))
  with check (public.is_game_editable(game_id));

create policy "members can remove a player from an active game"
  on public.game_players for delete to authenticated
  using (public.is_game_editable(game_id));


-- buy_ins ---------------------------------------------------------------------

create policy "buy-ins are readable by house members"
  on public.buy_ins for select to authenticated
  using (public.is_game_player_house_member(game_player_id));

create policy "members can add a buy-in to an active game"
  on public.buy_ins for insert to authenticated
  with check (public.is_game_player_editable(game_player_id));

create policy "members can update a buy-in in an active game"
  on public.buy_ins for update to authenticated
  using (public.is_game_player_editable(game_player_id))
  with check (public.is_game_player_editable(game_player_id));

create policy "members can delete a buy-in in an active game"
  on public.buy_ins for delete to authenticated
  using (public.is_game_player_editable(game_player_id));


-- -----------------------------------------------------------------------------
-- Grants
--
-- RLS filters rows; these decide who may attempt a statement at all. Supabase
-- grants new public tables to anon by default, so revoke that explicitly - this
-- app has no anonymous surface.
-- -----------------------------------------------------------------------------

revoke all on public.users        from anon;
revoke all on public.houses       from anon;
revoke all on public.memberships  from anon;
revoke all on public.games        from anon;
revoke all on public.game_players from anon;
revoke all on public.buy_ins      from anon;

grant select, insert, update, delete on public.users        to authenticated;
grant select, insert, update, delete on public.houses       to authenticated;
grant select, insert, update, delete on public.memberships  to authenticated;
grant select, insert, update, delete on public.games        to authenticated;
grant select, insert, update, delete on public.game_players to authenticated;
grant select, insert, update, delete on public.buy_ins      to authenticated;

revoke all on public.house_leaderboards from anon;
grant select on public.house_leaderboards to authenticated;


-- -----------------------------------------------------------------------------
-- Profile creation
--
-- public.users is not written by the client on the happy path; it is filled in
-- the moment Supabase Auth creates the account, so a Google or email sign-up
-- lands with a usable display name already set.
-- -----------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  insert into public.users (id, email, display_name)
  values (
    new.id,
    new.email,
    coalesce(
      nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
      nullif(btrim(new.raw_user_meta_data ->> 'name'), ''),
      split_part(new.email, '@', 1)
    )
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();


-- -----------------------------------------------------------------------------
-- Joining by code
--
-- RLS cannot express "you may read this house only if you can name its code" - a
-- SELECT policy permissive enough to find the house by code is also permissive
-- enough to list every house. So the join runs through one SECURITY DEFINER
-- function that takes the code, does the lookup itself, and returns only the
-- house it just enrolled you in.
-- -----------------------------------------------------------------------------

create or replace function public.join_house(code text)
returns public.houses
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  target public.houses;
begin
  if (select auth.uid()) is null then
    raise exception 'join_house: you must be signed in'
      using errcode = '42501';
  end if;

  select h.* into target
  from public.houses h
  where h.join_code = upper(btrim(code));

  if not found then
    raise exception 'join_house: no house with that join code'
      using errcode = '22023';
  end if;

  insert into public.memberships (house_id, user_id)
  values (target.id, (select auth.uid()))
  on conflict (house_id, user_id) do nothing;

  return target;
end;
$$;


-- Helpers are called from policies, which run as the caller; the join RPC is
-- called directly. Neither should be reachable without a session.
revoke all on function public.generate_join_code() from public, anon;
revoke all on function public.join_house(text) from public, anon;

grant execute on function public.generate_join_code() to authenticated;
grant execute on function public.join_house(text) to authenticated;
grant execute on function public.is_house_member(uuid) to authenticated;
grant execute on function public.is_house_owner(uuid) to authenticated;
grant execute on function public.shares_house_with(uuid) to authenticated;
grant execute on function public.is_game_house_member(uuid) to authenticated;
grant execute on function public.is_game_editable(uuid) to authenticated;
grant execute on function public.is_game_player_house_member(uuid) to authenticated;
grant execute on function public.is_game_player_editable(uuid) to authenticated;
