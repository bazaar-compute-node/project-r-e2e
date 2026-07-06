# Bazaar Template Agent Guide

This repository is a template for deploying Bazaar into a user-owned GitHub
repository. When a user asks an agent to deploy Bazaar from this template, do
not clone and mutate the template repository itself.

## Deployment Checklist

1. Create a new repository from this template with GitHub's "Use this template"
   flow. The generated repository can be public or private.
2. In the target repository or owning organization, enable GitHub Actions.
3. Set workflow permissions:
   - `Read and write permissions`
   - `Allow GitHub Actions to create and approve pull requests`
4. Install the official Bazaar GitHub App for the target repository or owning
   organization.
5. Confirm `.github/workflows/bazaar-register.yml` and
   `.github/workflows/bazaar.yml` exist on the default branch.
6. On each compute machine, run `bcn register` against the target repository:

   ```sh
   bcn register https://github.com/owner/repo \
     --runner runner-1 \
     --label.pool=default \
     --label.kind=review
   ```

7. Wait for the `bazaar-register` workflow run. It should be a
   `issues` event for a new registration issue and should open a registration
   PR.
8. Wait for the workflow to open and merge the registration PR, then confirm
   the registration issue contains the workflow result before using that runner
   for tasks.
9. Register a runtime agent with `bcn agent register`, wait for its PR to merge,
   then request work with `/r run ...`.

## Notes for Agents

- Registration is issue-audited. `bcn register` should create a fresh
  registration issue whose body begins with `/r register `.
- Do not require a fixed onboarding issue for registration.
- Use `--issue N` only when deliberately testing manual `/r register ...`
  issue-comment compatibility.
- The actor authorized for registration comes from the issue author, or from the
  comment author on the manual compatibility path. Do not trust actor fields in
  command text.
- Successful registration reports through the Actions run, the registration PR,
  and the same registration issue.
- Keep provider-specific details at the workflow/adapter boundary. Bazaar's
  core model is: audited request, policy check, registry PR/MR, signed runner
  runtime.
- Runtime capability state lives in `agents/<agent-id>/agent.yaml`, created by
  `bcn agent register`. Do not reintroduce `.agents/agents.yaml`.
- If several runners register in parallel against an empty registry, merge one
  registration PR first and ask the next runner to register again so
  `members/<login>/scope.yaml` is based on the latest default branch.
- The template uses repository-local GitHub Actions for audited registry PRs
  and `/r run` task-spec comments from either an opening issue body or a later
  issue comment. Runtime claim/status/final-report comments are written by the
  hosted broker through the official Bazaar GitHub App.
