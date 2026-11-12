import { describe, expect, it } from 'vitest';
import {
  CustomAgent,
  MAX_AGENT_SKILLS,
  parseAgentSkills,
  parseAgentSource,
  type AgentSkill,
} from '../src/modules/agents/domain/agent-entity.js';

const skill = (name: string): AgentSkill => ({
  name,
  description: 'When to use',
  instructions: 'Body',
  version: '1',
  revision: `rev-${name}`,
});

const agentProps = {
  id: 'ag-1',
  workspaceId: 'ws-1',
  name: 'QA',
  slug: 'qa',
  description: '',
  role: 'QA' as const,
  instructions: 'Test things.',
};

describe('parseAgentSource', () => {
  it('reads hub agent and plugin sources', () => {
    expect(
      parseAgentSource({ kind: 'hub-agent', name: 'qa', revision: 'sha', version: '2.0.0' }),
    ).toEqual({ kind: 'hub-agent', name: 'qa', version: '2.0.0', revision: 'sha' });
    expect(
      parseAgentSource({ kind: 'hub-plugin', name: 'sub', plugin: 'pack', revision: 'commit' }),
    ).toEqual({ kind: 'hub-plugin', name: 'sub', plugin: 'pack', version: '', revision: 'commit' });
  });

  it('treats anything malformed as a hand-made agent', () => {
    expect(parseAgentSource(null)).toBeNull();
    expect(parseAgentSource('hub-agent')).toBeNull();
    expect(parseAgentSource({ kind: 'other', name: 'qa', revision: 'sha' })).toBeNull();
    expect(parseAgentSource({ kind: 'hub-agent', revision: 'sha' })).toBeNull();
    expect(parseAgentSource({ kind: 'hub-agent', name: 'qa', revision: 5 })).toBeNull();
    expect(parseAgentSource({ kind: 'hub-plugin', name: 'sub', revision: 'sha' })).toBeNull();
  });
});

describe('parseAgentSkills', () => {
  it('reads stored skills and drops malformed entries', () => {
    expect(parseAgentSkills('nope')).toEqual([]);
    expect(
      parseAgentSkills([
        { name: 'a', instructions: 'Body', revision: 'r' },
        { name: 'b', description: 'D', instructions: 'Body', version: '3', revision: 'r2' },
        { name: '', instructions: 'Body', revision: 'r' },
        { name: 'c', instructions: 'Body', revision: 5 },
        null,
        'text',
      ]),
    ).toEqual([
      { name: 'a', description: '', instructions: 'Body', version: '', revision: 'r' },
      { name: 'b', description: 'D', instructions: 'Body', version: '3', revision: 'r2' },
    ]);
  });
});

describe('CustomAgent skills', () => {
  it('keeps the skills but hides their instructions from clients', () => {
    const agent = new CustomAgent({ ...agentProps, skills: [skill('a')] });
    expect(agent.skills).toHaveLength(1);
    expect(agent.toJSON().skills).toEqual([
      { name: 'a', description: 'When to use', version: '1', revision: 'rev-a' },
    ]);
  });

  it('rejects too many skills and repeated skills', () => {
    const many = Array.from({ length: MAX_AGENT_SKILLS + 1 }, (_, index) => skill(`s${index}`));
    expect(() => new CustomAgent({ ...agentProps, skills: many })).toThrow(
      `An agent can use at most ${MAX_AGENT_SKILLS} skills.`,
    );
    expect(() => new CustomAgent({ ...agentProps, skills: [skill('a'), skill('a')] })).toThrow(
      'An agent cannot use the same skill twice.',
    );
  });

  it('defaults optional fields', () => {
    const agent = new CustomAgent({ ...agentProps, slug: '  ', role: undefined as never });
    expect(agent).toMatchObject({
      slug: 'qa',
      role: 'CUSTOM',
      skills: [],
      source: null,
      parentAgentId: null,
    });
  });
});
