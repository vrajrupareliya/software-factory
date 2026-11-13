# software-factory

TypeScript CLI that provisions an ephemeral Vercel Sandbox, clones a target repository, installs dependencies with `pnpm`, runs its typecheck script, streams all output live, prints a JSON summary, and shuts the sandbox down.

## Prerequisites

- Node.js 22+
- `pnpm` (or `corepack enable`)
- A Vercel project linked locally (`vercel link`) for OIDC auth, **or** a Vercel access token + Team ID + Project ID (required for Docker)

## Local Run

1. Install dependencies:

   ```bash
   pnpm install
   ```

2. Pull a local Vercel OIDC token into `.env.local` (valid for 12 hours):

   ```bash
   vercel env pull
   ```

3. Run the CLI:

   ```bash
   pnpm dev "inspect and typecheck"
   ```

   Optional flags:

   ```bash
   pnpm dev "check branch" --repo https://github.com/vrajrupareliya/turbo-start-sanity --ref main
   ```

   Defaults come from `REPO_URL` (`https://github.com/vrajrupareliya/turbo-start-sanity`) and `REPO_REF` (`main`).

4. Typecheck and build locally:

   ```bash
   pnpm typecheck
   pnpm build
   ```

## Docker

OIDC tokens in `.env.local` expire after 12 hours and should not be baked into images. In Docker, pass a Vercel access token and IDs at runtime.

1. Copy `.env.example` to `.env` and fill in **unquoted** values (`docker run --env-file` preserves quotes literally):

   ```bash
   cp .env.example .env
   ```

2. Build the image:

   ```bash
   docker build -t software-factory .
   ```

3. Run the container:

   ```bash
   docker run --rm --env-file .env software-factory "test run"
   ```

   You can also pass `--repo` and `--ref`:

   ```bash
   docker run --rm --env-file .env software-factory "test run" --ref main
   ```

## Where to Find Tokens and IDs

- **`VERCEL_TOKEN`**: Create an access token in the Vercel Dashboard under **Account Settings → Tokens** (ensure it has scope for your team/project).
- **`VERCEL_TEAM_ID`**: In the Vercel Dashboard, open your team's **Settings → General** (starts with `team_...`), or inspect `.vercel/project.json` (`orgId`) after running `vercel link`.
- **`VERCEL_PROJECT_ID`**: In the Vercel Dashboard, open your project's **Settings → General** (starts with `prj_...`), or inspect `.vercel/project.json` (`projectId`) after running `vercel link`.
- **`GITHUB_TOKEN`** *(optional)*: A GitHub Personal Access Token (`repo` read scope) if cloning a private repository.
