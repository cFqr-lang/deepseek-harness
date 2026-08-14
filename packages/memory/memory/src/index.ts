/**
 * Cross-session persistent memory: a user-level, human-editable store of
 * facts and preferences that survives across sessions, injected into every
 * system prompt so the agent carries what it has learned about the user.
 *
 * Storage is file-based and mirrors the skill-filesystem discovery pattern:
 * one markdown file per memory under `$DSH_HOME/memory` (overridable via
 * `config.root`). Files are plain text so a user can edit them directly, and
 * the `/remember` command + `remember` tool append new memories at runtime.
 *
 * Retrieval is deliberately "inject everything" for now — personal memory is
 * expected to stay small (dozens of notes). A DB + FTS5 retrieval backend is
 * the deferred scale-up path, not this module's concern.
 *
 * @module @deepseek-ai/dsh-memory
 */

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Side-effect type imports: declaration-merge `ctx.systemPrompt`/`ctx.tools`/`ctx.commands`.
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/cordis' {
  interface Context {
    memory: MemoryService
  }
}

/** Cordis service name used by loader diagnostics. */
export const name = 'memory'

/** Prompt-section order: before the persona (`0`), after the harness identity (`-100`). */
const MEMORY_SECTION_ORDER = -50

/** Plugin config. */
export interface Config {
  /** Memory directory; defaults to `$DSH_HOME/memory`. */
  readonly root?: string
}

/**
 * Cross-session persistent memory service. Owns a directory of markdown
 * memories, renders them into the system prompt, and exposes a `/remember`
 * command plus a `remember` tool as the write paths.
 */
export class MemoryService extends Service {
  static Config: z<Config> = z.object({
    root: z.string(),
  })

  /** The memory directory, resolved once at construction. */
  readonly root: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'memory')
    this.root = config.root ?? dshHomePath('memory')
    mkdirSync(this.root, { recursive: true })

    // Inject every memory into the system prompt on each assembly.
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'persistent-memory',
        order: MEMORY_SECTION_ORDER,
        text: () => this.render(),
      })
    })

    // The /remember command: a human-facing write path.
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        name: 'remember',
        description: 'save a persistent memory available in every future session',
        input: { hint: '<text>' },
        recordInput: false,
        handler: ({ rawInput }) => {
          const text = rawInput.trim()
          if (text === '') return { kind: 'error', text: 'Usage: /remember <text>' }
          const file = this.remember(text)
          return { kind: 'success', text: `Remembered: ${file}` }
        },
      })
    })

    // The remember tool: lets the model persist a fact or preference itself.
    ctx.inject(['tools'], (scope) => {
      scope.tools.register({
        name: 'remember',
        description: 'Save a persistent memory (a user fact or preference) available in all future sessions.',
        parameters: {
          type: 'object',
          properties: { text: { type: 'string', description: 'The fact or preference to remember, in one or two sentences.' } },
          required: ['text'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { saved: { type: 'string' } }, required: ['saved'] },
          render: () => [{ type: 'text', text: 'Memory saved.' }],
        },
        execute: async (args) => {
          const { text } = (args ?? {}) as { text?: unknown }
          if (typeof text !== 'string' || text.trim().length === 0) {
            throw new Error('remember requires a non-empty "text" string argument')
          }
          const file = this.remember(text.trim())
          return { saved: file }
        },
      })
    })
  }

  /** Render every memory into one prompt body, or '' when there are none. */
  render(): string {
    const files = this.listFiles()
    const bodies = files
      .map(file => readFileSync(join(this.root, file), 'utf8').trim())
      .filter(body => body.length > 0)
    if (bodies.length === 0) return ''
    return `## Persistent memory\n\n${bodies.join('\n\n---\n\n')}`
  }

  /** Append one memory as a new timestamped markdown file; returns its filename. */
  remember(text: string): string {
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const file = `memory-${stamp}.md`
    writeFileSync(join(this.root, file), `${text}\n`)
    return file
  }

  /** Markdown memory files, sorted for a stable prompt order. */
  private listFiles(): string[] {
    return readdirSync(this.root).filter(file => file.endsWith('.md')).sort()
  }
}

export default MemoryService
