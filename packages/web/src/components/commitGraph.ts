// Lane assignment for a commit graph, newest-first topo order (git log
// --topo-order). Each row gets a dot lane plus the segments to draw between
// the row's top edge and bottom edge:
//   toDot    — a lane from above converging into this row's dot
//   fromDot  — this dot routing out to a parent's lane below
//   neither  — an unrelated lane passing straight through
export type GraphInput = { hash: string; parents: string[] };

export type GraphSegment = {
  fromLane: number;
  toLane: number;
  color: number;
  fromDot?: boolean;
  toDot?: boolean;
};

export type GraphRow = { hash: string; lane: number; segments: GraphSegment[] };

export function buildGraph(commits: GraphInput[]): { rows: GraphRow[]; laneCount: number } {
  // lanes[j] = the commit hash lane j is waiting to reach (null = free)
  const lanes: (string | null)[] = [];
  let laneCount = 1;

  const rows: GraphRow[] = commits.map((c) => {
    const segments: GraphSegment[] = [];

    const waiting: number[] = [];
    lanes.forEach((h, j) => {
      if (h === c.hash) waiting.push(j);
    });

    let lane: number;
    if (waiting.length > 0) {
      lane = Math.min(...waiting);
      for (const j of waiting) {
        segments.push({ fromLane: j, toLane: lane, color: j, toDot: true });
        lanes[j] = null;
      }
    } else {
      // Branch tip nobody is waiting for: claim the first free lane.
      let free = lanes.indexOf(null);
      if (free === -1) {
        free = lanes.length;
        lanes.push(null);
      }
      lane = free;
    }

    lanes.forEach((h, j) => {
      if (h !== null) segments.push({ fromLane: j, toLane: j, color: j });
    });

    c.parents.forEach((p, i) => {
      // First parent always continues in the child's own lane, even when
      // another lane already waits for the same hash — the strands converge
      // at the parent's row (git log --graph's |/ shape), not here.
      if (i === 0) {
        lanes[lane] = p;
        segments.push({ fromLane: lane, toLane: lane, color: lane, fromDot: true });
        return;
      }
      const existing = lanes.indexOf(p);
      if (existing !== -1) {
        // Merge parent already tracked — bend into that strand.
        segments.push({ fromLane: lane, toLane: existing, color: existing, fromDot: true });
        return;
      }
      let target = lanes.indexOf(null);
      if (target === -1) {
        target = lanes.length;
        lanes.push(null);
      }
      lanes[target] = p;
      segments.push({ fromLane: lane, toLane: target, color: target, fromDot: true });
    });

    laneCount = Math.max(laneCount, lanes.length, lane + 1);
    return { hash: c.hash, lane, segments };
  });

  return { rows, laneCount };
}
