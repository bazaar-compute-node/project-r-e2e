const fs = require("fs");

module.exports = async function run({ github, context, core }) {
  const policyPath = ".agents/policy.yaml";
  const providersPath = ".agents/providers.yaml";
  const event = context.payload;
  const { owner, repo } = context.repo;
  const actor = registrationActor(context, event);
  const issueNumber = registrationIssueNumber(event);
  const baseBranch = event.repository?.default_branch || "main";
  const command = parseRegisterCommand(registrationCommand(context, event));

  const permission = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor
  });
  const roles = permissionToRoles(permission.data.permission);
  const policy = parsePolicy(readFile(policyPath));
  if (!can(policy, "register_runner", actor, roles)) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar registration denied for runner \`${command.runner_id}\`: @${actor} is not allowed by \`${policyPath}\`.`);
    core.setFailed(`actor ${actor} is not allowed to register runners`);
    return;
  }

  const runnerPath = runnerRegistryPath(command.runner_id, "runner.yaml");
  const memberPath = memberRegistryPath(actor, "member.yaml");
  const memberScopePath = memberRegistryPath(actor, "scope.yaml");
  const current = await getRepoFileOrNull(github, owner, repo, runnerPath, baseBranch);
  const existingRunner = current ? parseRunner(current.text) : null;
  const runner = commandToRunner(command, existingRunner);
  const updatedRunner = marshalRunner(runner);
  if (current && updatedRunner === current.text) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar runner \`${runner.id}\` is already registered with the same configuration.`);
    await closeIssue(github, owner, repo, issueNumber);
    return;
  }

  const baseRef = await github.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`
  });
  const branch = `bazaar/register-${sanitizeRefPart(runner.id)}-${Math.floor(Date.now() / 1000)}`;
  await github.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.data.object.sha
  });
  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: runnerPath,
    message: `Register Bazaar runner ${runner.id}`,
    content: Buffer.from(updatedRunner, "utf8").toString("base64"),
    branch,
    sha: current?.sha
  });
  const currentMember = await getRepoFileOrNull(github, owner, repo, memberPath, baseBranch);
  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: memberPath,
    message: `Register Bazaar member ${actor}`,
    content: Buffer.from(marshalMember(actor, roles), "utf8").toString("base64"),
    branch,
    sha: currentMember?.sha
  });
  const currentMemberScope = await getRepoFileOrNull(github, owner, repo, memberScopePath, baseBranch);
  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: memberScopePath,
    message: `Grant Bazaar runner scope ${runner.id} to ${actor}`,
    content: Buffer.from(marshalMemberScope(actor, runner.id, currentMemberScope?.text), "utf8").toString("base64"),
    branch,
    sha: currentMemberScope?.sha
  });
  const pr = await github.rest.pulls.create({
    owner,
    repo,
    title: `Register Bazaar runner ${runner.id}`,
    body: [
      `Requested by @${actor} via \`${registrationSource(context)}\`.`,
      "",
      `This PR updates \`${runnerPath}\`, \`${memberPath}\`, and \`${memberScopePath}\`.`,
      "",
      issueNumber ? `Closes #${issueNumber}` : ""
    ].filter(Boolean).join("\n"),
    head: branch,
    base: baseBranch
  });

  let merged = false;
  if (readAutoMergeOptIn(providersPath)) {
    await github.rest.pulls.merge({
      owner,
      repo,
      pull_number: pr.data.number,
      commit_title: `Register Bazaar runner ${runner.id}`,
      merge_method: "merge"
    });
    merged = true;
    try {
      await github.rest.git.deleteRef({
        owner,
        repo,
        ref: `heads/${branch}`
      });
    } catch (error) {
      core.warning(`failed to delete ${branch}: ${error.message}`);
    }
  }

  core.info(`Bazaar registration PR ${merged ? "opened and merged" : "opened"} for runner ${runner.id}: ${pr.data.html_url}`);
  await commentOnIssue(github, owner, repo, issueNumber, `Bazaar registration PR ${merged ? "opened and merged" : "opened"} for runner \`${runner.id}\`: ${pr.data.html_url}`);
  if (merged) {
    await closeIssue(github, owner, repo, issueNumber);
  }
};

function registrationActor(context, event) {
  if (context.eventName === "issues") {
    return event.issue?.user?.login || "";
  }
  return event.comment?.user?.login || "";
}

