export type Kind = "request" | "result" | "notice";
export interface Message {
  id: string;
  topic: string;
  from: string;
  to: string;
  kind: Kind;
  replyTo: string;
  project: string;
  text: string;
  created: number;
}
export interface Profile {
  id: string;
  name: string;
  role: string;
  projects: string[];
  seen: number;
}
export interface Config {
  server: string;
  userId: string;
  name: string;
  role: string;
  token: string;
  projects: Record<string, string>;
  trustedPeers: string[];
  autoAccept: boolean;
  verifyResults: boolean;
  paused: boolean;
  maxRuns: number;
  timeoutSeconds: number;
  sandbox: "read-only" | "workspace-write";
  codexPath: string;
  provider: "codex" | "claude" | "custom";
  runCommand: string;
  localInstructions: string;
  incomingMode: "manual" | "approval" | "auto";
  replyMode: "draft" | "auto";
  workingDirectory: string;
  incomingSince: number;
}
export type TaskState =
  | "waiting"
  | "pending"
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "stopped"
  | "interrupted";
export interface Task {
  id: string;
  messageId: string;
  topic: string;
  peer: string;
  project: string;
  state: TaskState;
  kind: "request" | "verify";
  input: string;
  output: string;
  created: number;
  updated: number;
  collaborationRuntime?: { url: string; token: string; instructions: string };
  chatReply?: "draft" | "sent";
}
export interface RunResult {
  text: string;
  sessionId?: string;
}
export type Executor = (
  task: Task,
  config: Config,
  sessionId: string | undefined,
  signal: AbortSignal,
  onSession: (id: string) => void,
) => Promise<RunResult>;
export const defaults: Config = {
  server: "",
  userId: "",
  name: "",
  role: "",
  token: "",
  projects: {},
  trustedPeers: [],
  autoAccept: false,
  verifyResults: false,
  paused: false,
  maxRuns: 4,
  timeoutSeconds: 900,
  sandbox: "read-only",
  codexPath: "codex",
  provider: "codex",
  runCommand: "",
  incomingMode: "manual",
  replyMode: "draft",
  workingDirectory: "",
  incomingSince: 0,
  localInstructions: "",
};
export const validId = (s: unknown): s is string =>
  typeof s === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,79}$/.test(s);
export interface Conversation {
  id: string;
  kind: "direct" | "group";
  name: string;
  owner: string;
  members: string[];
  created: number;
}
export interface ChatMessage {
  seq: number;
  id: string;
  conversation: string;
  from: string;
  kind:
    | "text"
    | "task"
    | "result"
    | "proposal"
    | "amendment"
    | "commitment"
    | "completion"
    | "withdrawal"
    | "closure"
    | "goal"
    | "question"
    | "answer"
    | "progress"
    | "decision";
  text: string;
  mentions: string[];
  agent: string;
  project: string;
  taskId: string;
  created: number;
  delivery?: "pending" | "sent" | "failed";
  error?: string;
  readBy?: string[];
  activities?: ChatActivity[];
  receiptAvailable?: boolean;
}
export interface ConversationView extends Conversation {
  latest?: ChatMessage;
  unread: number;
  mentioned: boolean;
}
export interface ChatSync {
  conversations: Conversation[];
  messages: ChatMessage[];
  cursor: number;
  receipts?: ChatRead[];
  activities?: ChatActivity[];
}

export interface ChatRead {
  conversation: string;
  user: string;
  seq: number;
}
export interface ChatActivity {
  message: string;
  user: string;
  state: string;
  updated: number;
}
