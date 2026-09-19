import { settle, type PlayerNet, type Transfer } from './settlement';

/**
 * Replay the transfers against the original nets. Everyone must land on zero —
 * this is the real contract, and asserting it stops a "fewer transfers" tweak from
 * ever silently moving the wrong amount.
 */
function balancesAfter(nets: PlayerNet[], transfers: Transfer[]): Map<string, number> {
  const balances = new Map(nets.map((n) => [n.user, n.net_cents]));
  for (const { from, to, amount_cents } of transfers) {
    balances.set(from, (balances.get(from) ?? 0) + amount_cents);
    balances.set(to, (balances.get(to) ?? 0) - amount_cents);
  }
  return balances;
}

function expectEveryoneSettled(nets: PlayerNet[], transfers: Transfer[]): void {
  for (const [user, balance] of balancesAfter(nets, transfers)) {
    expect({ user, balance }).toEqual({ user, balance: 0 });
  }
  for (const t of transfers) {
    expect(t.amount_cents).toBeGreaterThan(0);
    expect(Number.isInteger(t.amount_cents)).toBe(true);
    expect(t.from).not.toBe(t.to);
  }
}

describe('settle', () => {
  describe('two players', () => {
    it('moves the loser stack to the winner in a single transfer', () => {
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: 2500 },
        { user: 'bob', net_cents: -2500 },
      ];

      const transfers = settle(nets);

      expect(transfers).toEqual([{ from: 'bob', to: 'alice', amount_cents: 2500 }]);
      expectEveryoneSettled(nets, transfers);
    });

    it('keeps full cent precision on awkward amounts', () => {
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -1 },
        { user: 'bob', net_cents: 1 },
      ];

      expect(settle(nets)).toEqual([{ from: 'alice', to: 'bob', amount_cents: 1 }]);
    });
  });

  describe('multiple players', () => {
    it('settles a table where no two players match up exactly', () => {
      // -6000 and -1000 owed to +4000 and +3000: no debt equals a credit, so the
      // greedy pass has to split alice's loss across both winners.
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -6000 },
        { user: 'bob', net_cents: -1000 },
        { user: 'carol', net_cents: 4000 },
        { user: 'dave', net_cents: 3000 },
      ];

      const transfers = settle(nets);

      expect(transfers).toEqual([
        { from: 'alice', to: 'carol', amount_cents: 4000 },
        { from: 'alice', to: 'dave', amount_cents: 2000 },
        { from: 'bob', to: 'dave', amount_cents: 1000 },
      ]);
      expectEveryoneSettled(nets, transfers);
    });

    it('settles a six-handed game', () => {
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: 12_050 },
        { user: 'bob', net_cents: -4_500 },
        { user: 'carol', net_cents: -8_075 },
        { user: 'dave', net_cents: 3_025 },
        { user: 'erin', net_cents: -6_000 },
        { user: 'frank', net_cents: 3_500 },
      ];

      const transfers = settle(nets);

      expectEveryoneSettled(nets, transfers);
      // Six players with money on the line never needs more than five payments.
      expect(transfers.length).toBeLessThanOrEqual(5);
    });

    it('is deterministic across equal amounts', () => {
      const nets: PlayerNet[] = [
        { user: 'dave', net_cents: -1000 },
        { user: 'carol', net_cents: -1000 },
        { user: 'bob', net_cents: 1000 },
        { user: 'alice', net_cents: 1000 },
      ];

      expect(settle(nets)).toEqual(settle(nets));
      expect(settle(nets)).toEqual(settle([...nets].reverse()));
    });
  });

  describe('players who broke even', () => {
    it('leaves an even player out of the transfers entirely', () => {
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -3000 },
        { user: 'bob', net_cents: 0 },
        { user: 'carol', net_cents: 3000 },
      ];

      const transfers = settle(nets);

      expect(transfers).toEqual([{ from: 'alice', to: 'carol', amount_cents: 3000 }]);
      expect(transfers.some((t) => t.from === 'bob' || t.to === 'bob')).toBe(false);
      expectEveryoneSettled(nets, transfers);
    });

    it('returns no transfers when the whole table broke even', () => {
      expect(
        settle([
          { user: 'alice', net_cents: 0 },
          { user: 'bob', net_cents: 0 },
        ])
      ).toEqual([]);
    });

    it('returns no transfers for an empty game', () => {
      expect(settle([])).toEqual([]);
    });
  });

  describe('minimising the number of transfers', () => {
    it('pairs players off instead of routing everything through one person', () => {
      // Two independent winner/loser pairs. Anything that funnels the money through
      // a single player would need three hand-offs; the right answer is two.
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: 5000 },
        { user: 'bob', net_cents: -5000 },
        { user: 'carol', net_cents: 3000 },
        { user: 'dave', net_cents: -3000 },
      ];

      const transfers = settle(nets);

      expect(transfers).toEqual([
        { from: 'bob', to: 'alice', amount_cents: 5000 },
        { from: 'dave', to: 'carol', amount_cents: 3000 },
      ]);
      expectEveryoneSettled(nets, transfers);
    });

    it('spots an exact match that is not the biggest debt', () => {
      // carol's -2000 exactly covers erin's +2000. A plain largest-first greedy would
      // start alice -> dave and leave carol's debt split in two; the exact-match pass
      // clears carol and erin in one payment, saving a transfer.
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -5000 },
        { user: 'carol', net_cents: -2000 },
        { user: 'dave', net_cents: 4000 },
        { user: 'erin', net_cents: 2000 },
        { user: 'frank', net_cents: 1000 },
      ];

      const transfers = settle(nets);

      expect(transfers).toContainEqual({ from: 'carol', to: 'erin', amount_cents: 2000 });
      expect(transfers).toHaveLength(3);
      expectEveryoneSettled(nets, transfers);
    });

    it('never needs more transfers than there are players with money owed', () => {
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -1500 },
        { user: 'bob', net_cents: -2500 },
        { user: 'carol', net_cents: -700 },
        { user: 'dave', net_cents: 0 },
        { user: 'erin', net_cents: 3200 },
        { user: 'frank', net_cents: 1500 },
      ];

      const transfers = settle(nets);
      const playersWithMoneyOwed = nets.filter((n) => n.net_cents !== 0).length;

      expect(transfers.length).toBeLessThanOrEqual(playersWithMoneyOwed - 1);
      expectEveryoneSettled(nets, transfers);
    });

    it('collapses a chain of debts into one payment', () => {
      // alice owes the pot, carol is owed it, and bob is only passing money through.
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -4000 },
        { user: 'bob', net_cents: 0 },
        { user: 'carol', net_cents: 4000 },
      ];

      expect(settle(nets)).toEqual([{ from: 'alice', to: 'carol', amount_cents: 4000 }]);
    });
  });

  describe('bad input', () => {
    it('refuses nets that do not sum to zero', () => {
      expect(() =>
        settle([
          { user: 'alice', net_cents: 5000 },
          { user: 'bob', net_cents: -4000 },
        ])
      ).toThrow(/sum to zero/);
    });

    it('refuses fractional cents', () => {
      expect(() =>
        settle([
          { user: 'alice', net_cents: 10.5 },
          { user: 'bob', net_cents: -10.5 },
        ])
      ).toThrow(/integer/);
    });

    it('refuses a duplicated player', () => {
      expect(() =>
        settle([
          { user: 'alice', net_cents: 1000 },
          { user: 'alice', net_cents: -1000 },
        ])
      ).toThrow(/duplicate/);
    });

    it('does not mutate the array it was given', () => {
      const nets: PlayerNet[] = [
        { user: 'alice', net_cents: -2000 },
        { user: 'bob', net_cents: 2000 },
      ];
      const snapshot = JSON.parse(JSON.stringify(nets));

      settle(nets);

      expect(nets).toEqual(snapshot);
    });
  });
});
