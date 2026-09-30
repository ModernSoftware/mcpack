/** Public contracts: manifest v1 and native Node module API v1. */
export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

export type JsonObject = { [key: string]: Json };

export interface TextContent {
  type: 'text';
  text: string;
}

export interface ToolResult {
  content: TextContent[];
  structuredContent?: JsonObject;
  isError?: boolean;
}

export interface ResourceResult {
  contents: { uri: string; mimeType?: string; text: string }[];
}

export interface PromptResult {
  description?: string;
  messages: { role: 'user' | 'assistant'; content: TextContent }[];
}

export interface WorkerContext {
  readonly workerId: string;
  readonly projectRoot: string;
  readonly config: JsonObject;
  log(message: string): void;
}

export interface CallContext extends WorkerContext {
  readonly requestId: string;
  readonly signal: AbortSignal;
}

export type Handler<Input, Output> = (
  input: Input,
  context: CallContext,
) => Output | Promise<Output>;

export interface NativeWorker {
  tools?: Record<string, Handler<JsonObject, ToolResult>>;
  resources?: Record<string, Handler<{ uri: string }, ResourceResult>>;
  prompts?: Record<string, Handler<Record<string, string>, PromptResult>>;
  close?(): void | Promise<void>;
}

export type CreateWorker = (context: WorkerContext) => NativeWorker | Promise<NativeWorker>;

export type Operation = 'tools' | 'resources' | 'prompts';
