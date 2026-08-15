import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import ProfileService from '../src/index.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-profile-'))
}

async function setup(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(ProfileService, { root })
  return ctx
}

describe('ProfileService', () => {
  it('renders empty output when no profile exists', async () => {
    const ctx = await setup(tempDir())
    expect(ctx.profile.render()).toBe('')
    expect(ctx.profile.exists()).toBe(false)
    expect(ctx.profile.read()).toBe('')
  })

  it('update writes the profile file and read returns it', async () => {
    const root = tempDir()
    const ctx = await setup(root)
    ctx.profile.update('# 用户画像\n\n## 身份\n- 开发者')
    expect(ctx.profile.read()).toBe('# 用户画像\n\n## 身份\n- 开发者\n')
    expect(readFileSync(join(root, 'profile.md'), 'utf8')).toBe('# 用户画像\n\n## 身份\n- 开发者\n')
    expect(ctx.profile.exists()).toBe(true)
  })

  it('render wraps a non-empty profile with a heading', async () => {
    const ctx = await setup(tempDir())
    ctx.profile.update('# 用户画像\n\n## 身份\n- 开发者')
    expect(ctx.profile.render()).toBe('## User profile\n\n# 用户画像\n\n## 身份\n- 开发者')
  })

  it('update overwrites previous content', async () => {
    const ctx = await setup(tempDir())
    ctx.profile.update('first')
    ctx.profile.update('second')
    expect(ctx.profile.read()).toBe('second\n')
  })
})
