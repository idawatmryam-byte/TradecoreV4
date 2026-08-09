export interface HypothesisTest {
  id: string;
  pValue: number;
}

export interface AdjustedHypothesisTest extends HypothesisTest {
  rank: number;
  adjustedPValue: number;
  discovery: boolean;
}

export function benjaminiHochberg(
  tests: readonly HypothesisTest[],
  falseDiscoveryRate: number,
): readonly AdjustedHypothesisTest[] {
  if (!(falseDiscoveryRate > 0 && falseDiscoveryRate < 1)) {
    throw new Error("False discovery rate must be between zero and one");
  }
  if (tests.length === 0) return Object.freeze([]);
  const ids = new Set<string>();
  for (const test of tests) {
    if (!test.id.trim() || ids.has(test.id))
      throw new Error("Hypothesis identifiers must be non-empty and unique");
    if (!Number.isFinite(test.pValue) || test.pValue < 0 || test.pValue > 1) {
      throw new Error(`Hypothesis ${test.id} has an invalid p-value`);
    }
    ids.add(test.id);
  }

  const ordered = [...tests].sort(
    (a, b) => a.pValue - b.pValue || a.id.localeCompare(b.id),
  );
  const m = ordered.length;
  let largestDiscoveryRank = 0;
  for (let index = 0; index < ordered.length; index++) {
    if (ordered[index]!.pValue <= ((index + 1) / m) * falseDiscoveryRate)
      largestDiscoveryRank = index + 1;
  }

  const adjusted = new Array<number>(m);
  let runningMinimum = 1;
  for (let index = m - 1; index >= 0; index--) {
    runningMinimum = Math.min(
      runningMinimum,
      (ordered[index]!.pValue * m) / (index + 1),
    );
    adjusted[index] = Math.min(1, runningMinimum);
  }

  return Object.freeze(
    ordered.map((test, index) =>
      Object.freeze({
        ...test,
        rank: index + 1,
        adjustedPValue: adjusted[index]!,
        discovery: index + 1 <= largestDiscoveryRank,
      }),
    ),
  );
}
