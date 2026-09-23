// `SurfaceValue`, `SurfaceKind` and `AgentSummary` are hand-mirrored in
// api.ts from the server's own types (see the comment on `SurfaceKind`
// there) — this package must never import the server's RUNTIME code, but a
// type-only import doesn't ship anything: it's erased before `vite build`
// ever sees this file, and only feeds `tsc`'s type checker (which IS part of
// `npm run build -w packages/web`, via `tsc -p tsconfig.json --noEmit`) plus
// this test file itself.
//
// Without this, the two copies can silently drift — exactly the risk slice 2
// runs into first, when it adds three more descriptors and their surfaces'
// kinds. `Equal<A, B>` (not a one-way `A extends B`) is what actually catches
// that: a one-way check would still pass if the web copy merely DROPPED a
// field or widened a union, which is precisely the kind of divergence this
// guards against.
import type { AgentSummary, SurfaceKind, SurfaceValue } from './api';
import type {
  AgentSummary as ServerAgentSummary,
  SurfaceKind as ServerSurfaceKind,
  SurfaceValue as ServerSurfaceValue,
} from '../../server/src/services/agentConfig/types.js';
import { describe, it, expect } from 'vitest';

type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;

// A failing `Expect<false>` call is a COMPILE error (not a runtime one) —
// `tsc` refuses to instantiate `Expect<T extends true>` with `false` — so a
// divergence is caught by `npm run build -w packages/web` (and by any editor
// showing this file) even before a test ever runs.
type Expect<T extends true> = T;

type _SurfaceKindParity = Expect<Equal<SurfaceKind, ServerSurfaceKind>>;
type _SurfaceValueParity = Expect<Equal<SurfaceValue, ServerSurfaceValue>>;
type _AgentSummaryParity = Expect<Equal<AgentSummary, ServerAgentSummary>>;

describe('agent-config wire types stay in sync with the server', () => {
  // The real assertion above is at the type level and runs during
  // typechecking, not here — this test exists so a run of `npm test` (which
  // does not typecheck) still surfaces as a named, visible test rather than
  // a silent no-op file with nothing to report.
  it('is a type-only check — see the `Expect<Equal<...>>` aliases above', () => {
    expect(true).toBe(true);
  });
});
