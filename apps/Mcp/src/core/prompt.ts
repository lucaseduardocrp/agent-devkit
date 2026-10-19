import { z } from 'zod';

/** A reusable workflow template exposed through MCP `prompts/list` (slash commands in most clients). */
export interface McpPrompt {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly args: Readonly<Record<string, z.ZodType<string | undefined>>>;
  render(args: Record<string, string | undefined>): string;
}

export interface PromptSpec<Shape extends Record<string, z.ZodType<string | undefined>>> {
  readonly name: string;
  readonly title: string;
  readonly description: string;
  readonly args: Shape;
  render(args: z.output<z.ZodObject<Shape>>): string;
}

export function definePrompt<Shape extends Record<string, z.ZodType<string | undefined>>>(
  spec: PromptSpec<Shape>,
): McpPrompt {
  const schema = z.object(spec.args);
  return {
    name: spec.name,
    title: spec.title,
    description: spec.description,
    args: spec.args,
    render: (args) => spec.render(schema.parse(args)),
  };
}
