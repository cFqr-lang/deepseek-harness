/**
 * Self-evolution curator: periodically reflects on the conversation and
 * persists what it learned, as a BACKGROUND one-shot LLM call that never
 * touches the main conversation (mirrors the compaction summarizer's auxiliary
 * `ctx.llm.stream()` path).
 *
 * Trigger is the `turn/end` session event, debounced so a reflection fires only
 * every `reflectEvery` turns per session. The reflection replays the session's
 * derived messages, appends a reflection instruction as the final user message,
 * streams one model turn, and saves the resulting note through `ctx.memory`.
 *
 * @module @deepseek-ai/dsh-curator
 */

import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { BlockAssembler, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContentBlock, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type imports: declaration-merge `ctx.agents`/`ctx.llm`/`ctx.memory`.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-memory'
import type {} from '@deepseek-ai/dsh-profile'
import type {} from '@deepseek-ai/dsh-skill-learn'

declare module '@deepseek-ai/cordis' {
  interface Context {
    curator: CuratorService
  }
}

/** Cordis service name. */
export const name = 'curator'

/** The reflection instruction appended as the final message of the auxiliary call. */
const REFLECT_PROMPT =
  'Reflect on the conversation above. Output a single JSON object (and nothing else) of the form '
  + '{"memories": ["a fact or preference about the user worth remembering", ...], '
  + '"skills": [{"name": "class-level-slug", "description": "one line", "content": "step-by-step instructions"}, ...], '
  + '"profile": "the full updated user profile as markdown"}. '
  + 'Use [] for an empty array and "" for an unchanged profile. If nothing is worth saving, output {"memories": [], "skills": [], "profile": ""}.'

/** Extract the first JSON object from a model reply, tolerating markdown fences and surrounding prose. */
export function extractJson(text: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start === -1 || end === -1 || end <= start) return undefined
  try {
    return JSON.parse(candidate.slice(start, end + 1))
  } catch {
    return undefined
  }
}

/** Plugin config. */
export interface Config {
  /** Whether periodic reflection is on (default true). */
  readonly enabled?: boolean
  /** Reflect after this many minutes of inactivity (default 30). */
  readonly idleMinutes?: number
}

/**
 * The self-evolution curator: reflects in the background after the agent has
 * been idle for `idleMinutes`, so it never interrupts active work.
 */
export class CuratorService extends Service {
  static Config: z<Config> = z.object({
    enabled: z.boolean().default(true),
    idleMinutes: z.number().min(1).default(30),
  })

  private static readonly CHECK_INTERVAL_MS = 60_000

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'curator')
    const idleMinutes = config.idleMinutes ?? 30
    let lastTurnEndAt = Date.now()
    let lastAgentId: SessionId | undefined

    ctx.on('session/event', (session, event) => {
      if (event.type !== 'turn/end') return
      lastTurnEndAt = Date.now()
      lastAgentId = session.id
    }, { global: true })

    ctx.effect(() => {
      const handle = setInterval(() => {
        if (config.enabled === false) return
        if (lastAgentId === undefined) return
        if (Date.now() - lastTurnEndAt < idleMinutes * 60_000) return
        const agent = ctx.get('agents')?.get(lastAgentId)
        if (agent === undefined) return
        // Fire once per idle window: advance the clock so we do not re-fire until the next turn.
        lastTurnEndAt = Date.now()
        void this.reflect(agent)
      }, CuratorService.CHECK_INTERVAL_MS)
      handle.unref()
      return () => clearInterval(handle)
    }, 'curator.scheduler')
  }

  /** Resolve the provider/model to reflect with, from agent options or the last routed request. */
  private resolveTarget(agent: Agent): { provider: string; model: string } | undefined {
    const options = agent.options
    if (options.provider !== undefined && options.provider.length > 0
      && options.model !== undefined && options.model.length > 0) {
      return { provider: options.provider, model: options.model }
    }
    const latest = agent.session.requestHeader()?.config
    if (latest !== undefined && latest.provider !== undefined && latest.model !== undefined) {
      return { provider: latest.provider, model: latest.model }
    }
    return undefined
  }

  /** Persist a parsed reflection: write each memory and each skill (best-effort). */
  private applyReflection(parsed: unknown): void {
    if (typeof parsed !== 'object' || parsed === null) return
    const { memories, skills, profile } = parsed as { memories?: unknown; skills?: unknown; profile?: unknown }
    if (Array.isArray(memories)) {
      for (const memory of memories) {
        if (typeof memory === 'string' && memory.trim() !== '') {
          this.ctx.get('memory')?.remember(memory.trim())
        }
      }
    }
    if (Array.isArray(skills)) {
      for (const skill of skills) {
        if (typeof skill !== 'object' || skill === null) continue
        const { name, description, content } = skill as { name?: unknown; description?: unknown; content?: unknown }
        if (typeof name === 'string' && typeof description === 'string' && typeof content === 'string'
          && name !== '' && description !== '' && content !== '') {
          this.ctx.get('skillLearn')?.writeSkill(name, description, content)
        }
      }
    }
    if (typeof profile === 'string' && profile.trim() !== '') {
      this.ctx.get('profile')?.update(profile.trim())
    }
  }

  /** Run one background reflection and persist its structured output (best-effort). */
  private async reflect(agent: Agent): Promise<void> {
    try {
      const target = this.resolveTarget(agent)
      if (target === undefined) return
      const assembler = new BlockAssembler()
      const existingProfile = this.ctx.get('profile')?.read().trim() ?? ''
      const profileHint = existingProfile === ''
        ? 'No user profile exists yet; create one from the conversation, organized under these headings: 身份 / 偏好 / 目标 / 技术栈 / 协作方式 / Agent 人格.'
        : `Current user profile:\n${existingProfile}\n\nMerge the conversation's new observations into it dialectically — keep what holds, refine what changed, resolve contradictions, drop nothing important.`
      const messages: Message[] = [
        ...agent.session.deriveMessages(),
        createUserMessage({
          content: [{ type: 'text', text: `${profileHint}\n\n${REFLECT_PROMPT}` }],
          source: { kind: 'plugin', plugin: 'curator' },
        }),
      ]
      const options: GenerateOptions = {
        provider: target.provider,
        model: target.model,
        messages,
        sessionId: agent.session.id,
      }
      const llm = this.ctx.get('llm')
      if (llm === undefined) return
      for await (const chunk of llm.stream(options)) assembler.push(chunk)
      if (assembler.finish.kind === 'error' || assembler.finish.kind === 'aborted') return
      const text = assembler.blocks()
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map(block => block.text)
        .join('\n')
        .trim()
      const parsed = extractJson(text)
      if (parsed === undefined) return
      this.applyReflection(parsed)
    } catch (error) {
      this.ctx.logger.warn(`curator: background reflection failed: ${String(error)}`)
    }
  }
}

export default CuratorService
