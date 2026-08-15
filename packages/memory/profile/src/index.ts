/**
 * Cross-session user profile: a single structured markdown document that
 * distills what the agent has learned about the user (identity, preferences,
 * goals, stack, working style) plus the agent's own persona, updated
 * dialectically over time. Injected into every system prompt at the highest
 * priority, above both memory and the harness identity.
 *
 * The document is plain markdown so a human can edit it directly. The
 * `profile_view` / `profile_update` tools are the direct read/write paths;
 * dialectic merging (old profile + new observations -> updated profile) is
 * done by the curator's background reflection, not here, so this package stays
 * a dumb store.
 *
 * @module @deepseek-ai/dsh-profile
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
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
    profile: ProfileService
  }
}

/** Cordis service name used by loader diagnostics. */
export const name = 'profile'

/** Prompt-section order: highest priority, before memory (-50) and the persona (0). */
const PROFILE_SECTION_ORDER = -100

/** Plugin config. */
export interface Config {
  /** Profile directory; defaults to `$DSH_HOME/profile`. */
  readonly root?: string
}

/**
 * Cross-session user profile service. Owns a single `profile.md`, renders it
 * into the system prompt, and exposes `profile_view` / `profile_update` tools
 * plus a `/profile` command as the direct read/write paths.
 */
export class ProfileService extends Service {
  static Config: z<Config> = z.object({
    root: z.string(),
  })

  /** The profile directory, resolved once at construction. */
  readonly root: string
  /** The single profile file inside {@link root}. */
  readonly file: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'profile')
    this.root = config.root ?? dshHomePath('profile')
    this.file = join(this.root, 'profile.md')
    mkdirSync(this.root, { recursive: true })

    // Inject the profile at the highest priority so it frames every request.
    ctx.inject(['systemPrompt'], (scope) => {
      scope.systemPrompt.section({
        name: 'profile',
        order: PROFILE_SECTION_ORDER,
        text: () => this.render(),
      })
    })

    // The /profile command: a human-facing read path.
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        name: 'profile',
        description: 'show the current user profile',
        input: { hint: '' },
        recordInput: false,
        handler: () => {
          const body = this.render()
          if (body === '') return { kind: 'success', text: '(no profile yet)' }
          return { kind: 'success', text: body }
        },
      })
    })

    // The profile_view tool: lets the model read the current profile.
    ctx.inject(['tools'], (scope) => {
      scope.tools.register({
        name: 'profile_view',
        description: 'Read the current user profile (identity, preferences, goals, stack, working style, agent persona).',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { profile: { type: 'string' } }, required: ['profile'] },
          render: (_args, value) => {
            const profile = (value as { profile: string }).profile
            return [{ type: 'text', text: profile.trim() === '' ? '(no profile yet)' : profile }]
          },
        },
        execute: async () => ({ profile: this.read() }),
      })

      // The profile_update tool: lets the model replace the profile directly.
      scope.tools.register({
        name: 'profile_update',
        description: 'Replace the user profile with new content (a structured markdown document).',
        parameters: {
          type: 'object',
          properties: { content: { type: 'string', description: 'The full replacement profile as markdown.' } },
          required: ['content'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { saved: { type: 'string' } }, required: ['saved'] },
          render: () => [{ type: 'text', text: 'Profile updated.' }],
        },
        execute: async (args) => {
          const { content } = (args ?? {}) as { content?: unknown }
          if (typeof content !== 'string' || content.trim() === '') {
            throw new Error('profile_update requires a non-empty "content" string')
          }
          this.update(content.trim())
          return { saved: this.file }
        },
      })
    })
  }

  /** Read the raw profile text, or '' when the file does not exist. */
  read(): string {
    if (!existsSync(this.file)) return ''
    return readFileSync(this.file, 'utf8')
  }

  /** Render the profile into one prompt body, or '' when there is none. */
  render(): string {
    const body = this.read().trim()
    if (body === '') return ''
    return `## User profile\n\n${body}`
  }

  /** True when a non-empty profile already exists. */
  exists(): boolean {
    return this.read().trim() !== ''
  }

  /** Overwrite the profile with new content. */
  update(text: string): void {
    writeFileSync(this.file, `${text}\n`)
  }
}

export default ProfileService
