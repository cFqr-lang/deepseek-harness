import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import CuratorService, { extractJson } from '../src/index.ts'

describe('extractJson', () => {
  it('parses a bare JSON object', () => {
    expect(extractJson('{"memories":["prefers tabs"]}')).toEqual({ memories: ['prefers tabs'] })
  })

  it('extracts JSON from a markdown fence with or without a language tag', () => {
    expect(extractJson('```json\n{"memories":[]}\n```')).toEqual({ memories: [] })
    expect(extractJson('```\n{"skills":[]}\n```')).toEqual({ skills: [] })
  })

  it('extracts the JSON object from surrounding prose', () => {
    expect(extractJson('Sure! Here you go: {"memories":[],"skills":[]} hope this helps'))
      .toEqual({ memories: [], skills: [] })
  })

  it('handles nested objects', () => {
    expect(extractJson('{"memories":["a"],"skills":[{"name":"x"}]}'))
      .toEqual({ memories: ['a'], skills: [{ name: 'x' }] })
  })

  it('returns undefined when there is no JSON object', () => {
    expect(extractJson('')).toBeUndefined()
    expect(extractJson('no json here')).toBeUndefined()
    expect(extractJson('[1, 2, 3]')).toBeUndefined()
  })

  it('returns undefined for malformed JSON', () => {
    expect(extractJson('{"memories": ')).toBeUndefined()
    expect(extractJson('{not json}')).toBeUndefined()
  })
})

describe('CuratorService config', () => {
  it('rejects an idleMinutes below one', async () => {
    const ctx = new Context()
    await expect(ctx.plugin(CuratorService, { idleMinutes: 0 })).rejects.toThrow()
  })
})
