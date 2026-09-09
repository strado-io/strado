import type { SurfaceValue } from '../../../../api';

// Every per-surface widget takes the same props. `onChange` commits
// immediately (list surfaces: mcp-list, plugin-list, hook-list). `onStage`
// batches an edit behind the group's Save button (scalar surfaces: enum,
// toggle, kv, permissions, markdown, raw) — list widgets never receive it,
// so it's optional. `onRemoveSkill` is `skill-list`'s own removal path — a
// directory surface has no JSON key for `onChange`'s PATCH to target, so
// removal goes through the dedicated skills route instead; every widget
// besides `SkillList` ignores it.
export type SurfaceProps = {
  surface: SurfaceValue;
  onChange: (value: unknown) => Promise<void>;
  onStage?: (value: unknown) => void;
  onRemoveSkill?: (name: string) => Promise<void>;
};
