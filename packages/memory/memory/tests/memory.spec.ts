import { describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import MemoryService from '../src/index.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-memory-'))
}

async function setup(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(MemoryService, { root })
  return ctx
}

describe('MemoryService', () => {
  it('renders empty output when there are no memories', async () => {
    const ctx = await setup(tempDir())
    expect(ctx.memory.render()).toBe('')
  })

  it('remember writes a timestamped markdown file and returns its name', async () => {
    const root = tempDir()
    const ctx = await setup(root)
    const file = ctx.memory.remember('the user prefers tabs')
    expect(file).toMatch(/^memory-.+\.md$/)
    expect(readdirSync(root).filter(name => name.endsWith('.md'))).toEqual([file])
    expect(readFileSync(join(root, file), 'utf8')).toBe('the user prefers tabs\n')
  })

  it('render joins memories in filename order and skips empty bodies', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'b.md'), 'second\n')
    writeFileSync(join(root, 'a.md'), 'first\n')
    writeFileSync(join(root, 'empty.md'), '   \n')
    const ctx = await setup(root)
    expect(ctx.memory.render()).toBe('## Persistent memory\n\nfirst\n\n---\n\nsecond')
  })

  it('renders a single memory without a separator', async () => {
    const root = tempDir()
    writeFileSync(join(root, 'only.md'), 'one fact\n')
    const ctx = await setup(root)
    expect(ctx.memory.render()).toBe('## Persistent memory\n\none fact')
  })
})
