import type { ComponentType } from 'react';
import type { SurfaceKind } from '../../../../api';
import { McpList } from './McpList';
import { SkillList } from './SkillList';
import { PluginList } from './PluginList';
import { HookList } from './HookList';
import { PermissionsEditor } from './PermissionsEditor';
import { KvTable } from './KvTable';
import { ScalarField } from './ScalarField';
import { MarkdownFile } from './MarkdownFile';
import { RawFile } from './RawFile';
import type { SurfaceProps } from './types';

export type { SurfaceProps } from './types';

// `Record<SurfaceKind, ...>` rather than a lookup function with a fallback:
// adding a SurfaceKind without a widget here is a compile error, not a blank
// area in the settings panel at runtime.
const WIDGETS: Record<SurfaceKind, ComponentType<SurfaceProps>> = {
  'mcp-list': McpList,
  'skill-list': SkillList,
  'plugin-list': PluginList,
  'hook-list': HookList,
  permissions: PermissionsEditor,
  kv: KvTable,
  enum: ScalarField,
  toggle: ScalarField,
  markdown: MarkdownFile,
  raw: RawFile,
};

export function widgetFor(kind: SurfaceKind): ComponentType<SurfaceProps> {
  return WIDGETS[kind];
}