function registrationCommand(context, event) {
  if (context.eventName === "issues") {
    return event.issue?.body || "";
  }
  return event.comment?.body || "";
}

function registrationSource(context) {
  if (context.eventName === "issues") {
    return "bcn register";
  }
  return "/r register";
}

function registrationIssueNumber(event) {
  return event.issue?.number || 0;
}

function readFile(path) {
  return fs.readFileSync(path, "utf8");
}

async function commentOnIssue(github, owner, repo, issueNumber, body) {
  if (!issueNumber) {
    return;
  }
  await github.rest.issues.createComment({
    owner,
    repo,
    issue_number: issueNumber,
    body
  });
}

async function closeIssue(github, owner, repo, issueNumber) {
  if (!issueNumber) {
    return;
  }
  await github.rest.issues.update({
    owner,
    repo,
    issue_number: issueNumber,
    state: "closed"
  });
}

async function getRepoFile(github, owner, repo, path, ref) {
  const response = await github.rest.repos.getContent({ owner, repo, path, ref });
  if (Array.isArray(response.data) || !("content" in response.data)) {
    throw new Error(`${path} is not a file`);
  }
  return {
    sha: response.data.sha,
    text: Buffer.from(response.data.content.replace(/\s+/g, ""), "base64").toString("utf8")
  };
}

