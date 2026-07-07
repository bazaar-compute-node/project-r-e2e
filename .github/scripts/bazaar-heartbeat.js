module.exports = async function run({ github, context, core }) {
  const { owner, repo } = context.repo;
  const baseBranch = context.payload.repository?.default_branch || "main";
  const registryPath = "heartbeat.yaml";
  const statusTitle = "Bazaar runners status";

  const runners = await listRegisteredRunners(github, owner, repo, baseBranch);
  if (runners.length === 0) {
    core.info("No registered Bazaar runners found; heartbeat registry unchanged.");
    return;
  }

  const current = await getRepoFileOrNull(github, owner, repo, registryPath, baseBranch);
  const registry = current ? parseHeartbeatRegistry(current.text) : emptyRegistry();
  const issue = await ensureStatusIssue(github, owner, repo, registry, statusTitle);
  let changed = !current || registry.issue !== issue.number || registry.issue_url !== issue.html_url;
  registry.issue = issue.number;
  registry.issue_url = issue.html_url;

  for (const runner of runners) {
    if (!registry.runners[runner.id]) {
      registry.runners[runner.id] = {};
      changed = true;
    }
    const entry = registry.runners[runner.id];
    if (!entry.comment_id) {
      const comment = await github.rest.issues.createComment({
        owner,
        repo,
        issue_number: issue.number,
        body: initialStatusComment(runner.id)
      });
      entry.comment_id = comment.data.id;
      entry.comment_url = comment.data.html_url;
      entry.state = "pending";
      entry.updated_at = new Date().toISOString();
      changed = true;
    }
  }

  const nextText = marshalHeartbeatRegistry(registry);
  if (current && current.text === nextText && !changed) {
    core.info(`${registryPath} is already current.`);
    return;
  }

  await github.rest.repos.createOrUpdateFileContents({
    owner,
    repo,
    path: registryPath,
    message: "Update Bazaar heartbeat registry",
    content: Buffer.from(nextText, "utf8").toString("base64"),
    branch: baseBranch,
    sha: current?.sha
  });
  core.info(`Updated ${registryPath} for ${runners.length} runner(s).`);
};

async function listRegisteredRunners(github, owner, repo, ref) {
  const dirs = await getRepoDirectoryOrNull(github, owner, repo, "runners", ref);
  if (!dirs) {
    return [];
  }
  const runners = [];
  for (const item of dirs) {
    if (item.type !== "dir") {
      continue;
    }
    const path = `runners/${item.name}/runner.yaml`;
    const loaded = await getRepoFileOrNull(github, owner, repo, path, ref);
    if (!loaded) {
      continue;
    }
    const id = matchYAML(loaded.text, "id") || item.name;
    runners.push({ id });
  }
  return runners.sort((a, b) => a.id.localeCompare(b.id));
}

