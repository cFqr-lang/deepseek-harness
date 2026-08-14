/**
 * Prompt bridge: discovers MCP prompts, surfaces each as a slash command, and
 * on invocation fills the prompt through `prompts/get` and steers its text
 * into the receiving agent. Prompts are server-defined parameterized message
 * templates, so the command is the human-facing entry (never a model tool):
 * the user types the command with JSON arguments and the filled prompt becomes
 * the next model turn.
 *
 * @module
 */

import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { PromptMessage } from '@modelcontextprotocol/sdk/types.js'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolBridgeOptions } from './tools.ts'

/** Disposers for registered prompt commands, keyed by command name. */
export type PromptDisposers = Map<string, () => void>

/** Lowercase a name segment to the command-name contract (`[a-z][a-z0-9_-]*`). */
function sanitizeCommandPart(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9-]/g, '-')
}

/** Command name for one prompt: `mcp-<server>-<prompt>`, lowercased and sanitized. */
function promptCommandName(serverName: string, promptName: string): string {
  return `mcp-${sanitizeCommandPart(serverName)}-${sanitizeCommandPart(promptName)}`
}

/** The model-facing text of one prompt message; non-text content degrades to a placeholder. */
function promptMessageText(message: PromptMessage): string {
  switch (message.content.type) {
    case 'text': return message.content.text
    case 'image': return '[image content]'
    case 'audio': return '[audio content]'
    default: return '[resource content]'
  }
}

/** Parse the command's JSON argument object into the string map `prompts/get` expects. */
function parsePromptArguments(rawInput: string): Record<string, string> | Error {
  const trimmed = rawInput.trim()
  if (trimmed === '') return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return new Error('prompt arguments must be valid JSON, e.g. {"file":"src/index.ts"}')
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Error('prompt arguments must be a JSON object, e.g. {"file":"src/index.ts"}')
  }
  const result: Record<string, string> = {}
  for (const [key, value] of Object.entries(parsed)) {
    if (typeof value !== 'string') {
      return new Error(`prompt argument "${key}" must be a string`)
    }
    result[key] = value
  }
  return result
}

/**
 * Sync the MCP server's prompt list into slash commands on the command
 * registry. Same two-phase swap as tools: discover (fetch) first, then
 * dispose the previous generation and register the new one. A command-name
 * collision (two prompts sanitizing to one name) skips the later prompt
 * rather than failing the whole sync.
 * @param commands - The command runtime; the caller has already established it is available.
 * @param client - Connected MCP Client used to list and fill prompts.
 * @param opts - Bridge options: server namespace and per-call timeout.
 * @param previous - Disposer map from the prior sync generation.
 * @returns The new prompt-command disposer map.
 */
export async function syncPrompts(
  commands: CommandRuntime,
  client: Client,
  opts: ToolBridgeOptions,
  previous: PromptDisposers,
): Promise<PromptDisposers> {
  // Phase 1: fetch the full prompt list.
  const prompts = new Map<string, string>()
  let cursor: string | undefined
  do {
    const response = await client.listPrompts(
      cursor === undefined ? {} : { cursor },
      { timeout: opts.connectTimeoutMs },
    )
    for (const prompt of response.prompts) {
      prompts.set(prompt.name, prompt.description ?? '')
    }
    cursor = response.nextCursor
  } while (cursor !== undefined)

  // Phase 2: swap generations.
  for (const dispose of previous.values()) dispose()
  const disposers: PromptDisposers = new Map()
  const usedNames = new Set<string>()
  for (const [promptName, promptDescription] of prompts) {
    const commandName = promptCommandName(opts.serverName, promptName)
    if (usedNames.has(commandName)) continue
    usedNames.add(commandName)
    const dispose = commands.register({
      name: commandName,
      description: promptDescription === ''
        ? `MCP prompt "${promptName}" from server ${opts.serverName}`
        : promptDescription,
      input: { hint: '[{"arg":"value",...}]' },
      handler: async ({ agent, rawInput, signal }) => {
        const args = parsePromptArguments(rawInput)
        if (args instanceof Error) return { kind: 'error', text: args.message }
        const result = await client.getPrompt(
          { name: promptName, ...Object.keys(args).length > 0 ? { arguments: args } : {} },
          { signal, timeout: opts.toolCallTimeoutMs },
        )
        const text = result.messages.map(promptMessageText).filter(part => part.length > 0).join('\n\n')
        agent.steer(createUserMessage({
          content: [{ type: 'text', text }],
          source: { kind: 'plugin', plugin: 'mcp-client' },
        }))
        return { kind: 'success', text: `Prompt "${promptName}" sent to the model.` }
      },
    })
    disposers.set(commandName, dispose)
  }
  return disposers
}
