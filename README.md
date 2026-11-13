# software-factory

TypeScript CLI that provisions an ephemeral Vercel Sandbox, clones a target repository, installs dependencies with `pnpm`, runs a baseline verification suite, launches an AI Agent (`ToolLoopAgent` powered by Google Gemini) to solve tasks, and runs an automated verify-and-repair loop before shutting down.

## Architecture & Workflow

1. **Sandbox Provisioning**: Creates an ephemeral Vercel microVM (`@vercel/sandbox`) with 2 vCPUs, 30-minute timeout, and shallow git clone.
2. **Setup**: Inspects `package.json`, enables `corepack`, and installs dependencies via `pnpm install --frozen-lockfile`.
3. **Optional Network Lock**: If `DENY_NETWORK_AFTER_INSTALL=true` (or `--deny-network`), the sandbox network policy is locked to `deny-all` after dependency installation.
4. **Baseline Suite**: Runs the 5 verification checks on the clean repository checkout:
   - `typegen`: `pnpm --filter studio extract && pnpm type`
   - `check-types`: `pnpm check-types`
   - `lint`: `pnpm lint`
   - `format`: `pnpm format:check`
   - `test`: `pnpm test`
   Any check that fails at baseline is marked `preexisting: true` and excluded from the pass/fail gate. Can be skipped via `--skip-baseline`.
5. **AI Agent Run**: Executes a `ToolLoopAgent` (`ai` SDK) using the model specified in `GEMINI_MODEL`:
   - Safe sandbox tools: `listFiles`, `readFile`, `writeFile`, `runCheck`.
   - Security path guards: Rejects traversal (`..`), absolute paths, and modifications to `.git`, `node_modules`, `.github`, `.env*`, `pnpm-lock.yaml`, and any `package.json`.
   - Automatic retries with exponential backoff for rate limits (429) and transient errors.
6. **Orchestrator Gate & Repair Loop**:
   - The orchestrator independently executes the 5-check suite.
   - If any non-preexisting check fails and repair rounds remain (up to `MAX_REPAIR_ROUNDS` or `--max-rounds`), the agent is re-invoked with fresh context containing the ticket, `git diff --stat`, and the tail (~8k chars) of failing check outputs.
7. **Report & Teardown**:
   - Outputs live tool execution logs.
   - Displays capped `git diff`.
   - Logs active CPU duration.
   - Outputs a comprehensive JSON `RunReport`.
   - Shuts down the sandbox in `finally` and on `SIGINT`. Exits `0` only if the verification gate passed.

## Environment Variables

| Variable | Required | Description |
| :--- | :--- | :--- |
| `GOOGLE_GENERATIVE_AI_API_KEY` | **Yes** | Google Gemini API key |
| `GEMINI_MODEL` | **Yes** | Gemini model ID (e.g. `gemini-3.5-flash`, no hardcoded default) |
| `VERCEL_OIDC_TOKEN` | Required for OIDC | OIDC token from `vercel env pull` |
| `VERCEL_TOKEN` | Required for Docker | Vercel Personal Access Token |
| `VERCEL_TEAM_ID` | Required for Docker | Vercel Team ID (`team_...` or `.vercel/project.json` `orgId`) |
| `VERCEL_PROJECT_ID` | Required for Docker | Vercel Project ID (`prj_...` or `.vercel/project.json` `projectId`) |
| `REPO_URL` | No | Default: `https://github.com/vrajrupareliya/turbo-start-sanity` |
| `REPO_REF` | No | Default: `main` |
| `MAX_AGENT_STEPS` | No | Maximum steps per agent run (default: `25`) |
| `MAX_REPAIR_ROUNDS` | No | Maximum repair rounds (default: `3`) |
| `DENY_NETWORK_AFTER_INSTALL` | No | Set to `true` to lock network after install (default: `false`) |
| `GITHUB_TOKEN` | No | Optional GitHub token for private repositories |

## Local Usage

1. Install dependencies:
   ```bash
   pnpm install
   ```

2. Configure environment:
   Ensure `.env.local` has your `VERCEL_OIDC_TOKEN`, `GOOGLE_GENERATIVE_AI_API_KEY`, and `GEMINI_MODEL`:
   ```bash
   vercel env pull
   # Add your Gemini key and model to .env.local:
   # GOOGLE_GENERATIVE_AI_API_KEY=...
   # GEMINI_MODEL=gemini-3.5-flash
   ```

3. Typecheck and build:
   ```bash
   pnpm typecheck
   pnpm build
   ```

4. Run the CLI:
   ```bash
   pnpm dev "Add a testimonial document type with name, quote and author"
   ```

   CLI Options:
   ```bash
   pnpm dev "<task text>" [options]

   Options:
     --repo <url>          Target Git repository URL
     --ref <ref>           Target Git branch, commit, or tag
     --max-rounds <n>      Maximum repair rounds (overrides MAX_REPAIR_ROUNDS)
     --skip-baseline       Skip baseline check suite run
     --deny-network        Deny network in sandbox after installation
     -h, --help            Show help message
   ```

## Docker

In Docker containers, access tokens and IDs are passed at runtime via `.env`:

1. Copy `.env.example` to `.env` with **unquoted** values:
   ```bash
   cp .env.example .env
   ```

2. Build the Docker image:
   ```bash
   docker build -t software-factory .
   ```

3. Run the container:
   ```bash
   docker run --rm --env-file .env software-factory "Add a testimonial document type with name, quote and author"
   ```
