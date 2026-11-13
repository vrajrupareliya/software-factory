import { z } from 'zod';

export const DEFAULT_REPO_URL = 'https://github.com/vrajrupareliya/turbo-start-sanity';
export const DEFAULT_REPO_REF = 'main';
export const DEFAULT_MAX_AGENT_STEPS = 25;
export const DEFAULT_MAX_REPAIR_ROUNDS = 3;

export const DEFAULT_PLACEHOLDER_ENV: Record<string, string> = {
  SANITY_STUDIO_PROJECT_ID: 'placeholder-project-id',
  SANITY_STUDIO_DATASET: 'production',
  NEXT_PUBLIC_SANITY_PROJECT_ID: 'placeholder-project-id',
  NEXT_PUBLIC_SANITY_DATASET: 'production',
};

const optionalNonEmpty = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().url().optional(),
);

const optionalNumber = (defaultValue: number) =>
  z.preprocess((val) => {
    if (typeof val === 'number') return val;
    if (typeof val === 'string' && val.trim() !== '') {
      const parsed = Number.parseInt(val.trim(), 10);
      return Number.isNaN(parsed) ? undefined : parsed;
    }
    return undefined;
  }, z.number().int().min(1).default(defaultValue));

const optionalBoolean = (defaultValue: boolean) =>
  z.preprocess((val) => {
    if (typeof val === 'boolean') return val;
    if (typeof val === 'string') {
      const lower = val.trim().toLowerCase();
      if (lower === 'true' || lower === '1') return true;
      if (lower === 'false' || lower === '0') return false;
    }
    return undefined;
  }, z.boolean().default(defaultValue));

const EnvSchema = z
  .object({
    VERCEL_OIDC_TOKEN: optionalNonEmpty,
    VERCEL_TOKEN: optionalNonEmpty,
    VERCEL_TEAM_ID: optionalNonEmpty,
    VERCEL_PROJECT_ID: optionalNonEmpty,
    REPO_URL: optionalUrl,
    REPO_REF: optionalNonEmpty,
    GITHUB_TOKEN: optionalNonEmpty,
    GOOGLE_GENERATIVE_AI_API_KEY: optionalNonEmpty,
    GEMINI_MODEL: optionalNonEmpty,
    MAX_AGENT_STEPS: optionalNumber(DEFAULT_MAX_AGENT_STEPS),
    MAX_REPAIR_ROUNDS: optionalNumber(DEFAULT_MAX_REPAIR_ROUNDS),
    DENY_NETWORK_AFTER_INSTALL: optionalBoolean(false),
    SANITY_STUDIO_PROJECT_ID: optionalNonEmpty,
    SANITY_STUDIO_DATASET: optionalNonEmpty,
    NEXT_PUBLIC_SANITY_PROJECT_ID: optionalNonEmpty,
    NEXT_PUBLIC_SANITY_DATASET: optionalNonEmpty,
  })
  .superRefine((env, ctx) => {
    const hasAllAccessToken = Boolean(
      env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID,
    );
    if (!hasAllAccessToken && !env.VERCEL_OIDC_TOKEN) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Missing Vercel credentials: set VERCEL_OIDC_TOKEN (via `vercel env pull`) or all three of VERCEL_TOKEN, VERCEL_TEAM_ID, and VERCEL_PROJECT_ID.',
      });
    }

    if (!env.GOOGLE_GENERATIVE_AI_API_KEY) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Missing required environment variable: GOOGLE_GENERATIVE_AI_API_KEY. Please provide your Google Gemini API key in .env.local or environment.',
      });
    }

    if (!env.GEMINI_MODEL) {
      ctx.addIssue({
        code: 'custom',
        message:
          'Missing required environment variable: GEMINI_MODEL. Please specify a Gemini model (e.g. gemini-3.5-flash) in .env.local or environment (no hardcoded default).',
      });
    }
  });

export type VercelAuth =
  | { mode: 'oidc' }
  | { mode: 'access-token'; token: string; teamId: string; projectId: string };

export interface AppConfig {
  auth: VercelAuth;
  defaultRepoUrl: string;
  defaultRepoRef: string;
  githubToken?: string;
  googleApiKey: string;
  geminiModel: string;
  maxAgentSteps: number;
  maxRepairRounds: number;
  denyNetworkAfterInstall: boolean;
  placeholderEnv: Record<string, string>;
}

export function loadConfig(): AppConfig {
  try {
    process.loadEnvFile('.env.local');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw err;
    }
  }

  const parsed = EnvSchema.safeParse(process.env);
  if (!parsed.success) {
    const details = parsed.error.issues.map((i) => i.message).join('\n- ');
    throw new Error(`Configuration error:\n- ${details}`);
  }

  const env = parsed.data;
  const auth: VercelAuth =
    env.VERCEL_TOKEN && env.VERCEL_TEAM_ID && env.VERCEL_PROJECT_ID
      ? {
          mode: 'access-token',
          token: env.VERCEL_TOKEN,
          teamId: env.VERCEL_TEAM_ID,
          projectId: env.VERCEL_PROJECT_ID,
        }
      : { mode: 'oidc' };

  const placeholderEnv: Record<string, string> = {
    ...DEFAULT_PLACEHOLDER_ENV,
    ...(env.SANITY_STUDIO_PROJECT_ID
      ? { SANITY_STUDIO_PROJECT_ID: env.SANITY_STUDIO_PROJECT_ID }
      : {}),
    ...(env.SANITY_STUDIO_DATASET
      ? { SANITY_STUDIO_DATASET: env.SANITY_STUDIO_DATASET }
      : {}),
    ...(env.NEXT_PUBLIC_SANITY_PROJECT_ID
      ? { NEXT_PUBLIC_SANITY_PROJECT_ID: env.NEXT_PUBLIC_SANITY_PROJECT_ID }
      : {}),
    ...(env.NEXT_PUBLIC_SANITY_DATASET
      ? { NEXT_PUBLIC_SANITY_DATASET: env.NEXT_PUBLIC_SANITY_DATASET }
      : {}),
  };

  return {
    auth,
    defaultRepoUrl: env.REPO_URL ?? DEFAULT_REPO_URL,
    defaultRepoRef: env.REPO_REF ?? DEFAULT_REPO_REF,
    githubToken: env.GITHUB_TOKEN,
    googleApiKey: env.GOOGLE_GENERATIVE_AI_API_KEY as string,
    geminiModel: env.GEMINI_MODEL as string,
    maxAgentSteps: env.MAX_AGENT_STEPS,
    maxRepairRounds: env.MAX_REPAIR_ROUNDS,
    denyNetworkAfterInstall: env.DENY_NETWORK_AFTER_INSTALL,
    placeholderEnv,
  };
}
