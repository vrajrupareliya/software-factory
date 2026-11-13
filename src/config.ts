import { z } from 'zod';

export const DEFAULT_REPO_URL = 'https://github.com/vrajrupareliya/turbo-start-sanity';
export const DEFAULT_REPO_REF = 'main';

const optionalNonEmpty = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().min(1).optional(),
);

const optionalUrl = z.preprocess(
  (val) => (typeof val === 'string' && val.trim() === '' ? undefined : val),
  z.string().trim().url().optional(),
);

const EnvSchema = z
  .object({
    VERCEL_OIDC_TOKEN: optionalNonEmpty,
    VERCEL_TOKEN: optionalNonEmpty,
    VERCEL_TEAM_ID: optionalNonEmpty,
    VERCEL_PROJECT_ID: optionalNonEmpty,
    REPO_URL: optionalUrl,
    REPO_REF: optionalNonEmpty,
    GITHUB_TOKEN: optionalNonEmpty,
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
  });

export type VercelAuth =
  | { mode: 'oidc' }
  | { mode: 'access-token'; token: string; teamId: string; projectId: string };

export interface AppConfig {
  auth: VercelAuth;
  defaultRepoUrl: string;
  defaultRepoRef: string;
  githubToken?: string;
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
    const details = parsed.error.issues.map((i) => i.message).join('; ');
    throw new Error(`Invalid configuration: ${details}`);
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

  return {
    auth,
    defaultRepoUrl: env.REPO_URL ?? DEFAULT_REPO_URL,
    defaultRepoRef: env.REPO_REF ?? DEFAULT_REPO_REF,
    githubToken: env.GITHUB_TOKEN,
  };
}
