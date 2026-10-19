import { z } from 'zod';

export const integrationCategorySchema = z.enum(['KNOWLEDGE', 'PROJECT_MANAGEMENT', 'LLM']);
export type IntegrationCategory = z.infer<typeof integrationCategorySchema>;

export const saveIntegrationSchema = z.object({
  isEnabled: z.boolean().optional().default(true),
  settings: z.record(z.string(), z.unknown()).optional().default({}),
  secret: z.string().optional(),
});

export type SaveIntegrationInput = z.infer<typeof saveIntegrationSchema>;

export interface IntegrationDTO {
  readonly id: string;
  readonly category: IntegrationCategory;
  readonly providerId: string;
  readonly isEnabled: boolean;
  readonly settings: Record<string, unknown>;
  readonly hasSecret: boolean;
  readonly maskedSecret?: string;
  readonly updatedAt: string;
}
