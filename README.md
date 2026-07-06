# Bazaar Template

Use this template to bootstrap Bazaar in a repository with the minimum required
configuration. Users should create a new repository from this template; they do
not need to clone this template locally.

## Bootstrap

1. Create the target repository from this template with GitHub's
   "Use this template" flow.
2. Enable GitHub Actions for the new repository.
3. In the target repository or owning organization, open:
   `Settings -> Actions -> General -> Workflow permissions`.
4. Select `Read and write permissions`.
5. Enable `Allow GitHub Actions to create and approve pull requests`.
6. Install the official Bazaar GitHub App for the target repository or owning
   organization. The App writes runtime claim/status/final-report comments
   through the hosted Bazaar broker; local daemons do not receive App keys.
7. On each machine that should provide compute, run:

   ```sh
   bcn register https://github.com/owner/repo \
     --runner runner-1 \
     --label.pool=default \
     --label.kind=review
   ```

8. `bcn register` creates a new registration issue in the target repository.
   The issue body contains the audited Bazaar command:

   ```text
   /r register runner=runner-1 pubkey=ed25519:... workspace_root=.bazaar/workspaces/<uuid> label.pool=default label.kind=review
   ```

9. The repo-local GitHub Actions workflow wakes on the opened issue, checks
   `.agents/policy.yaml`, and opens a pull request that writes the node record
   and member scope into repository registry paths.
10. The registration PR includes `Closes #N` for the registration issue. When
   policy allows it, the workflow opens and merges the PR, then replies in the
   same issue with the result.
11. Register the runtime agent that will execute work on that runner:

   ```sh
   bcn agent register https://github.com/owner/repo \
     --agent codex \
     --runner runner-1 \
     --type codex \
     --model gpt-5 \
     --secret-ref env:OPENAI_API_KEY
   ```

12. After the agent registration PR is merged, request work from any issue:

   ```text
   /r run agent=codex label.pool=default fix the failing test
   ```

`bcn register` does not require a fixed onboarding issue. It creates one
audited registration issue per request. The optional `--issue N` flag is only
for manual compatibility with `/r register ...` issue comments.

`bcn register` registers a compute node. It assigns and persists a UUID-backed
workspace root locally, and that path is included in the audited registration
command. Agent capabilities are separate from node identity and are declared
through `bcn agent register`, not `bcn register`.
Member identity is derived from the GitHub issue actor, not from the command
payload. The workflow writes `members/<github-login>/member.yaml` and
`members/<github-login>/scope.yaml` alongside `runners/<runner-id>/runner.yaml`.
The member file records provider-derived roles and `permissions.members_manage`;
future edit/delete permissions should check member scope plus policy.

## Files

```text
.agents/policy.yaml     Bazaar roles and command permissions
.agents/providers.yaml  provider configuration notes
.github/scripts/bazaar-agent.js        agent registration workflow implementation
.github/scripts/bazaar-register.js     registration workflow implementation
.github/scripts/bazaar-run.js          run-command task-spec workflow implementation
.github/workflows/bazaar-register.yml  repo-owned registration workflow
.github/workflows/bazaar.yml           repo-owned run-command workflow
.github/ISSUE_TEMPLATE/bazaar.md       optional issue template for run commands
runners/<runner-id>/runner.yaml        issue-created node registry state
agents/<agent-id>/agent.yaml           issue-created agent registry state
members/<member-id>/member.yaml        issue-created human member identity
members/<member-id>/scope.yaml         issue-created member scope bindings
```

`.agents/` is template-owned configuration meant to be synchronized from
upstream, for example by a future `bcn upgrade` flow. Issue-driven runtime
state should live in explicit repository paths such as `runners/` and
`agents/` and `members/`, not under `.agents/`.

GitHub is the v0 provider. Repo-local Actions process audited registration
issues, check policy, update registry paths, open registration PRs, and post
task-spec blocks for `/r run`. The official Bazaar GitHub App is installed once
for the target repository or organization and writes runtime broker comments.
Users do not create their own GitHub App or provide a webhook callback server.

```text
contents: write
issues: write
pull-requests: write
```

The core Bazaar protocol is provider-neutral. Providers supply an authenticated
actor plus an auditable issue and PR/MR surface; Bazaar stores members, policy,
runner public keys, and runtime signatures in the repository. GitLab and other
providers should use the same template/config and registry split with their own
repository-local automation.

## Runner Command

```sh
bcn register https://github.com/owner/repo \
  --runner runner-1 \
  --label.pool=default \
  --label.kind=review
```

The command creates a registration issue, and the repo-local workflow will open
and merge a PR that writes `runners/<runner-id>/runner.yaml`,
`members/<github-login>/member.yaml`, and
`members/<github-login>/scope.yaml` after `.agents/policy.yaml` allows the
issue author.

## Agent Command

```sh
bcn agent register https://github.com/owner/repo \
  --agent codex \
  --runner runner-1 \
  --type codex \
  --model gpt-5 \
  --secret-ref env:OPENAI_API_KEY
```

The command creates an audited agent registration issue. The repo-local
workflow checks `.agents/policy.yaml`, verifies the target runner exists and the
issue author has scope for it, then opens and merges a PR that writes
`agents/<agent-id>/agent.yaml`.

## Run Command

```text
/r run agent=codex label.pool=default fix the failing test
```

The repo-local workflow checks `.agents/policy.yaml`, verifies
`agents/<agent-id>/agent.yaml` exists, and posts a `bazaar/task-spec` block.
The slash command can be the opening issue body or a later issue comment.
Registered daemons poll the issue, claim eligible tasks through the hosted
broker, and the official Bazaar App writes claim/status/final-report comments.

If multiple runners register at the same time before any registration PR is
merged, their PRs may touch the same member scope file. Merge one registration
PR first, then have the next runner run `bcn register` again from the updated
repository state.
