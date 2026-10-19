import { z } from 'zod';

export const testPlanCreateSchema = z.object({
  prompt: z.string().trim().min(1),
  title: z.string().trim().min(1).optional(),
  userPrompt: z.string().trim().optional(),
  criteria: z.string().trim().optional(),
  platformProvider: z.string().trim().optional(),
  llmProvider: z.string().trim().optional(),
  areaPath: z.string().trim().optional(),
  assignedTo: z.string().trim().optional(),
  format: z.string().trim().optional(),
  sourceType: z.enum(['manual', 'brain', 'spec', 'pbi']).optional(),
  sourceId: z.string().trim().min(1).optional(),
  suiteId: z.string().trim().min(1).nullable().optional(),
  agentId: z.string().trim().optional(),
});

const authoredTestStepSchema = z
  .object({
    order: z.number().int().min(1).optional(),
    action: z.string().trim().min(1).max(2000),
    expectedResult: z.string().trim().min(1).max(2000).optional(),
    expected: z.string().trim().min(1).max(2000).optional(),
    data: z.string().max(2000).optional(),
  })
  .refine((step) => Boolean(step.expectedResult ?? step.expected), {
    message: 'Each step requires an expected result.',
    path: ['expectedResult'],
  });

const descriptionText = z.string().max(5000).optional();

/** Structured description rendered into the default template (see test-case-description.ts). */
export const testCaseDescriptionSchema = z.object({
  useCase: descriptionText,
  preconditions: descriptionText,
  inputData: descriptionText,
  expectedResult: descriptionText,
  postconditions: descriptionText,
  flow: z
    .array(
      z.union([
        z.string().max(200),
        z.object({ step: z.string().max(200) }),
        z.object({
          decision: z.string().max(200),
          yes: z.string().max(200),
          no: z.string().max(200),
        }),
      ]),
    )
    .max(20)
    .optional(),
});

/** Test Plans authored by an external model (for example an MCP host) and saved as-is. */
export const testPlanSaveSchema = z.object({
  title: z.string().trim().min(1).max(300).optional(),
  assignedTo: z.string().trim().optional(),
  platformProvider: z.string().trim().optional(),
  areaPath: z.string().trim().optional(),
  sourceType: z.enum(['manual', 'brain', 'spec', 'pbi']).optional(),
  sourceId: z.string().trim().min(1).optional(),
  suiteId: z.string().trim().min(1).optional(),
  plans: z
    .array(
      z.object({
        title: z.string().trim().min(1).max(300),
        description: z.union([z.string().max(20000), testCaseDescriptionSchema]).default(''),
        steps: z.array(authoredTestStepSchema).min(1).max(100),
      }),
    )
    .min(1)
    .max(100),
});

export const searchQuerySchema = z.object({
  prompt: z.string().trim().min(1),
});

export const webhookPayloadSchema = z.object({
  eventType: z.string().trim().min(1),
  resource: z.record(z.string(), z.unknown()).optional(),
});

export type TestPlanCreateInput = z.infer<typeof testPlanCreateSchema>;
export type TestPlanSaveInput = z.infer<typeof testPlanSaveSchema>;
export type SearchQueryInput = z.infer<typeof searchQuerySchema>;
export type WebhookPayloadInput = z.infer<typeof webhookPayloadSchema>;
