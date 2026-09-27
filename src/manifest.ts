import { readFile, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { z } from 'zod';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { MCPackError } from './errors.js';

const name = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/);
const json = z.json();
const object = z.record(z.string(), json);

const binding = {
  worker: name,
  handler: name,
};

const workerFields = {
  module: z.string().min(1),
  config: object.default({}),
  env: z.record(z.string(), z.string()).default({}),
  inheritEnv: z.array(z.string()).default([]),
  startupTimeoutMs: z.number().int().min(1).max(300_000).default(10_000),
  timeoutMs: z.number().int().min(1).max(300_000).default(30_000),
  shutdownTimeoutMs: z.number().int().min(1).max(30_000).default(3_000),
  maxOutputBytes: z
    .number()
    .int()
    .min(1024)
    .max(64 * 1024 * 1024)
    .default(1024 * 1024),
  maxDiagnosticBytesPerSecond: z
    .number()
    .int()
    .min(0)
    .max(1024 * 1024)
    .default(64 * 1024),
  maxQueue: z.number().int().min(0).max(1000).default(32),
  maxConcurrent: z.number().int().min(1).max(1000).default(1),
  recovery: z
    .object({
      maxRestarts: z.number().int().min(1).max(100).default(3),
      baseDelayMs: z.number().int().min(1).max(300_000).default(250),
      maxDelayMs: z.number().int().min(1).max(300_000).default(10_000),
      resetAfterMs: z.number().int().min(1).max(86_400_000).default(60_000),
    })
    .strict()
    .refine((policy) => policy.maxDelayMs >= policy.baseDelayMs, {
      message: 'recovery.maxDelayMs must be at least baseDelayMs',
    })
    .optional(),
};

const WorkerSchema = z.discriminatedUnion('runtime', [
  z
    .object({
      ...workerFields,
      runtime: z.literal('node'),
      export: z.string().min(1).default('createWorker'),
    })
    .strict(),
  z
    .object({
      ...workerFields,
      runtime: z.literal('python'),
      export: z.string().min(1).default('create_worker'),
      executable: z
        .string()
        .min(1)
        .default(process.platform === 'win32' ? 'python' : 'python3'),
    })
    .strict(),
]);

export const ManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    name,
    version: z.string().min(1),
    workers: z.record(name, WorkerSchema),
    tools: z
      .array(
        z
          .object({
            name,
            description: z.string().optional(),
            ...binding,
            inputSchema: z
              .record(z.string(), z.unknown())
              .refine((schema) => schema.type === 'object', 'Input schema must have type object'),
          })
          .strict(),
      )
      .default([]),
    resources: z
      .array(
        z
          .object({
            name,
            uri: z.string().url(),
            description: z.string().optional(),
            mimeType: z.string().default('text/plain'),
            ...binding,
          })
          .strict(),
      )
      .default([]),
    prompts: z
      .array(
        z
          .object({
            name,
            description: z.string().optional(),
            ...binding,
            arguments: z
              .array(
                z
                  .object({
                    name,
                    description: z.string().optional(),
                    required: z.boolean().default(false),
                  })
                  .strict(),
              )
              .default([]),
          })
          .strict(),
      )
      .default([]),
  })
  .strict();

export async function loadProject(filename: string): Promise<LoadedProject> {
  try {
    const path = await realpath(filename);
    const root = dirname(path);
    const manifest = ManifestSchema.parse(JSON.parse(await readFile(path, 'utf8')));

    if (Object.keys(manifest.workers).length === 0)
      throw new Error('At least one worker is required');

    for (const category of ['tools', 'resources', 'prompts'] as const) {
      const names = new Set<string>();
      for (const capability of manifest[category]) {
        if (names.has(capability.name))
          throw new Error(`Duplicate ${category} name: ${capability.name}`);

        names.add(capability.name);

        if (!Object.hasOwn(manifest.workers, capability.worker))
          throw new Error(`Unknown worker: ${capability.worker}`);
      }
    }

    const uris = manifest.resources.map((resource) => resource.uri);

    if (new Set(uris).size !== uris.length) throw new Error('Duplicate resource URI');

    for (const prompt of manifest.prompts) {
      if (new Set(prompt.arguments.map((arg) => arg.name)).size !== prompt.arguments.length)
        throw new Error(`Duplicate prompt argument: ${prompt.name}`);
    }

    for (const tool of manifest.tools) validator.compile(tool.inputSchema);

    for (const worker of Object.values(manifest.workers)) {
      if (isAbsolute(worker.module))
        throw new Error('Worker modules must use project-relative paths');

      const module = await realpath(resolve(root, worker.module));
      const rel = relative(root, module);

      if (
        rel === '..' ||
        rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) ||
        isAbsolute(rel)
      ) {
        throw new Error('Worker module resolves outside the project');
      }

      worker.module = module;
      if (worker.runtime === 'python' && /[\\/]/.test(worker.executable)) {
        worker.executable = resolve(root, worker.executable);
      }
    }

    return { manifest, root };
  } catch (error) {
    throw new MCPackError(
      'INVALID_MANIFEST',
      error instanceof Error ? error.message : String(error),
    );
  }
}

export type Manifest = z.infer<typeof ManifestSchema>;
export type WorkerDefinition = Manifest['workers'][string];

export interface LoadedProject {
  manifest: Manifest;
  root: string;
}

export const validator = new Ajv2020({
  strict: true,
  allErrors: true,
  validateFormats: false,
});
