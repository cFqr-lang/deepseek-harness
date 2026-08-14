/**
 * Recurring scheduled tasks: interval-based prompts that are steered into the
 * agent that created them, so a personal agent can run "every hour, check X"
 * without a human re-prompting.
 *
 * Storage is one JSON file at `$DSH_HOME/cron/tasks.json` (overridable via
 * `config.root`). Schedules are deliberately simple — `every <N>m` / `every
 * <N>h` — enough for reminders and periodic reports; a full cron-expression
 * grammar is a later refinement. The scheduler polls every 30s and only fires
 * while the Harness process is running.
 *
 * @module @deepseek-ai/dsh-cron
 */

import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { SessionId } from '@deepseek-ai/dsh-session'
// Side-effect type imports: declaration-merge `ctx.commands`/`ctx.agents`.
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-agent'

declare module '@deepseek-ai/cordis' {
  interface Context {
    cron: CronService
  }
}

/** Cordis service name. */
export const name = 'cron'

/** How often the scheduler wakes to check for due tasks. */
const CHECK_INTERVAL_MS = 30_000

/** One scheduled task. */
export interface CronTask {
  id: string
  /** Recurrence interval in milliseconds. */
  intervalMs: number
  prompt: string
  /** The agent id that created the task and receives its firings. */
  agentId: string
  /** Epoch ms of the last firing (or creation time, before the first). */
  lastRunAt: number
}

/** Plugin config. */
export interface Config {
  /** Tasks directory; defaults to `$DSH_HOME/cron`. */
  readonly root?: string
}

/** Parse `every <N>m` / `every <N>h` into milliseconds; undefined when malformed. */
function parseInterval(input: string | undefined): number | undefined {
  if (input === undefined) return undefined
  const match = /^every\s+(\d+)([mh])$/.exec(input)
  if (match === null) return undefined
  const amount = Number(match[1])
  return match[2] === 'm' ? amount * 60_000 : amount * 3_600_000
}

/** Human-readable recurrence for a task (assumes a whole-minute/hour interval). */
function renderInterval(intervalMs: number): string {
  if (intervalMs % 3_600_000 === 0) return `every ${intervalMs / 3_600_000}h`
  return `every ${intervalMs / 60_000}m`
}

/**
 * Recurring-task scheduler. Owns a JSON task file, polls it on an interval,
 * and steers each due task's prompt into the agent that scheduled it.
 */
export class CronService extends Service {
  static Config: z<Config> = z.object({
    root: z.string(),
  })

  /** The tasks directory, resolved once at construction. */
  readonly root: string
  private readonly tasksFile: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'cron')
    this.root = config.root ?? dshHomePath('cron')
    mkdirSync(this.root, { recursive: true })
    this.tasksFile = join(this.root, 'tasks.json')

    // Poll for due tasks; unref so the scheduler never keeps the process alive
    // on its own (the Web server does that while running).
    ctx.effect(() => {
      const handle = setInterval(() => { this.checkDue() }, CHECK_INTERVAL_MS)
      handle.unref()
      return () => clearInterval(handle)
    }, 'cron.scheduler')

    // The /cron command: the human-facing write/read path.
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        name: 'cron',
        description: 'schedule a recurring task (every Nm / every Nh)',
        input: { hint: 'add <every Nm|Nh> <prompt> | list | remove <n>' },
        recordInput: false,
        handler: ({ agent, rawInput }) => {
          const parts = rawInput.trim().split(/\s+/)
          const sub = parts[0]
          if (sub === 'list') return { kind: 'success', text: this.renderList() }
          if (sub === 'remove') {
            const index = Number(parts[1]) - 1
            const tasks = this.loadTasks()
            const task = tasks[index]
            if (task === undefined) return { kind: 'error', text: `No scheduled task at index ${parts[1]}` }
            this.saveTasks(tasks.filter((_, i) => i !== index))
            return { kind: 'success', text: `Removed: ${task.prompt}` }
          }
          if (sub === 'add') {
            const intervalMs = parseInterval(parts[1])
            const prompt = parts.slice(2).join(' ')
            if (intervalMs === undefined || prompt === '') {
              return { kind: 'error', text: 'Usage: /cron add <every Nm|Nh> <prompt>' }
            }
            const tasks = this.loadTasks()
            tasks.push({ id: randomUUID(), intervalMs, prompt, agentId: agent.id, lastRunAt: Date.now() })
            this.saveTasks(tasks)
            return { kind: 'success', text: `Scheduled ${renderInterval(intervalMs)}: ${prompt}` }
          }
          return { kind: 'error', text: 'Usage: /cron add <every Nm|Nh> <prompt> | list | remove <n>' }
        },
      })
    })
  }

  /** Load tasks, tolerating a missing or malformed file as an empty list. */
  private loadTasks(): CronTask[] {
    if (!existsSync(this.tasksFile)) return []
    try {
      const parsed = JSON.parse(readFileSync(this.tasksFile, 'utf8'))
      return Array.isArray(parsed) ? parsed as CronTask[] : []
    } catch {
      return []
    }
  }

  /** Persist the full task list. */
  private saveTasks(tasks: CronTask[]): void {
    writeFileSync(this.tasksFile, JSON.stringify(tasks, null, 2) + '\n')
  }

  private renderList(): string {
    const tasks = this.loadTasks()
    if (tasks.length === 0) return 'No scheduled tasks.'
    return tasks.map((task, i) => `${i + 1}. ${renderInterval(task.intervalMs)} — ${task.prompt}`).join('\n')
  }

  /** Fire every due task: steer its prompt into its owning agent (if still live). */
  private checkDue(): void {
    const now = Date.now()
    const tasks = this.loadTasks()
    for (const task of tasks) {
      if (now - task.lastRunAt < task.intervalMs) continue
      const agent = this.ctx.agents.get(task.agentId as SessionId)
      if (agent !== undefined) {
        agent.steer(createUserMessage({
          content: [{ type: 'text', text: `[scheduled task] ${task.prompt}` }],
          source: { kind: 'plugin', plugin: 'cron' },
        }))
      }
      // Advance lastRunAt whether or not the agent is still live, so a dead
      // agent's task does not fire in a burst the moment it comes back.
      task.lastRunAt = now
    }
    this.saveTasks(tasks)
  }
}

export default CronService
