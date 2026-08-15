import { describe, expect, it } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { Context } from '@deepseek-ai/cordis'
import SkillLearnService from '../src/index.ts'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'dsh-skill-learn-'))
}

async function setup(root: string): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SkillLearnService, { root })
  return ctx
}

describe('SkillLearnService.writeSkill', () => {
  it('writes a skill with frontmatter and body', async () => {
    const root = tempDir()
    const ctx = await setup(root)
    const file = ctx.skillLearn.writeSkill('deploy-website', 'Deploy the site', 'step one\nstep two')
    expect(file).toBe('deploy-website.md')
    expect(readFileSync(join(root, file), 'utf8')).toBe(
      '---\nname: deploy-website\ndescription: "Deploy the site"\n---\nstep one\nstep two\n',
    )
  })

  it('writes a stub skill without a body when content is empty', async () => {
    const root = tempDir()
    const ctx = await setup(root)
    ctx.skillLearn.writeSkill('stub', 'A stub', '')
    expect(readFileSync(join(root, 'stub.md'), 'utf8')).toBe(
      '---\nname: stub\ndescription: "A stub"\n---',
    )
  })

  it('escapes double quotes in the description', async () => {
    const root = tempDir()
    const ctx = await setup(root)
    ctx.skillLearn.writeSkill('quoted', 'say "hi"', '')
    expect(readFileSync(join(root, 'quoted.md'), 'utf8')).toBe(
      '---\nname: quoted\ndescription: "say \\"hi\\""\n---',
    )
  })
})
