const fs = require("fs");

module.exports = async function run({ github, context, core }) {
  const policyPath = ".agents/policy.yaml";
  const providersPath = ".agents/providers.yaml";
  const event = context.payload;
  const { owner, repo } = context.repo;
  const actor = requestActor(context, event);
  const issueNumber = event.issue?.number || 0;
  const baseBranch = event.repository?.default_branch || "main";
  const command = parseAgentRegisterCommand(requestBody(context, event));

  const permission = await github.rest.repos.getCollaboratorPermissionLevel({
    owner,
    repo,
    username: actor
  });
  const roles = permissionToRoles(permission.data.permission);
  const policy = parsePolicy(readFile(policyPath));
  if (!can(policy, "register_agent", actor, roles)) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar agent registration denied for \`${command.agent}\`: @${actor} is not allowed by \`${policyPath}\`.`);
    core.setFailed(`actor ${actor} is not allowed to register agents`);
    return;
  }

  const runnerPath = `runners/${sanitizeRefPart(command.runner)}/runner.yaml`;
  const runner = await getRepoFileOrNull(github, owner, repo, runnerPath, baseBranch);
  if (!runner) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar agent registration denied for \`${command.agent}\`: runner \`${command.runner}\` is not registered.`);
    core.setFailed(`runner ${command.runner} is not registered`);
    return;
  }

  const memberScopePath = `members/${sanitizeRefPart(actor)}/scope.yaml`;
  const memberScope = await getRepoFileOrNull(github, owner, repo, memberScopePath, baseBranch);
  const scopedRunners = memberScope ? parseScopeList(memberScope.text, "runners") : [];
  if (!scopedRunners.includes(command.runner)) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar agent registration denied for \`${command.agent}\`: @${actor} has no scope for runner \`${command.runner}\`.`);
    core.setFailed(`actor ${actor} has no scope for runner ${command.runner}`);
    return;
  }

  const agentPath = `agents/${sanitizeRefPart(command.agent)}/agent.yaml`;
  const current = await getRepoFileOrNull(github, owner, repo, agentPath, baseBranch);
  const updatedAgent = marshalAgent(command);
  if (current && updatedAgent === current.text) {
    await commentOnIssue(github, owner, repo, issueNumber, `Bazaar agent \`${command.agent}\` is already registered with the same configuration.`);
    await closeIssue(github, owner, repo, issueNumber);
    return;
  }

  const baseRef = await github.rest.git.getRef({
    owner,
    repo,
    ref: `heads/${baseBranch}`
  });
  const branch = `bazaar/agent-${sanitizeRefPart(command.agent)}-${Math.floor(Date.now() / 1000)}`;
  await github.rest.git.createRef({
    owner,
    repo,
    ref: `refs/heads/${branch}`,
    sha: baseRef.data.object.sha
  });
  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: agentPath,
    message: `Register Bazaar agent ${command.agent}`,
    content: Buffer.from(updatedAgent, "utf8").toString("base64"),
    branch,
    sha: current?.sha
  });
  const pr = await github.rest.pulls.create({
    owner,
    repo,
    title: `Register Bazaar agent ${command.agent}`,
    body: [
      `Requested by @${actor} via \`/r agent register\`.`,
      "",
      `This PR updates \`${agentPath}\` and binds the agent to runner \`${command.runner}\`.`,
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
      commit_title: `Register Bazaar agent ${command.agent}`,
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

  core.info(`Bazaar agent registration PR ${merged ? "opened and merged" : "opened"} for ${command.agent}: ${pr.data.html_url}`);
  await commentOnIssue(github, owner, repo, issueNumber, `Bazaar agent registration PR ${merged ? "opened and merged" : "opened"} for \`${command.agent}\`: ${pr.data.html_url}`);
  if (merged) {
    await closeIssue(github, owner, repo, issueNumber);
  }
};

function requestActor(context, event) {
  if (context.eventName === "issues") {
    return event.issue?.user?.login || "";
  }
  return event.comment?.user?.login || "";
}

function requestBody(context, event) {
  if (context.eventName === "issues") {
    return event.issue?.body || "";
  }
  return event.comment?.body || "";
}

function parseAgentRegisterCommand(body) {
  const fields = body.trim().split(/\s+/).filter(Boolean);
  if (fields.length < 4 || fields[0] !== "/r" || fields[1] !== "agent" || fields[2] !== "register") {
    throw new Error("not an /r agent register command");
  }
  const command = {
    agent: "",
    labels: {},
    model: "",
    runner: "",
    secret_ref: "",
    type: ""
  };
  for (const field of fields.slice(3)) {
    const idx = field.indexOf("=");
    if (idx <= 0 || idx === field.length - 1) {
      throw new Error(`invalid agent registration option ${field}`);
    }
    const key = field.slice(0, idx);
    const value = field.slice(idx + 1);
    if (key === "agent" || key === "name") {
      command.agent = value;
    } else if (key === "runner" || key === "runner_id") {
      command.runner = value;
    } else if (key === "type" || key === "runtime") {
      command.type = value;
    } else if (key === "model") {
      command.model = value;
    } else if (key === "credential_profile") {
      command.credential_profile = value;
    } else if (key === "secret_ref" || key === "env_ref" || key === "token_file_ref" || key === "credential_store_ref") {
      command.secret_ref = value;
    } else {
      command.labels[key.replace(/^label\./, "")] = value;
    }
  }
  if (!command.agent) {
    throw new Error("missing agent");
  }
  if (!command.runner) {
    throw new Error("missing runner");
  }
  if (!command.type) {
    throw new Error("missing type");
  }
  return command;
}

function marshalAgent(command) {
  const lines = [
    `name: ${yamlScalar(command.agent)}`,
    `type: ${yamlScalar(command.type)}`,
    `runtime: ${yamlScalar(command.type)}`,
    `runner: ${yamlScalar(command.runner)}`
  ];
  if (command.model) {
    lines.push(`model: ${yamlScalar(command.model)}`);
  }
  if (Object.keys(command.labels).length) {
    lines.push("selector:");
    for (const [key, value] of Object.entries(command.labels).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`  ${key}: ${yamlScalar(value)}`);
    }
  }
  if (command.credential_profile) {
    lines.push(`credential_profile: ${yamlScalar(command.credential_profile)}`);
  }
  if (command.secret_ref) {
    lines.push(`secret_ref: ${yamlScalar(command.secret_ref)}`);
  }
  return `${lines.join("\n")}\n`;
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
    register_agent: {
      roles: parsePolicyList(yaml, "register_agent", "roles"),
      teams: parsePolicyList(yaml, "register_agent", "teams"),
      users: parsePolicyList(yaml, "register_agent", "users")
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
  return out || "agent";
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
