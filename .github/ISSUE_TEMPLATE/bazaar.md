---
name: Bazaar
about: Bazaar run commands and audited registration commands
title: "Bazaar"
labels: ["bazaar"]
---

Post Bazaar run commands as comments in this issue. Normal runner registration
creates its own audited registration issue with `bcn register`.

```text
/r run agent=codex label.pool=default describe the repository
```

```text
/r register runner=runner-1 pubkey=ed25519:... workspace_root=.bazaar/workspaces/<uuid> label.pool=default
```