async function getRepoFileOrNull(github, owner, repo, path, ref) {
  try {
    return await getRepoFile(github, owner, repo, path, ref);
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

function parseRegisterCommand(body) {
  const fields = body.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 3 || fields[0] !== "/r" || fields[1] !== "register") {
    throw new Error("not an /r register command");
  }
  const command = {
    labels: {},
    public_key: "",
    runner_id: "",
    workspace_root: ""
  };
  for (const field of fields.slice(2)) {
    const idx = field.indexOf("=");
    if (idx <= 0 || idx === field.length - 1) {
      throw new Error(`invalid register option ${field}`);
    }
    const key = field.slice(0, idx);
    const value = field.slice(idx + 1);
    if (key === "pubkey" || key === "public_key") {
      command.public_key = value;
    } else if (key === "runner" || key === "runner_id" || key === "id") {
      command.runner_id = value;
    } else if (key === "agent") {
      throw new Error("agent capabilities must be registered separately");
    } else if (["member", "member_id", "owner", "owner_id", "scope", "scope_id", "user", "user_id"].includes(key)) {
      throw new Error("member identity is derived from provider actor");
    } else if (key === "workspace_root") {
      command.workspace_root = value;
    } else {
      command.labels[key.replace(/^label\./, "")] = value;
    }
  }
  if (!command.public_key) {
    throw new Error("missing pubkey");
  }
  if (!command.runner_id) {
    throw new Error("missing runner");
  }
  if (!isUUIDv7(command.runner_id)) {
    throw new Error("runner must be a UUIDv7 generated by bcn");
  }
  if (!command.workspace_root) {
    throw new Error("missing workspace_root");
  }
  if (!hasUUIDv7Workspace(command.workspace_root)) {
    throw new Error("workspace_root must end with a UUIDv7 generated by bcn");
  }
  return command;
}

function isUUIDv7(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}

function hasUUIDv7Workspace(value) {
  const parts = value.split(/[\\/]/).filter(Boolean);
  return parts.length > 0 && isUUIDv7(parts[parts.length - 1]);
}

function commandToRunner(command, existingRunner) {
  return {
    id: command.runner_id,
    public_key: command.public_key,
    labels: command.labels,
    workspace_root: existingRunner?.workspace_root || command.workspace_root
  };
}

function permissionToRoles(permission) {
  switch (permission) {
    case "admin":
      return ["owner", "maintainer", "committer", "reader"];
    case "maintain":
      return ["maintainer", "committer", "reader"];
    case "write":
      return ["committer", "reader"];
    case "triage":
    case "read":
      return ["reader"];
    default:
      return ["none"];
  }
}

function parsePolicy(yaml) {
  return {
    register_runner: {
      roles: parsePolicyList(yaml, "register_runner", "roles"),
      teams: parsePolicyList(yaml, "register_runner", "teams"),
      users: parsePolicyList(yaml, "register_runner", "users")
    }
  };
}

function parsePolicyList(yaml, action, field) {
  const actionMatch = yaml.match(new RegExp(`(^|\\n)\\s{2}${escapeRegExp(action)}:\\s*\\n([\\s\\S]*?)(?=\\n\\s{2}\\S|$)`));
  if (!actionMatch) {
    return [];
  }
  const fieldMatch = actionMatch[2].match(new RegExp(`(^|\\n)\\s{4}${escapeRegExp(field)}:\\s*\\[([^\\]]*)\\]`));
  if (!fieldMatch) {
    return [];
  }
  return fieldMatch[2].split(",").map((item) => stripQuotes(item.trim())).filter(Boolean);
}

function can(policy, action, user, roles) {
  const permission = policy[action];
  if (!permission) {
    return false;
  }
  return permission.users.includes(user) || roles.some((role) => permission.roles.includes(role));
}

function parseRunner(yaml) {
  const runner = {
    id: matchYAML(yaml, "id"),
    labels: parseLabels(yaml),
    public_key: matchYAML(yaml, "public_key"),
    workspace_root: matchYAML(yaml, "workspace_root")
  };
  return runner;
}

function parseLabels(yaml) {
  const labels = {};
  let inLabels = false;
  for (const line of yaml.split("\n")) {
    if (/^labels:\s*$/.test(line)) {
      inLabels = true;
      continue;
    }
    if (!inLabels) {
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^\s{2}([^:]+):\s*(.+?)\s*$/);
    if (!match) {
      break;
    }
    labels[match[1].trim()] = stripQuotes(match[2].trim());
  }
  return labels;
}

function matchYAML(block, key) {
  const match = block.match(new RegExp(`(^|\\n)\\s{0,4}-?\\s*${escapeRegExp(key)}:\\s*(.+?)\\s*(?=\\n|$)`));
  return match ? stripQuotes(match[2].trim()) : "";
}

function marshalRunner(runner) {
  const lines = [
    `id: ${yamlScalar(runner.id)}`,
    `public_key: ${yamlScalar(runner.public_key)}`,
    "labels:"
  ];
  for (const [key, value] of Object.entries(runner.labels).sort(([a], [b]) => a.localeCompare(b))) {
    lines.push(`  ${key}: ${yamlScalar(value)}`);
  }
  lines.push(`workspace_root: ${yamlScalar(runner.workspace_root)}`);
  return `${lines.join("\n")}\n`;
}

function marshalMember(actor, roles) {
  const lines = [
    "provider: github",
    `id: ${yamlScalar(actor)}`,
    `login: ${yamlScalar(actor)}`,
    "roles:"
  ];
  for (const role of roles) {
    lines.push(`  - ${yamlScalar(role)}`);
  }
  lines.push("permissions:");
  lines.push(`  members_manage: ${roles.includes("owner") ? "true" : "false"}`);
  return lines.join("\n") + "\n";
}

function marshalMemberScope(memberID, runnerID, existingYAML) {
  const runners = new Set(existingYAML ? parseScopeList(existingYAML, "runners") : []);
  runners.add(runnerID);
  const lines = [
    `member: ${yamlScalar(memberID)}`,
    "runners:"
  ];
  for (const runner of [...runners].sort()) {
    lines.push(`  - ${yamlScalar(runner)}`);
  }
  return `${lines.join("\n")}\n`;
}

function parseScopeList(yaml, key) {
  const values = [];
  let inList = false;
  for (const line of yaml.split("\n")) {
    if (line === `${key}:`) {
      inList = true;
      continue;
    }
    if (!inList) {
      continue;
    }
    if (!line.trim()) {
      continue;
    }
    const match = line.match(/^\s{2}-\s*(.+?)\s*$/);
    if (!match) {
      break;
    }
    values.push(stripQuotes(match[1].trim()));
  }
  return values;
}

function readAutoMergeOptIn(path) {
  if (!fs.existsSync(path)) {
    return false;
  }
  return /(^|\n)\s*auto_merge_registration:\s*true\s*(\n|$)/.test(fs.readFileSync(path, "utf8"));
}

function sanitizeRefPart(value) {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "runner";
}

function runnerRegistryPath(runnerID, filename) {
  return `runners/${sanitizeRefPart(runnerID)}/${filename}`;
}

function memberRegistryPath(memberID, filename) {
  return `members/${sanitizeRefPart(memberID)}/${filename}`;
}

function yamlScalar(value) {
  if (/^[A-Za-z0-9._/@:+-]+$/.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

function stripQuotes(value) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
