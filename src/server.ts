import { Server, ProtocolError } from '@modelcontextprotocol/server';
import type { JsonObject } from './contracts.js';
import { MCPackRuntime } from './runtime.js';
import { MCPackError } from './errors.js';

async function invoke<T>(operation: () => Promise<T>): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!(error instanceof MCPackError))
      throw new ProtocolError(-32603, 'Internal MCPack error');

    const invalid = ['INVALID_ARGUMENTS', 'NOT_FOUND'].includes(error.code);
    throw new ProtocolError(invalid ? -32602 : -32603, error.message, { mcpackCode: error.code });
  }
}

/** Transport-neutral SDK server. The caller owns runtime startup and shutdown. */
export function createMcpServer(runtime: MCPackRuntime): Server {
  const manifest = runtime.project.manifest;
  const server = new Server(
    { name: manifest.name, version: manifest.version },
    {
      capabilities: { tools: {}, resources: {}, prompts: {} },
    },
  );

  server.setRequestHandler('tools/list', async () => ({
    tools: manifest.tools.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: { ...tool.inputSchema, type: 'object' as const },
    })),
  }));

  server.setRequestHandler('resources/list', async () => ({
    resources: manifest.resources.map((resource) => ({
      name: resource.name,
      uri: resource.uri,
      description: resource.description,
      mimeType: resource.mimeType,
    })),
  }));

  server.setRequestHandler('resources/templates/list', async () => ({ resourceTemplates: [] }));

  server.setRequestHandler('prompts/list', async () => ({
    prompts: manifest.prompts.map((prompt) => ({
      name: prompt.name,
      description: prompt.description,
      arguments: prompt.arguments,
    })),
  }));

  server.setRequestHandler('tools/call', (request, context) =>
    invoke(async () => ({
      ...(await runtime.callTool(
        request.params.name,
        (request.params.arguments ?? {}) as JsonObject,
        context.mcpReq.signal,
      )),
    })),
  );

  server.setRequestHandler('resources/read', (request, context) =>
    invoke(async () => ({
      ...(await runtime.readResource(request.params.uri, context.mcpReq.signal)),
    })),
  );

  server.setRequestHandler('prompts/get', (request, context) =>
    invoke(async () => ({
      ...(await runtime.getPrompt(
        request.params.name,
        request.params.arguments,
        context.mcpReq.signal,
      )),
    })),
  );

  return server;
}
