/**
 * Debt simplification for settling up at the end of a game.
 *
 * Pure module: no UI, no database, no Supabase. Input is each player's net for a
 * single game; output is the set of hand-to-hand payments that squares everyone up.
 *
 * All money is integer cents (see CLAUDE.md). Nothing here ever divides by 100.
 */

/** A player's result for one game: `final_stack_cents - sum(buy_ins)`. */
export type PlayerNet = {
  /** Stable identifier for the player — a `users.id` UUID at the call site. */
  user: string;
  /** Positive = won money and is owed it. Negative = lost money and owes it. */
  net_cents: number;
};

/** One payment: `from` hands `amount_cents` to `to`. */
export type Transfer = {
  from: string;
  to: string;
  /** Always a positive integer. */
  amount_cents: number;
};

/** Internal working record: a non-zero balance with its magnitude made positive. */
type Balance = { user: string; amount_cents: number };

/**
 * Order balances largest-first, breaking ties on user id so the output is
 * deterministic — the same input always produces byte-identical transfers, which
 * keeps tests meaningful and stops the settle screen from reshuffling on re-render.
 */
function byAmountDesc(a: Balance, b: Balance): number {
  if (a.amount_cents !== b.amount_cents) {
    return b.amount_cents - a.amount_cents;
  }
  return a.user < b.user ? -1 : a.user > b.user ? 1 : 0;
}

function validate(nets: readonly PlayerNet[]): void {
  const seen = new Set<string>();
  let total = 0;

  for (const { user, net_cents } of nets) {
    if (!Number.isInteger(net_cents)) {
      throw new Error(
        `settle: net_cents must be an integer number of cents, got ${net_cents} for "${user}"`
      );
    }
    if (seen.has(user)) {
      throw new Error(`settle: duplicate player "${user}" in nets`);
    }
    seen.add(user);
    total += net_cents;
  }

  // A cash game is closed: every cent that left a wallet landed in another stack.
  // A non-zero sum means a buy-in or final stack was mis-entered, and settling on
  // bad numbers would quietly move real money — so refuse rather than guess.
  if (total !== 0) {
    throw new Error(
      `settle: nets must sum to zero, got ${total} cents (check buy-ins and final stacks)`
    );
  }
}

/**
 * Compute the payments that settle a game, using as few transfers as we can.
 *
 * Two passes:
 *
 * 1. **Exact matches.** Any debtor whose debt equals a creditor's credit is paired
 *    off directly. Such a pair is always safe to fix: it clears two people in one
 *    transfer, which no solution can beat, so taking it never costs optimality.
 * 2. **Greedy.** Repeatedly pay the largest remaining creditor from the largest
 *    remaining debtor. Each transfer zeroes out at least one person, so `n`
 *    non-zero players need at most `n - 1` transfers.
 *
 * This is the standard debt-simplification heuristic, and it is optimal whenever no
 * proper subgroup of players happens to settle among itself (the usual case at a
 * home game). Finding the true minimum in every case means searching for zero-sum
 * subsets, which is NP-hard and not worth it for a table of friends.
 *
 * Players who broke exactly even are dropped — they neither pay nor get paid.
 *
 * @throws if nets don't sum to zero, aren't integers, or repeat a player.
 */
export function settle(nets: readonly PlayerNet[]): Transfer[] {
  validate(nets);

  const debtors: Balance[] = [];
  const creditors: Balance[] = [];

  for (const { user, net_cents } of nets) {
    if (net_cents < 0) {
      debtors.push({ user, amount_cents: -net_cents });
    } else if (net_cents > 0) {
      creditors.push({ user, amount_cents: net_cents });
    }
  }

  debtors.sort(byAmountDesc);
  creditors.sort(byAmountDesc);

  const transfers: Transfer[] = [];

  // Pass 1: pair off debts and credits of identical size.
  for (const debtor of debtors) {
    const match = creditors.find((c) => c.amount_cents === debtor.amount_cents);
    if (!match) continue;

    transfers.push({
      from: debtor.user,
      to: match.user,
      amount_cents: debtor.amount_cents,
    });
    debtor.amount_cents = 0;
    match.amount_cents = 0;
  }

  const remainingDebtors = debtors.filter((d) => d.amount_cents > 0);
  const remainingCreditors = creditors.filter((c) => c.amount_cents > 0);

  // Pass 2: largest debtor pays largest creditor until everyone is flat.
  let d = 0;
  let c = 0;
  while (d < remainingDebtors.length && c < remainingCreditors.length) {
    const debtor = remainingDebtors[d];
    const creditor = remainingCreditors[c];
    const amount_cents = Math.min(debtor.amount_cents, creditor.amount_cents);

    transfers.push({ from: debtor.user, to: creditor.user, amount_cents });

    debtor.amount_cents -= amount_cents;
    creditor.amount_cents -= amount_cents;

    if (debtor.amount_cents === 0) d += 1;
    if (creditor.amount_cents === 0) c += 1;
  }

  return transfers;
}
