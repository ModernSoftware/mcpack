/** Private Node IPC protocol. Explicitly versioned; not the public MCP protocol. */
import { z } from 'zod';

const text = z.object({ type: z.literal('text'), text: z.string() }).strict();

export const toolResult = z
  .object({
    content: z.array(text),
    structuredContent: z.record(z.string(), z.json()).optional(),
    isError: z.boolean().optional(),
  })
  .strict();

export const resourceResult = z
  .object({
    contents: z.array(
      z.object({ uri: z.string(), mimeType: z.string().optional(), text: z.string() }).strict(),
    ),
  })
  .strict();

export const promptResult = z
  .object({
    description: z.string().optional(),
    messages: z.array(z.object({ role: z.enum(['user', 'assistant']), content: text }).strict()),
  })
  .strict();

export const parentMessage = z.discriminatedUnion('type', [
  z.object({
    v: z.literal(1),
    type: z.literal('init'),
    workerId: z.string(),
    projectRoot: z.string(),
    module: z.string(),
    exportName: z.string(),
    config: z.record(z.string(), z.json()),
    bindings: z.array(
      z.object({ kind: z.enum(['tools', 'resources', 'prompts']), handler: z.string() }),
    ),
  }),
  z.object({
    v: z.literal(1),
    type: z.literal('call'),
    id: z.string(),
    kind: z.enum(['tools', 'resources', 'prompts']),
    handler: z.string(),
    input: z.record(z.string(), z.json()),
  }),
  z.object({ v: z.literal(1), type: z.literal('cancel'), id: z.string() }),
  z.object({ v: z.literal(1), type: z.literal('close') }),
]);

export const childMessage = z.discriminatedUnion('type', [
  z.object({ v: z.literal(1), type: z.literal('ready') }),
  z.object({ v: z.literal(1), type: z.literal('result'), id: z.string(), result: z.json() }),
  z.object({
    v: z.literal(1),
    type: z.literal('error'),
    id: z.string().optional(),
    code: z.enum(['STARTUP_FAILED', 'HANDLER_FAILED', 'INVALID_RESULT']),
    message: z.string(),
  }),
  z.object({ v: z.literal(1), type: z.literal('closed') }),
]);