async function ensureStatusIssue(github, owner, repo, registry, title) {
  if (registry.issue > 0) {
    try {
      const issue = await github.rest.issues.get({ owner, repo, issue_number: registry.issue });
      if (!issue.data.pull_request) {
        if (issue.data.state !== "open") {
          const reopened = await github.rest.issues.update({
            owner,
            repo,
            issue_number: registry.issue,
            state: "open"
          });
          return reopened.data;
        }
        return issue.data;
      }
    } catch (error) {
      if (error.status !== 404) {
        throw error;
      }
    }
  }

  for await (const response of github.paginate.iterator(github.rest.issues.listForRepo, {
    owner,
    repo,
    state: "open",
    per_page: 100
  })) {
    const found = response.data.find((issue) => !issue.pull_request && issue.title === title);
    if (found) {
      return found;
    }
  }

  const created = await github.rest.issues.create({
    owner,
    repo,
    title,
    body: [
      "Bazaar runner heartbeat status lives here.",
      "",
      "Each registered runner has one editable status comment. Normal heartbeats update the runner comment instead of creating new comments."
    ].join("\n")
  });
  return created.data;
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

async function getRepoDirectoryOrNull(github, owner, repo, path, ref) {
  try {
    const response = await github.rest.repos.getContent({ owner, repo, path, ref });
    if (!Array.isArray(response.data)) {
      throw new Error(`${path} is not a directory`);
    }
    return response.data;
  } catch (error) {
    if (error.status === 404) {
      return null;
    }
    throw error;
  }
}

function initialStatusComment(runnerID) {
  return [
    `Bazaar runner \`${runnerID}\` status: \`pending\``,
    "",
    "Waiting for the first signed heartbeat.",
    "",
    "<details><summary>details</summary>",
    "",
    "This comment is reserved for Bazaar runner heartbeat updates.",
    "",
    "</details>"
  ].join("\n");
}

function emptyRegistry() {
  return {
    issue: 0,
    issue_url: "",
    runners: {}
  };
}

function parseHeartbeatRegistry(text) {
  const registry = emptyRegistry();
  let section = "";
  let currentRunner = "";
  for (const line of text.split(/\r?\n/)) {
    let match = line.match(/^([A-Za-z0-9_-]+):\s*$/);
    if (match) {
      section = match[1];
      currentRunner = "";
      continue;
    }
    if (section === "heartbeat") {
      match = line.match(/^  issue:\s*(\d+)/);
      if (match) {
        registry.issue = Number(match[1]);
        continue;
      }
      match = line.match(/^  issue_url:\s*(.+)$/);
      if (match) {
        registry.issue_url = unquoteYAML(match[1]);
      }
      continue;
    }
    if (section !== "runners") {
      continue;
    }
    match = line.match(/^  ([^:\s]+):\s*$/);
    if (match) {
      currentRunner = unquoteYAML(match[1]);
      registry.runners[currentRunner] = registry.runners[currentRunner] || {};
      continue;
    }
    if (!currentRunner) {
      continue;
    }
    match = line.match(/^    comment_id:\s*(\d+)/);
    if (match) {
      registry.runners[currentRunner].comment_id = Number(match[1]);
      continue;
    }
    match = line.match(/^    comment_url:\s*(.+)$/);
    if (match) {
      registry.runners[currentRunner].comment_url = unquoteYAML(match[1]);
      continue;
    }
    match = line.match(/^    state:\s*(.+)$/);
    if (match) {
      registry.runners[currentRunner].state = unquoteYAML(match[1]);
      continue;
    }
    match = line.match(/^    updated_at:\s*(.+)$/);
    if (match) {
      registry.runners[currentRunner].updated_at = unquoteYAML(match[1]);
    }
  }
  return registry;
}

function marshalHeartbeatRegistry(registry) {
  const lines = [
    "heartbeat:",
    `  issue: ${registry.issue}`,
    `  issue_url: ${yamlScalar(registry.issue_url || "")}`,
    "runners:"
  ];
  for (const runner of Object.keys(registry.runners).sort()) {
    const entry = registry.runners[runner];
    lines.push(`  ${yamlScalar(runner)}:`);
    lines.push(`    comment_id: ${Number(entry.comment_id || 0)}`);
    lines.push(`    comment_url: ${yamlScalar(entry.comment_url || "")}`);
    lines.push(`    state: ${yamlScalar(entry.state || "pending")}`);
    lines.push(`    updated_at: ${yamlScalar(entry.updated_at || "")}`);
  }
  return `${lines.join("\n")}\n`;
}

function matchYAML(text, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(new RegExp(`^\\s{0,4}${escaped}:\\s*(.+?)\\s*$`, "m"));
  return match ? unquoteYAML(match[1]) : "";
}

function yamlScalar(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_.:/@+-]+$/.test(text)) {
    return text;
  }
  return JSON.stringify(text);
}

function unquoteYAML(value) {
  const text = String(value).trim();
  if ((text.startsWith("\"") && text.endsWith("\"")) || (text.startsWith("'") && text.endsWith("'"))) {
    return text.slice(1, -1);
  }
  return text;
}
