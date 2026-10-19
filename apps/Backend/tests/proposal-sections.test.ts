import { describe, expect, it } from 'vitest';
import { distributeProposalSections } from '../src/modules/spec/application/proposal-sections.js';
import { parseAgentReply } from '../src/modules/spec/adapters/agent-spec-collaborator.js';

const sections = [
  { templateSectionId: 'problem', title: 'Problema e objetivo', content: 'Original' },
  { templateSectionId: 'actors', title: 'Atores', content: '' },
  { templateSectionId: 'requirements', title: 'Requisitos', content: '' },
  { templateSectionId: 'acceptance', title: 'Critérios de aceite', content: '' },
  { templateSectionId: 'dependencies', title: 'Dependências e impactos', content: '' },
  { templateSectionId: 'extra', title: 'Nova seção', content: 'Existing notes' },
];

describe('proposal section distribution', () => {
  it('splits a bundled response into semantic fields and appends unmatched topics to the final field', () => {
    const content =
      '# 1. Objective\r\nAllow login\r\n## Details\r\nKeep details\r\n# Actors\r\nUsers\r\n# Functional requirements\r\n- **HTTPS**\r\n# Acceptance criteria\r\nSuccessful login\r\n# Dependencies and impacts\r\nDatabase\r\n# Security considerations\r\nRate limits';
    expect(distributeProposalSections([{ templateSectionId: 'extra', content }], sections)).toEqual(
      [
        { templateSectionId: 'problem', content: 'Allow login\n## Details\nKeep details' },
        { templateSectionId: 'actors', content: 'Users' },
        { templateSectionId: 'requirements', content: '- **HTTPS**' },
        { templateSectionId: 'acceptance', content: 'Successful login' },
        { templateSectionId: 'dependencies', content: 'Database' },
        {
          templateSectionId: 'extra',
          content: 'Existing notes\n\n# Security considerations\nRate limits',
        },
      ],
    );
  });

  it('uses all supplied references, aggregates parts, and retains Markdown code and tables', () => {
    const content =
      '## Requisitos\n| Status | Result |\n| --- | --- |\n| 200 | OK |\n```md\n# Atores\n~~~\n```\n## Requisitos\nMore';
    expect(
      distributeProposalSections(
        [
          { templateSectionId: 'wrong', title: 'CRITÉRIOS DE ACEITE', content: 'Accepted' },
          { id: 'requirements', content },
          { id: 'requirements', content: 'Last requirement' },
          { id: 'extra', content: 'Replacement' },
          { id: 'unknown', content: 'Unmatched' },
        ],
        sections,
      ),
    ).toEqual([
      { templateSectionId: 'acceptance', content: 'Accepted' },
      {
        templateSectionId: 'requirements',
        content:
          '| Status | Result |\n| --- | --- |\n| 200 | OK |\n```md\n# Atores\n~~~\n```\n\nMore\n\nLast requirement',
      },
      { templateSectionId: 'extra', content: 'Replacement\n\nUnmatched' },
    ]);
  });

  it('supports custom titles and ignores invalid or empty data without creating fields', () => {
    expect(distributeProposalSections([{ content: 'Nothing' }], [])).toEqual([]);
    expect(
      distributeProposalSections([null, 1, {}, { content: 2 }, { content: '  ' }], sections),
    ).toEqual([]);
    expect(
      distributeProposalSections([{ title: 'Nova SEÇÃO', content: 'Custom' }], sections),
    ).toEqual([{ templateSectionId: 'extra', content: 'Custom' }]);
    expect(
      distributeProposalSections(
        [{ content: '# Unknown\nText\n## Nested\nMore' }],
        [{ templateSectionId: 'only', title: 'Only', content: '' }],
      ),
    ).toEqual([{ templateSectionId: 'only', content: '# Unknown\nText\n## Nested\nMore' }]);
    expect(
      distributeProposalSections(
        [{ title: 'Requirements', content: 'Mapped by ID concept' }],
        [{ templateSectionId: 'requirements', title: 'Custom field', content: '' }],
      ),
    ).toEqual([{ templateSectionId: 'requirements', content: 'Mapped by ID concept' }]);
    expect(
      distributeProposalSections(
        [{ title: 'Actors', content: 'No matching concept' }],
        [{ templateSectionId: 'custom', title: 'Custom', content: '' }],
      ),
    ).toEqual([{ templateSectionId: 'custom', content: 'No matching concept' }]);
  });

  it('normalizes escaped and nested JSON proposal content before distributing sections', () => {
    const nested = JSON.stringify({
      title: 'Ignored envelope',
      sections: [
        {
          templateSectionId: 'requirements',
          content: '### Regras\\n\\n- Primeira regra\\n- Segunda regra',
        },
        {
          templateSectionId: 'acceptance',
          content: '```mermaid\\ngraph TD\\nA --> B\\n```',
        },
      ],
    });
    expect(
      distributeProposalSections([{ content: `\`\`\`json\n${nested}\n\`\`\`` }], sections),
    ).toEqual([
      {
        templateSectionId: 'requirements',
        content: '- Primeira regra\n- Segunda regra',
      },
      {
        templateSectionId: 'acceptance',
        content: '```mermaid\ngraph TD\nA --> B\n```',
      },
    ]);
  });

  it('proposes heading-based replies without changing ordinary conversational replies', () => {
    const spec = {
      id: 'spec',
      workspaceId: 'ws',
      title: 'Login',
      sections,
      messages: [],
      createdAt: '',
      updatedAt: '',
    };
    expect(parseAgentReply('What should happen?', spec)).toEqual({
      content: 'What should happen?',
    });
    const reply = parseAgentReply('## Dependências e impactos\nDatabase\n## Unknown\nExtra', spec);
    expect(reply.sections).toEqual([
      { templateSectionId: 'dependencies', content: 'Database' },
      { templateSectionId: 'extra', content: 'Existing notes\n\n## Unknown\nExtra' },
    ]);
    expect(spec.sections).toEqual(sections);
  });
});
