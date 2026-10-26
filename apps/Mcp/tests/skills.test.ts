import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { packageVersion } from '../src/bootstrap/create-server.js';
import {
  loadSkills,
  packageRoot,
  parseFrontmatter,
  skillsDirectory,
} from '../src/bootstrap/skills.js';
import { ToolRegistry } from '../src/core/registry.js';
import { modules } from '../src/modules/index.js';

describe('packaged skills', () => {
  it('ships valid, uniquely named skills whose tool references exist', async () => {
    const skills = await loadSkills();
    expect(skills.map((skill) => skill.name)).toEqual([
      'adk-agents',
      'adk-api-tests',
      'adk-brain',
      'adk-design',
      'adk-e2e',
      'adk-getting-started',
      'adk-release-notes',
      'adk-specs',
      'adk-test-plans',
      'adk-workspace-admin',
    ]);
    const tools = new Set(new ToolRegistry(modules).tools.map((tool) => tool.name));
    for (const skill of skills) {
      expect(skill.description.length, skill.name).toBeGreaterThan(40);
      expect(skill.path).toContain(join('skills', skill.name, 'SKILL.md'));
      const referenced = [...skill.content.matchAll(/`([a-z]+_[a-z_]+)(?:\s|`)/g)].map(
        (match) => match[1]!,
      );
      const unknown = referenced.filter(
        (name) => !tools.has(name) && !name.endsWith('_') && !['sourceType', 'x_y'].includes(name),
      );
      expect(unknown, `${skill.name} references unknown tools`).toEqual([]);
    }
  });

  it('parses frontmatter and tolerates missing folders or metadata', async () => {
    expect(
      parseFrontmatter('---\nname: "a"\ndescription: b: c\nno separator\n: orphan\n---\n# x'),
    ).toEqual({
      name: 'a',
      description: 'b: c',
    });
    expect(parseFrontmatter('# none')).toEqual({});
    expect(await loadSkills(join(tmpdir(), 'does-not-exist-adk'))).toEqual([]);
    const dir = await mkdtemp(join(tmpdir(), 'adk-skills-'));
    await mkdir(join(dir, 'bare'));
    await writeFile(join(dir, 'bare', 'SKILL.md'), '# No frontmatter');
    await mkdir(join(dir, 'empty'));
    expect(await loadSkills(dir)).toMatchObject([{ name: 'bare', description: '' }]);
    expect(() => packageRoot(tmpdir().slice(0, 3))).toThrow('package root');
    expect(skillsDirectory()).toBe(join(packageRoot(), 'skills'));
    expect(packageVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });
});
