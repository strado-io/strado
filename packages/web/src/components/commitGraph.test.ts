import { describe, expect, it } from 'vitest';
import { buildGraph } from './commitGraph';

describe('buildGraph', () => {
  it('keeps a linear chain in lane 0', () => {
    const { rows, laneCount } = buildGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 0]);
    expect(laneCount).toBe(1);
    // middle row: converge-in from above and continue-out below, both lane 0
    expect(rows[1]!.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromLane: 0, toLane: 0, toDot: true }),
        expect.objectContaining({ fromLane: 0, toLane: 0, fromDot: true }),
      ]),
    );
    // root has no outgoing segment
    expect(rows[2]!.segments.some((s) => s.fromDot)).toBe(false);
  });

  it('gives an unmerged branch tip its own lane and converges at the fork point', () => {
    // main: a <- b <- c ; feature from a: a <- f ; topo order newest-first
    const { rows, laneCount } = buildGraph([
      { hash: 'c', parents: ['b'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0, 0]);
    expect(laneCount).toBe(2);
    // row b: lane 1 (waiting for a) passes through
    expect(rows[2]!.segments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ fromLane: 1, toLane: 1, color: 1 }),
      ]),
    );
    // row a: both lanes converge into the dot at lane 0
    const converging = rows[3]!.segments.filter((s) => s.toDot);
    expect(converging.map((s) => s.fromLane).sort()).toEqual([0, 1]);
  });

  it('fans a merge commit out to both parents', () => {
    // merge m of b (main) and f (feature), both children of a
    const { rows, laneCount } = buildGraph([
      { hash: 'm', parents: ['b', 'f'] },
      { hash: 'b', parents: ['a'] },
      { hash: 'f', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 0, 1, 0]);
    expect(laneCount).toBe(2);
    const out = rows[0]!.segments.filter((s) => s.fromDot);
    expect(out.map((s) => s.toLane).sort()).toEqual([0, 1]);
  });

  it('keeps two tips with a shared parent in their own lanes until the parent row', () => {
    // git --graph shape: strands run parallel and converge with |/ at `a`
    const { rows } = buildGraph([
      { hash: 'x', parents: ['a'] },
      { hash: 'y', parents: ['a'] },
      { hash: 'a', parents: [] },
    ]);
    expect(rows.map((r) => r.lane)).toEqual([0, 1, 0]);
    const yOut = rows[1]!.segments.find((s) => s.fromDot)!;
    expect(yOut.toLane).toBe(1);
    const converging = rows[2]!.segments.filter((s) => s.toDot);
    expect(converging.map((s) => s.fromLane).sort()).toEqual([0, 1]);
  });

  it('handles empty input', () => {
    expect(buildGraph([])).toEqual({ rows: [], laneCount: 1 });
  });
});
