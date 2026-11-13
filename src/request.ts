import { z } from 'zod';

export const FactoryRequestSchema = z.object({
  task: z.string().trim().min(1, 'Task text is required'),
  repoUrl: z.string().url('repoUrl must be a valid URL'),
  ref: z.string().trim().min(1, 'ref is required'),
});

export type FactoryRequest = z.infer<typeof FactoryRequestSchema>;
