import type { JsonObject, ToolResult, ResourceResult, PromptResult } from './contracts.js';
import { loadProject, validator, type LoadedProject } from './manifest.js';
import type { Diagnostic } from './process-worker.js';
import { WorkerSupervisor } from './worker-supervisor.js';
import { MCPackError } from './errors.js';
import { toolResult, resourceResult, promptResult } from './wire.js';

export class MCPackRuntime {
  private workers = new Map<string, WorkerSupervisor>();
  private state: 'new' | 'starting' | 'ready' | 'closed' = 'new';
  private starting?: Promise<void>;
  private closing?: Promise<void>;

  private constructor(
    readonly project: LoadedProject,
    diagnostic: Diagnostic,
  ) {
    for (const [id, definition] of Object.entries(project.manifest.workers)) {
      this.workers.set(id, new WorkerSupervisor(id, definition, project, diagnostic));
    }
  }

  static async load(
    path: string,
    options: { diagnostic?: Diagnostic } = {},
  ): Promise<MCPackRuntime> {
    return new MCPackRuntime(await loadProject(path), options.diagnostic ?? (() => {}));
  }

  start(): Promise<void> {
    if (this.state === 'closed')
      return Promise.reject(new MCPackError('RUNTIME_CLOSED', 'Runtime closed'));

    if (this.starting) return this.starting;

    this.state = 'starting';
    this.starting = (async () => {
      try {
        await Promise.all([...this.workers.values()].map((worker) => worker.start()));
        if (this.state === 'closed')
          throw new MCPackError('RUNTIME_CLOSED', 'Runtime closed during startup');

        this.state = 'ready';
      } catch (error) {
        await this.close();
        throw error;
      }
    })();

    return this.starting;
  }

  close(): Promise<void> {
    this.state = 'closed';
    return (this.closing ??= Promise.all(
      [...this.workers.values()].map((worker) => worker.close()),
    ).then(() => {}));
  }

  health() {
    const workers = Object.fromEntries(
      [...this.workers].map(([id, worker]) => [id, worker.snapshot()]),
    );
    return {
      state: this.state,
      ready:
        this.state === 'ready' &&
        Object.values(workers).every((worker) => worker.state === 'ready'),
      workers,
    };
  }

  private worker(id: string): WorkerSupervisor {
    if (this.state !== 'ready')
      throw new MCPackError(
        this.state === 'closed' ? 'RUNTIME_CLOSED' : 'WORKER_UNAVAILABLE',
        'Runtime is not ready',
      );

    return this.workers.get(id)!;
  }

  async callTool(name: string, args: JsonObject = {}, signal?: AbortSignal): Promise<ToolResult> {
    const tool = this.project.manifest.tools.find((item) => item.name === name);

    if (!tool) throw new MCPackError('NOT_FOUND', `Unknown tool: ${name}`);
    if (!validator.validate(tool.inputSchema, args))
      throw new MCPackError('INVALID_ARGUMENTS', 'Tool arguments do not match inputSchema');

    const result = toolResult.safeParse(
      await this.worker(tool.worker).call('tools', tool.handler, args, signal),
    );

    if (!result.success) throw new MCPackError('INVALID_RESULT', 'Tool returned an invalid result');

    return result.data;
  }

  async readResource(uri: string, signal?: AbortSignal): Promise<ResourceResult> {
    const resource = this.project.manifest.resources.find((item) => item.uri === uri);

    if (!resource) throw new MCPackError('NOT_FOUND', `Unknown resource: ${uri}`);

    const result = resourceResult.safeParse(
      await this.worker(resource.worker).call('resources', resource.handler, { uri }, signal),
    );

    if (!result.success || result.data.contents.some((item) => item.uri !== uri))
      throw new MCPackError('INVALID_RESULT', 'Resource returned an invalid result or URI');

    return result.data;
  }

  async getPrompt(
    name: string,
    args: Record<string, string> = {},
    signal?: AbortSignal,
  ): Promise<PromptResult> {
    const prompt = this.project.manifest.prompts.find((item) => item.name === name);
    if (!prompt) throw new MCPackError('NOT_FOUND', `Unknown prompt: ${name}`);

    if (
      Object.entries(args).some(
        ([key, value]) =>
          typeof value !== 'string' || !prompt.arguments.some((arg) => arg.name === key),
      ) ||
      prompt.arguments.some((arg) => arg.required && !Object.hasOwn(args, arg.name))
    )
      throw new MCPackError('INVALID_ARGUMENTS', 'Invalid prompt arguments');

    const result = promptResult.safeParse(
      await this.worker(prompt.worker).call('prompts', prompt.handler, args, signal),
    );

    if (!result.success)
      throw new MCPackError('INVALID_RESULT', 'Prompt returned an invalid result');

    return result.data;
  }
}
