// Shared agent/conversation types. The handoff feature that owned this file was
// removed in favour of intercom forks; the turn diary, agent session registry
// and conversation readers still share these shapes.
export type AgentMode = 'claude' | 'codex' | 'opencode' | 'pi';

export type HandoffConversationMessage = {
  role: 'user' | 'assistant';
  content: string;
};

export type HandoffContextSource =
  | 'claude-history'
  | 'codex-history'
  | 'opencode-history'
  | 'pi-history'
  | 'none';
