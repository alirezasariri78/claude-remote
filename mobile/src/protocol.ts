// Shapes exchanged with the bridge server (server/index.mjs).

export type SessionState = 'idle' | 'running' | 'requires_action';
export type PermissionMode = 'default' | 'acceptEdits' | 'plan';

export const MODE_LABELS: Record<PermissionMode, string> = {
  default: 'Ask permissions',
  acceptEdits: 'Accept edits',
  plan: 'Plan mode',
};

export type SessionInfo = {
  id: string;
  title: string;
  cwd: string | null;
  branch: string | null;
  section: string | null;
  archived: boolean;
  lastModified: number;
  state: SessionState;
  live: boolean;
};

export type ResultStats = {
  costUsd?: number | null;
  durationMs?: number | null;
  numTurns?: number | null;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    cache_read_input_tokens?: number;
    cache_creation_input_tokens?: number;
  } | null;
};

export type Item =
  | { kind: 'user'; id: string; text: string }
  | { kind: 'assistant'; id: string; text: string }
  | {
      kind: 'tool';
      id: string;
      name: string;
      input: Record<string, unknown>;
      result?: { text: string; isError: boolean };
    }
  | { kind: 'tool_result'; id: string; toolUseId: string; text: string; isError: boolean }
  | ({ kind: 'result'; id: string; isError: boolean; text: string } & ResultStats);

export type QuestionOption = { label: string; description?: string };
export type Question = { question: string; header?: string; options: QuestionOption[]; multiSelect?: boolean };

export type PermissionRequest = {
  sessionId: string;
  requestId: string;
  toolName: string;
  input: Record<string, unknown>;
  title: string | null;
  displayName: string | null;
  description: string | null;
  reason: string | null;
  blockedPath: string | null;
  canAlways: boolean;
  /** 'desktop' when the request comes from a session running outside the service. */
  source?: string;
};

export type Window = { utilization: number | null; resets_at: string | null };

export type Usage = {
  subscriptionType: string | null;
  rateLimitsAvailable: boolean;
  rateLimits: {
    five_hour?: Window | null;
    seven_day?: Window | null;
    seven_day_opus?: Window | null;
    seven_day_sonnet?: Window | null;
    model_scoped?: ({ display_name: string } & Window)[];
    extra_usage?: {
      is_enabled: boolean;
      monthly_limit: number | null;
      used_credits: number | null;
      utilization: number | null;
      currency?: string | null;
    } | null;
  } | null;
  fetchedAt: number;
};

export type RateLimitInfo = {
  status: 'allowed' | 'allowed_warning' | 'rejected';
  resetsAt?: number;
  rateLimitType?: string;
  utilization?: number;
};

export type DirEntry = { name: string; path: string };
export type DirListing = { path: string | null; parent: string | null; home: string; dirs: DirEntry[] };

export type ChatState = {
  items: Item[];
  stream: string;
  state: SessionState;
  model: string | null;
  permissionMode: PermissionMode | null;
  loaded: boolean;
  error: string | null;
  /** Position of items[0] in the full history; above 0 means older messages exist. */
  start: number;
  loadingOlder: boolean;
  /** Fingerprint of the last page received, to skip refreshes that change nothing. */
  sig: string;
};
