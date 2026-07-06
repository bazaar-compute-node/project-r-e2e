const fs = require("fs");

module.exports = async function run({ github, context, core }) {
  const policyPath = ".agents/policy.yaml";
  const event = context.payload;
  const { owner, repo } = context.repo;
  const source = requestSource(context, event);
  const actor = source.actor;
  const issueNumber = event.issue?.number || 0;
  const baseBranch = event.repository?.default_branch || "main";
  const command = parseRunCommand(source.body);

  const permission = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor
  });
  const roles = permissionToRoles(permission.data.permission);
  const policy = parsePolicy(readFile(policyPath));
  if (!can(policy, "run", actor, roles)) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar run denied for agent \`${command.agent}\`: @${actor} is not allowed by \`${policyPath}\`.`);
    core.setFailed(`actor ${actor} is not allowed to run Bazaar tasks`);
    return;
  }

  const agentPath = `agents/${sanitizeRefPart(command.agent)}/agent.yaml`;
  const agent = await getRepoFileOrNull(github, owner, repo, agentPath, baseBranch);
  if (!agent) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar run denied for agent \`${command.agent}\`: \`${agentPath}\` is not registered. Register it with \`bcn agent register\` first.`);
    core.setFailed(`agent ${command.agent} is not registered`);
    return;
  }

  const spec = {
    kind: "bazaar/task-spec",
    apiVersion: "bazaar.dev/v0",
    task_id: `r-${source.kind}-${source.id}`,
    config_ref: `${baseBranch}@${context.sha}`,
    requested_by: actor,
    source: {
      repo: `${owner}/${repo}`,
      issue: issueNumber,
      comment: source.id,
      kind: source.kind,
      id: source.id
    },
    selector: {
      agent: command.agent
    },
    prompt: command.prompt,
    created_at: new Date().toISOString()
  };
  if (Object.keys(command.labels).length) {
    spec.selector.labels = command.labels;
  }

  await commentOnIssue(github, owner, repo, issueNumber, marshalBlock(spec));
};

function requestSource(context, event) {
  if (context.eventName === "issues") {
    return {
      kind: "issue_body",
      id: event.issue?.id || event.issue?.number || 0,
      actor: event.issue?.user?.login || "",
      body: event.issue?.body || ""
    };
  }
  return {
    kind: "issue_comment",
    id: event.comment?.id || 0,
    actor: event.comment?.user?.login || "",
    body: event.comment?.body || ""
  };
}

function parseRunCommand(body) {
  const fields = body.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 3 || fields[0] !== "/r" || fields[1] !== "run") {
    throw new Error("expected /r run <prompt>");
  }

  const command = {
    agent: "codex",
    labels: {},
    prompt: ""
  };
  let promptStart = 2;
  for (let i = 2; i < fields.length; i++) {
    const idx = fields[i].indexOf("=");
    if (idx <= 0 || idx === fields[i].length - 1) {
      promptStart = i;
      break;
    }
    const key = fields[i].slice(0, idx);
    const value = fields[i].slice(idx + 1);
    if (key === "agent") {
      command.agent = value;
    } else {
      command.labels[key.replace(/^label\./, "")] = value;
    }
    promptStart = i + 1;
  }
  if (promptStart >= fields.length) {
    throw new Error("missing prompt");
  }
  command.prompt = fields.slice(promptStart).join(" ").trim();
  if (!command.prompt) {
    throw new Error("missing prompt");
  }
  return command;
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
    run: {
      roles: parsePolicyList(yaml, "run", "roles"),
      teams: parsePolicyList(yaml, "run", "teams"),
      users: parsePolicyList(yaml, "run", "users")
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

function marshalBlock(value) {
  return `\`\`\`bazaar\n${JSON.stringify(value, null, 2)}\n\`\`\``;
}

function sanitizeRefPart(value) {
  const out = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return out || "agent";
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
