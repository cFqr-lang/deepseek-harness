/**
 * Model-facing `set_reasoning_effort` tool: switch the current session's
 * reasoning effort (off / low / high) for subsequent requests. This lets the
 * agent adapt thinking strength per task — mechanical/batch work can run with
 * reasoning off, complex analysis with high — while `max` stays manual-only.
 *
 * The switch appends a `request/header` event, so it takes effect from the
 * next request in this session and never touches the global default or other
 * sessions.
 *
 * @module @deepseek-ai/dsh-tool-effort-switch
 */

import type { Context } from '@deepseek-ai/cordis'
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'

export const name = 'tool-effort-switch'
export const inject = ['tools', 'systemPrompt']

/** Automatic tiers only; `max` is intentionally excluded (manual-only). */
const EFFORT_LEVELS = ['off', 'low', 'high'] as const

/** System-prompt guidance making automatic effort switching the default. */
const EFFORT_GUIDANCE =
  '## 自动切换思考强度(默认执行)\n'
  + '你必须默认使用 set_reasoning_effort 工具自动切换 reasoning effort 以节省 token:\n'
  + '- 机械/批量/无推理任务(批量重命名、复制、格式化、简单替换)→ 先调 set_reasoning_effort 切 off\n'
  + '- 简单任务(单步操作、简单问答)→ 可切 low\n'
  + '- 复杂推理/架构/调试 → 保持或切 high\n'
  + '- 每个任务开始评估,切换后按下一个任务性质及时切换,不固定一个档位\n'
  + '- max 绝不自动切,只响应手动;切换只影响本会话后续请求,provider/model 不变'

export function apply(ctx: Context): void {
  ctx.systemPrompt.section({
    name: 'tool:effort-switch',
    order: 110,
    text: EFFORT_GUIDANCE,
  })
  ctx.tools.register(defineTool({
    name: 'set_reasoning_effort',
    description: 'Switch the current session\'s reasoning effort (thinking strength) for subsequent model requests. '
      + 'Use off for mechanical or batch tasks that need no reasoning, low for simple tasks, high for complex analysis or debugging. '
      + 'Takes effect from the next request in this session; provider and model are unchanged. '
      + 'max is manual-only and intentionally not offered here.',
    parameters: {
      effort: {
        type: 'string',
        required: true,
        enum: [...EFFORT_LEVELS],
        description: 'Target reasoning effort: off / low / high. max is not available here.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      const session = exec.agent?.session
      if (session === undefined) {
        throw new Error('no agent session available to switch reasoning effort')
      }
      const header = session.requestHeader()
      const config = header?.config
      if (config === undefined) {
        throw new Error('no request header available to switch reasoning effort')
      }
      session.append('request/header', {
        header: {
          config: { ...config, reasoningEffort: ReasoningEffortId(args.effort) },
          ...(header?.adapterDefaults === undefined ? {} : { adapterDefaults: header.adapterDefaults }),
        },
        reason: 'change',
      })
      return { text: `Reasoning effort set to "${args.effort}" for subsequent requests in this session.` }
    },
  }))
}
