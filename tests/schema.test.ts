/**
 * Schema tests: the migrations applied to a real Postgres, then poked at as three
 * different signed-in users.
 *
 * These cover the parts of the data model that live in SQL rather than TypeScript -
 * the RLS policies, the settle guard, the house-membership guard, and the
 * leaderboard's arithmetic. `src/lib/settlement.test.ts` covers the pure logic.
 *
 * One database is shared by the whole file and the blocks below run in order: alice
 * makes a house, bob joins it, they play a game and settle it. Each `describe`
 * builds on the state the previous one left behind.
 */
import { createSchemaTestDb, type TestDb } from './support/pglite';

// Booting Postgres in WASM and applying the migrations takes a few seconds.
jest.setTimeout(120_000);

describe('database schema', () => {
  let t: TestDb;

  // Users
  let alice: string;
  let bob: string;
  let carol: string; // belongs to no house - the outsider every RLS test needs

  // Built up as the file runs
  let houseId: string;
  let joinCode: string;
  let gameId: string;
  let alicePlayerId: string;
  let bobPlayerId: string;

  beforeAll(async () => {
    t = await createSchemaTestDb();
    alice = await t.signUp('alice@example.com', { full_name: 'Alice Ng' });
    bob = await t.signUp('bob@example.com');
    carol = await t.signUp('carol@example.com', { name: 'Carol' });
  });

  afterAll(async () => {
    await t?.close();
  });

  describe('profile creation on signup', () => {
    it('creates a public.users row for every auth user', async () => {
      const rows = await t.query(`select id from public.users`);
      expect(rows).toHaveLength(3);
    });

    it('takes display_name from full_name, then name, then the email local part', async () => {
      const rows = await t.query<{ id: string; display_name: string }>(
        `select id, display_name from public.users`
      );
      const nameOf = (id: string) => rows.find((r) => r.id === id)?.display_name;

      expect(nameOf(alice)).toBe('Alice Ng');
      expect(nameOf(carol)).toBe('Carol');
      expect(nameOf(bob)).toBe('bob');
    });
  });

  describe('creating a house', () => {
    it('lets the owner insert and read back the row in one statement', async () => {
      await t.asUser(alice);
      // INSERT ... RETURNING only works if the SELECT policy matches the new row,
      // before the owner's membership row exists.
      const rows = await t.query<{ id: string; join_code: string }>(
        `insert into public.houses (name, owner_id)
         values ('Tuesday Night', $1)
         returning id, join_code`,
        [alice]
      );

      expect(rows).toHaveLength(1);
      houseId = rows[0].id;
      joinCode = rows[0].join_code;
    });

    it('generates a join code with no ambiguous characters', () => {
      // No I, L, O, 0 or 1 - these get read aloud and typed by hand.
      expect(joinCode).toMatch(/^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{6}$/);
    });

    it('lets the owner enrol themselves', async () => {
      await t.asUser(alice);
      const n = await t.affected(
        `insert into public.memberships (house_id, user_id) values ($1, $2)`,
        [houseId, alice]
      );
      expect(n).toBe(1);
    });
  });

  describe('joining by code', () => {
    it('enrols the caller', async () => {
      await t.asUser(bob);
      const rows = await t.query(`select public.join_house($1) as house`, [joinCode]);
      expect(rows[0].house).toBeTruthy();

      const members = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships where house_id = $1`,
        [houseId]
      );
      expect(members[0].n).toBe(2);
    });

    it('is idempotent', async () => {
      await t.asUser(bob);
      await t.query(`select public.join_house($1)`, [joinCode]);

      const members = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships where house_id = $1`,
        [houseId]
      );
      expect(members[0].n).toBe(2);
    });

    it('rejects an unknown code', async () => {
      await t.asUser(carol);
      await expect(t.query(`select public.join_house('ZZZZZZ')`)).rejects.toThrow(
        /no house with that join code/
      );
    });
  });

  describe('row level security', () => {
    it('hides houses, memberships and housemates from an outsider', async () => {
      await t.asUser(carol);

      const houses = await t.query<{ n: number }>(`select count(*)::int as n from public.houses`);
      const memberships = await t.query<{ n: number }>(
        `select count(*)::int as n from public.memberships`
      );
      const users = await t.query<{ n: number }>(`select count(*)::int as n from public.users`);

      expect(houses[0].n).toBe(0);
      expect(memberships[0].n).toBe(0);
      expect(users[0].n).toBe(1); // carol can still see herself
    });

    it('shows a member their house and their housemates', async () => {
      await t.asUser(bob);

      const houses = await t.query<{ n: number }>(`select count(*)::int as n from public.houses`);
      const users = await t.query<{ n: number }>(`select count(*)::int as n from public.users`);

      expect(houses[0].n).toBe(1);
      expect(users[0].n).toBe(2); // bob + alice, not carol
    });
  });

  describe('a game belongs to a house', () => {
    it('starts active', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ id: string; status: string }>(
        `insert into public.games (house_id) values ($1) returning id, status`,
        [houseId]
      );

      gameId = rows[0].id;
      expect(rows[0].status).toBe('active');
    });

    it('refuses a player who is not a member of the house', async () => {
      await t.asUser(alice);
      // RLS stops an outsider writing to the game; this guard stops a member
      // adding an outsider as a player.
      await expect(
        t.query(`insert into public.game_players (game_id, user_id) values ($1, $2)`, [
          gameId,
          carol,
        ])
      ).rejects.toThrow(/not a member of the house/);
    });

    it('accepts members', async () => {
      await t.asUser(alice);
      const a = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [gameId, alice]
      );
      const b = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [gameId, bob]
      );

      alicePlayerId = a[0].id;
      bobPlayerId = b[0].id;
      expect(alicePlayerId).toBeTruthy();
      expect(bobPlayerId).toBeTruthy();
    });

    it('records a buy-in and a rebuy as separate rows', async () => {
      await t.asUser(alice);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 10000)`, [
        alicePlayerId,
      ]);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 5000)`, [
        alicePlayerId,
      ]);
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 10000)`, [
        bobPlayerId,
      ]);

      const rows = await t.query<{ n: number }>(
        `select count(*)::int as n from public.buy_ins where game_player_id = $1`,
        [alicePlayerId]
      );
      expect(rows[0].n).toBe(2);
    });
  });

  describe('settling a game', () => {
    it('refuses while every final stack is missing', async () => {
      await t.asUser(alice);
      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [gameId])
      ).rejects.toThrow(/2 of 2 player\(s\) have no final stack/);
    });

    it('still refuses with one stack outstanding', async () => {
      await t.asUser(alice);
      await t.query(`update public.game_players set final_stack_cents = 20000 where id = $1`, [
        alicePlayerId,
      ]);

      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [gameId])
      ).rejects.toThrow(/1 of 2 player\(s\) have no final stack/);
    });

    it('succeeds once everyone has cashed out', async () => {
      await t.asUser(alice);
      await t.query(`update public.game_players set final_stack_cents = 5000 where id = $1`, [
        bobPlayerId,
      ]);

      const n = await t.affected(`update public.games set status = 'settled' where id = $1`, [
        gameId,
      ]);
      expect(n).toBe(1);
    });

    it('refuses to settle a game with no players', async () => {
      await t.asUser(alice);
      const empty = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );

      await expect(
        t.query(`update public.games set status = 'settled' where id = $1`, [empty[0].id])
      ).rejects.toThrow(/has no players/);
    });
  });

  describe('settled games are frozen', () => {
    // RLS filters these rows out rather than raising, so the tell is 0 rows
    // affected, not an error.
    it('rejects edits to a player, a buy-in, or the game itself', async () => {
      await t.asUser(alice);

      const player = await t.affected(
        `update public.game_players set final_stack_cents = 999999 where id = $1`,
        [alicePlayerId]
      );
      const buyIn = await t.affected(
        `update public.buy_ins set amount_cents = 1 where game_player_id = $1`,
        [alicePlayerId]
      );
      const game = await t.affected(`delete from public.games where id = $1`, [gameId]);

      expect({ player, buyIn, game }).toEqual({ player: 0, buyIn: 0, game: 0 });
    });
  });

  describe('leaderboard', () => {
    it('nets each player over settled games', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ user_id: string; games_played: number; net_cents: number }>(
        `select user_id, games_played, net_cents from public.house_leaderboards`
      );

      const netOf = (id: string) => Number(rows.find((r) => r.user_id === id)?.net_cents);

      expect(rows).toHaveLength(2);
      expect(netOf(alice)).toBe(5000); // 20000 - (10000 + 5000), rebuy counted once
      expect(netOf(bob)).toBe(-5000); //  5000 - 10000
      expect(rows.every((r) => r.games_played === 1)).toBe(true);
    });

    it('always nets to zero across the table', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ net_cents: number }>(
        `select net_cents from public.house_leaderboards`
      );

      expect(rows.reduce((sum, r) => sum + Number(r.net_cents), 0)).toBe(0);
    });

    it('returns net_cents as a number, not a numeric string', async () => {
      await t.asUser(alice);
      const rows = await t.query<{ net_cents: number }>(
        `select net_cents from public.house_leaderboards limit 1`
      );

      // sum() over bigint yields numeric, which PostgREST serialises as a string.
      // The view casts back to bigint to keep this a plain number on the client.
      expect(typeof rows[0].net_cents).not.toBe('string');
    });

    it('ignores games that are still active', async () => {
      await t.asUser(alice);
      const game = await t.query<{ id: string }>(
        `insert into public.games (house_id) values ($1) returning id`,
        [houseId]
      );
      const player = await t.query<{ id: string }>(
        `insert into public.game_players (game_id, user_id) values ($1, $2) returning id`,
        [game[0].id, alice]
      );
      await t.query(`insert into public.buy_ins (game_player_id, amount_cents) values ($1, 50000)`, [
        player[0].id,
      ]);
      await t.query(`update public.game_players set final_stack_cents = 0 where id = $1`, [
        player[0].id,
      ]);

      const rows = await t.query<{ net_cents: number }>(
        `select net_cents from public.house_leaderboards where user_id = $1`,
        [alice]
      );
      expect(Number(rows[0].net_cents)).toBe(5000); // a 500.00 loss that has not settled
    });

    it('is invisible to someone outside the house', async () => {
      // The view is security_invoker; without it a plain view would run with its
      // owner's rights and leak every house's standings.
      await t.asUser(carol);
      const rows = await t.query<{ n: number }>(
        `select count(*)::int as n from public.house_leaderboards`
      );
      expect(rows[0].n).toBe(0);
    });
  });

  describe('anonymous access', () => {
    const relations = [
      'users',
      'houses',
      'memberships',
      'games',
      'game_players',
      'buy_ins',
      'house_leaderboards',
    ];

    it.each(relations)('is denied on %s', async (relation) => {
      await t.asAnon();
      await expect(t.query(`select * from public.${relation}`)).rejects.toThrow(/permission denied/);
    });
  });
});
