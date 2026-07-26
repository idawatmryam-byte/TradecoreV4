/**
 * TradeCore Pro — point-in-time (as-of-T) views
 *
 * Every claim the knowledge layer makes is of the form "given only what was
 * knowable at time T, here is what the record said". The entire value of that
 * sentence rests on the "only", and look-ahead leakage is the easiest bug in
 * quantitative work to write and the hardest to notice: the numbers get
 * *better*, not worse, and nothing crashes.
 *
 * So this module does not offer a filter helper that callers are trusted to
 * remember. It offers the only constructor of a `PointInTimeView`, and every
 * downstream function — cells, calibration, similarity — accepts a view and
 * refuses a plain array. Forgetting the filter is a type error rather than a
 * silently optimistic backtest.
 *
 * The timestamp that matters is when an outcome became KNOWN, not when the
 * position was opened. A trade entered on Monday and closed on Friday teaches
 * nothing on Tuesday; treating its entry time as its availability would let
 * Friday's result inform Tuesday's decision, which is precisely the leak.
 */

/**
 * The minimum any row must carry to be placed on the timeline.
 *
 * `closedAt` is epoch milliseconds of the moment the outcome was settled and
 * observable. Rows whose outcome is not yet known do not belong in a view at
 * all — there is no honest way to include an open trade in a historical claim.
 */
export interface Observable {
  readonly closedAt: number;
}

/**
 * Rows filtered to those knowable at `asOf`, and a record of where the cut was
 * made. The constructor is the only way to obtain one, so possession of a view
 * IS the proof that the cut happened.
 */
export interface PointInTimeView<T extends Observable> {
  /** The cut. Epoch ms. */
  readonly asOf: number;
  /** Everything settled at or before `asOf`, ordered oldest → newest. */
  readonly rows: readonly T[];
}

/**
 * Cut the record at T.
 *
 * The boundary is inclusive (`closedAt <= asOf`): a trade that closed exactly
 * at T was knowable at T. Rows with a non-finite or missing timestamp are
 * dropped rather than defaulted — an unplaceable row cannot be proven to be in
 * the past, and "assume it's old enough" is the leak wearing a different hat.
 */
export function asOfView<T extends Observable>(rows: readonly T[], asOf: number | Date): PointInTimeView<T> {
  const cut = asOf instanceof Date ? asOf.getTime() : asOf;
  if (!Number.isFinite(cut)) throw new Error("asOfView: as-of timestamp must be a finite time");

  const kept = rows
    .filter((r) => Number.isFinite(r.closedAt) && r.closedAt <= cut)
    .sort((a, b) => a.closedAt - b.closedAt);

  return { asOf: cut, rows: kept };
}

/**
 * Split a view into a training window and a later validation window.
 *
 * Strictly chronological, never random: a shuffled split would put a Friday
 * trade in training and a Tuesday trade in validation, and the resulting
 * "out-of-sample" score would be measuring nothing. `fraction` is the share of
 * rows that go to training.
 *
 * Both halves are themselves views — validation is as-of its own last row, so
 * anything derived from it inherits the same guarantee.
 */
export function chronologicalSplit<T extends Observable>(
  view: PointInTimeView<T>,
  fraction = 0.7,
): { train: PointInTimeView<T>; validation: PointInTimeView<T> } {
  const f = Math.min(Math.max(fraction, 0), 1);
  const cutIndex = Math.floor(view.rows.length * f);
  const trainRows = view.rows.slice(0, cutIndex);
  const validationRows = view.rows.slice(cutIndex);

  return {
    train: {
      asOf: trainRows.length ? trainRows[trainRows.length - 1]!.closedAt : view.asOf,
      rows: trainRows,
    },
    validation: { asOf: view.asOf, rows: validationRows },
  };
}

/**
 * Assert that no row in a view postdates its cut.
 *
 * The type system stops a caller from skipping `asOfView`, but not from
 * hand-building an object that satisfies the interface. This is the runtime
 * belt to that braces — cheap, and called by the harness on every view it
 * produces.
 */
export function assertNoLookahead<T extends Observable>(view: PointInTimeView<T>): void {
  const offender = view.rows.find((r) => r.closedAt > view.asOf);
  if (offender) {
    throw new Error(
      `look-ahead: a row settled at ${new Date(offender.closedAt).toISOString()} ` +
      `appears in a view cut at ${new Date(view.asOf).toISOString()}`,
    );
  }
}
