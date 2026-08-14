/**
 * Skill authoring: the write half of the skill system. `skill-filesystem`
 * discovers skills from the user root; this package lets a human (`/learn`) or
 * the model (`learn` tool) create one there, so reusable procedural knowledge
 * ("how to do X") accumulates across sessions without hand-editing files.
 *
 * @module @deepseek-ai/dsh-skill-learn
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
// Side-effect type imports: declaration-merge `ctx.tools`/`ctx.commands`.
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-commands'

declare module '@deepseek-ai/cordis' {
  interface Context {
    skillLearn: SkillLearnService
  }
}

/** Cordis service name. */
export const name = 'skill-learn'

/** Skill-name slug: lowercase letters, digits, dashes. */
const NAME_PATTERN = /^[a-z0-9-]{1,64}$/

/** Plugin config. */
export interface Config {
  /** Skills directory; defaults to `$DSH_HOME/skills`. */
  readonly root?: string
}

/** Quote a string for a single-line YAML double-quoted scalar. */
function yamlString(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

/**
 * Skill authoring service: writes one markdown skill file (YAML frontmatter +
 * body) into the user skill root.
 */
export class SkillLearnService extends Service {
  static Config: z<Config> = z.object({
    root: z.string(),
  })

  /** The skills directory, resolved once at construction. */
  readonly root: string

  constructor(ctx: Context, public config: Config) {
    super(ctx, 'skill-learn')
    this.root = config.root ?? dshHomePath('skills')
    mkdirSync(this.root, { recursive: true })

    // The learn tool: lets the model persist a complete procedural skill.
    ctx.inject(['tools'], (scope) => {
      scope.tools.register({
        name: 'learn',
        description: 'Save a reusable procedural skill (how to do something) as a skill file available in future sessions.',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: 'Skill name as a lowercase slug, e.g. "deploy-website".' },
            description: { type: 'string', description: 'One-line summary of when/why to use this skill.' },
            content: { type: 'string', description: 'The step-by-step instructions (the skill body).' },
          },
          required: ['name', 'description', 'content'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { saved: { type: 'string' } }, required: ['saved'] },
          render: () => [{ type: 'text', text: 'Skill saved.' }],
        },
        execute: async (args) => {
          const { name, description, content } = (args ?? {}) as { name?: unknown; description?: unknown; content?: unknown }
          if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
            throw new Error('learn requires a "name" matching [a-z0-9-] (max 64 chars)')
          }
          if (typeof description !== 'string' || description.trim() === '') {
            throw new Error('learn requires a non-empty "description"')
          }
          if (typeof content !== 'string' || content.trim() === '') {
            throw new Error('learn requires a non-empty "content"')
          }
          return { saved: this.writeSkill(name, description.trim(), content.trim()) }
        },
      })

      scope.tools.register({
        name: 'skills_list',
        description: 'List the names of all skills in the user skill library.',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { skills: { type: 'array', items: { type: 'string' } } }, required: ['skills'] },
          render: (_args, value) => {
            const skills = (value as { skills: string[] }).skills
            return [{ type: 'text', text: skills.length > 0 ? skills.join(', ') : '(no skills)' }]
          },
        },
        execute: async () => ({ skills: this.listSkills() }),
      })

      scope.tools.register({
        name: 'skill_view',
        description: "Read one skill's full content by name (filename without .md).",
        parameters: {
          type: 'object',
          properties: { name: { type: 'string', description: 'Skill name (the filename without .md).' } },
          required: ['name'],
          additionalProperties: false,
        },
        output: {
          schema: { type: 'object', additionalProperties: false, properties: { name: { type: 'string' }, content: { type: 'string' } }, required: ['name', 'content'] },
          render: (_args, value) => [{ type: 'text', text: (value as { content: string }).content }],
        },
        execute: async (args) => {
          const { name } = (args ?? {}) as { name?: unknown }
          if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
            throw new Error('skill_view requires a "name" matching [a-z0-9-]')
          }
          const content = this.readSkill(name)
          if (content === undefined) throw new Error(`skill "${name}" does not exist`)
          return { name, content }
        },
      })
    })

    // The /learn command: a human-facing stub creator; the body is edited after.
    ctx.inject(['commands'], (scope) => {
      scope.commands.register({
        name: 'learn',
        description: 'create a reusable skill (how to do something)',
        input: { hint: '<name> <one-line description>' },
        recordInput: false,
        handler: ({ rawInput }) => {
          const parts = rawInput.trim().split(/\s+/)
          const name = parts[0]
          const description = parts.slice(1).join(' ')
          if (name === undefined || !NAME_PATTERN.test(name) || description === '') {
            return { kind: 'error', text: 'Usage: /learn <name> <one-line description>' }
          }
          const file = this.writeSkill(name, description, '')
          return { kind: 'success', text: `Created skill "${name}" (${file}); add its instructions to the file to activate it.` }
        },
      })
    })
  }

  /** Write one skill file and return its filename. */
  writeSkill(name: string, description: string, content: string): string {
    const file = `${name}.md`
    const body = content === '' ? '' : `\n${content}\n`
    writeFileSync(join(this.root, file), `---\nname: ${name}\ndescription: ${yamlString(description)}\n---${body}`)
    return file
  }

  /** List skill names (filenames without .md), sorted. */
  private listSkills(): string[] {
    return readdirSync(this.root).filter(file => file.endsWith('.md')).map(file => file.slice(0, -3)).sort()
  }

  /** Read one skill's full content, or undefined when it does not exist. */
  private readSkill(name: string): string | undefined {
    const file = join(this.root, `${name}.md`)
    if (!existsSync(file)) return undefined
    return readFileSync(file, 'utf8')
  }
}

export default SkillLearnService
