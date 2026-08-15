import { describe, expect, it } from 'vitest'
import { mkdtempSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import CronService, { parseInterval, renderInterval } from '../src/index.ts'

describe('parseInterval', () => {
  it('parses minute and hour intervals into milliseconds', () => {
    expect(parseInterval('every 5m')).toBe(5 * 60_000)
    expect(parseInterval('every 1h')).toBe(3_600_000)
    expect(parseInterval('every 24h')).toBe(24 * 3_600_000)
  })

  it('returns undefined for malformed input', () => {
    expect(parseInterval(undefined)).toBeUndefined()
    expect(parseInterval('daily')).toBeUndefined()
    expect(parseInterval('5m')).toBeUndefined()
    expect(parseInterval('every 5')).toBeUndefined()
    expect(parseInterval('every m')).toBeUndefined()
    expect(parseInterval('every 5d')).toBeUndefined()
    expect(parseInterval('every 5m extra')).toBeUndefined()
  })
})

describe('renderInterval', () => {
  it('renders whole hours', () => {
    expect(renderInterval(3_600_000)).toBe('every 1h')
    expect(renderInterval(7_200_000)).toBe('every 2h')
  })

  it('renders minutes otherwise', () => {
    expect(renderInterval(60_000)).toBe('every 1m')
    expect(renderInterval(120_000)).toBe('every 2m')
  })
})

describe('CronService', () => {
  it('resolves its root directory', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cron-'))
    const ctx = new Context()
    await ctx.plugin(CronService, { root })
    expect(ctx.cron.root).toBe(root)
  })
})
