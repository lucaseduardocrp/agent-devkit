export interface SpecTemplateSection {
  readonly id: string;
  readonly title: string;
  readonly guidance?: string;
  readonly required: boolean;
}

export interface SpecTemplate {
  readonly id: string;
  readonly workspaceId: string;
  readonly name: string;
  readonly sections: readonly SpecTemplateSection[];
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SpecificationSection {
  readonly templateSectionId: string;
  readonly title: string;
  readonly content: string;
}

export interface SpecMessage {
  readonly id: string;
  readonly role: 'user' | 'assistant';
  readonly content: string;
  readonly createdAt: string;
}

export interface SpecificationProposal {
  readonly title?: string;
  readonly sections: readonly { templateSectionId: string; content: string }[];
}

export interface Specification {
  readonly id: string;
  readonly workspaceId: string;
  readonly templateId?: string;
  readonly agentId?: string;
  readonly parentId?: string;
  readonly title: string;
  readonly sections: readonly SpecificationSection[];
  readonly messages: readonly SpecMessage[];
  readonly proposal?: SpecificationProposal;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export function renderSpecificationMarkdown(specification: Specification): string {
  const body = specification.sections
    .filter((section) => section.content.trim())
    .map((section) => `## ${section.title}\n\n${section.content.trim()}`)
    .join('\n\n');
  return `# ${specification.title}\n\n${body}${body ? '\n' : ''}`;
}
