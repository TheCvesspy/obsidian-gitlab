# Obsidian GitLab Plugin — Implementation Summary

> **Version 2.0** · Author: Quill of the Weavers

---

## Architecture

**Plugin Pattern**: Standard Obsidian plugin (`Plugin` base class)
**Language**: TypeScript with strict type checking
**Git Backend**: Hybrid — system Git CLI primary, isomorphic-git fallback
**GitLab API**: Direct `fetch` calls to GitLab REST API v4
**Build System**: esbuild for fast compilation
**Platform**: Desktop only (Electron/Node.js)

### Backend selection

On plugin load, `GitCliExecutor.detect()` probes for a `git` binary on PATH. If found, `RepositoryManager` is configured with a backend factory that constructs `GitCliBackend` instances. If not, it falls back to `GitIsoBackend` (the original isomorphic-git code wrapped behind the `IGitBackend` interface). Both backends implement the same interface — repository state, UI, and the Pages-compat pipeline are agnostic to which one is in use.

```
                 ┌──────────────────────┐
                 │  RepositoryManager   │
                 └─────────┬────────────┘
                           │
                  ┌────────┴───────┐
              uses │ IGitBackend   │ interface
                  └────────┬───────┘
            ┌──────────────┴───────────────┐
            │                              │
   ┌────────▼────────┐           ┌─────────▼──────────┐
   │  GitCliBackend  │           │   GitIsoBackend    │
   │  (preferred)    │           │   (fallback)       │
   ├─────────────────┤           ├────────────────────┤
   │ child_process   │           │ isomorphic-git +   │
   │ + sparse-checkout│          │ custom HTTP client │
   │ + hard-link     │           │                    │
   │   mirroring     │           │                    │
   └─────────────────┘           └────────────────────┘
```

---

## Project Structure

```
src/
├── main.ts                              # Plugin entry, command registration, settings tab
├── settings.ts                          # Settings persistence + cross-repo validation
├── types.ts                             # All TypeScript interfaces and types
├── api/
│   ├── git-backend.ts                   # IGitBackend interface + shared types
│   ├── git-cli-backend.ts               # CLI implementation of IGitBackend (~1100 lines)
│   ├── git-cli-executor.ts              # child_process.execFile wrapper + auth + SSL
│   ├── git-status-parser.ts             # git status --porcelain=v2 → GitFile[]
│   ├── git-iso-backend.ts               # isomorphic-git adapter to IGitBackend
│   ├── git-operations.ts                # legacy GitOperations class (wrapped by iso-backend)
│   ├── sparse-checkout.ts               # High-level sparse checkout orchestration
│   └── gitlab-client.ts                 # GitLab REST API client (MRs, project info, tree)
├── core/
│   ├── repository-manager.ts            # Multi-repository state, sparse + junction-aware
│   ├── junction-manager.ts              # Lifecycle + path translation for hidden-clone mode
│   ├── junction-migration.ts            # One-shot move clone → .gitlab-clones/<id>/
│   ├── pages-compat-pipeline.ts         # GitLab Pages markdown transform pipeline
│   └── asset-mover.ts                   # Out-of-repo image asset relocator
├── ui/
│   ├── side-panel-view.ts               # Main sidebar panel (ItemView)
│   ├── git-graph-view.ts                # Git graph visualization
│   ├── diff-view.ts                     # File diff viewer
│   ├── file-history-view.ts             # File history & blame
│   ├── conflict-resolution-view.ts      # Merge conflict resolver
│   ├── repository-modal.ts              # Repo add/edit modal (incl. sparse + hiddenClone UI)
│   ├── sparse-tree-picker-modal.ts      # Folder-tree picker for sparse paths
│   ├── merge-request-modal.ts           # GitLab MR creation
│   ├── quick-commit-modal.ts            # Quick commit (command palette)
│   ├── quick-actions-modal.ts           # Quick push/pull/branch
│   ├── move-files-modal.ts              # Move/rename files
│   ├── upload-files-modal.ts            # Upload new files into repo
│   ├── file-explorer-status.ts          # File explorer status decorations (junction-aware)
│   └── components/
│       └── header-bar.ts                # Side panel sticky header (incl. sparse badge)
└── utils/
    ├── junction-utils.ts                # Junction + hard-link-mirror filesystem helpers
    ├── diff.ts                          # Myers diff algorithm
    ├── path-utils.ts                    # Path normalization
    ├── validators.ts                    # Input validation
    ├── icons.ts                         # GitLab logo SVG + icon registration
    ├── help-text.ts                     # Contextual help text
    └── debug-logger.ts                  # Debug logging with history
```

---

## Features

### Core Git Operations
- Clone (incl. `--filter=blob:none` partial clone via CLI), pull, push, fetch
- Commit (with optional transform hook for Pages compat), amend, revert
- Branch create, switch, delete, list (local + remote)
- Stash push/pop/apply/list/drop/clear
- Tag create/delete/push (lightweight + annotated)
- Status matrix with CRLF handling

### Sparse Checkout (2.0 — CLI backend only)
- Cone-mode sparse checkout configured per repository
- **Strict cone variant**: root files NOT auto-included (unlike Git's default `/*` pattern)
- Folder-tree picker UI with auto-source (local `git ls-tree` if cloned, else GitLab API tree fetch)
- Manual apply path bypasses Git for Windows 2.53 crash in `git sparse-checkout set`:
  - Writes patterns file directly to `.git/info/sparse-checkout`
  - Walks index via `git ls-files`, applies `--skip-worktree` to outside-cone files
  - Deletes excluded files from working tree
  - Sets `core.sparseCheckout = true`, `core.sparseCheckoutCone = true` via `git config`
- Stale `sparse-checkout.lock` cleanup (Git on Windows can leave them behind on crash)

### Hidden Clone + Hard-Link Mirror Aliases (2.0 — Windows + CLI)
- Per-repo opt-in mode: clone moves to `.gitlab-clones/<repo-id>/` (hidden by leading dot)
- Each sparse path gets a user-chosen vault alias path
- **NTFS hard-link mirroring** instead of directory junctions because Obsidian's indexer doesn't follow reparse points
- `JunctionManager.reconcile()`:
  - Walks each alias's source folder
  - Creates real directories in the vault containing hard links to clone files
  - Detects already-correct hard links via inode + dev comparison (idempotent, cheap)
  - Sweeps stale hard links and empty directories
- Path translation API (`vaultPathToRepoRelative` / `repoRelativeToVaultPath`) used by:
  - `findRepoForFile` in main.ts
  - `getRepositoryForFile`/`Folder`/`getRepositoryIdForPath`/`isFileInRepository`/`getFileStatus` in repository-manager
  - `buildStatusMap` and `buildFolderStatusMap` in file-explorer-status
- Migration is rollback-safe: `fs.renameSync` for atomic move within vault root, wrapped in try/catch with restore

### UI Features
- **Side Panel** with sticky header bar (repo selector, branch dropdown, sync status, sparse badge)
- **Git Graph**: branch/merge visualization
- **Diff Viewer**: unified diff with line numbers
- **File History** + change-author annotations (blame)
- **Conflict Resolution**: three-option resolver
- **Quick Commands**: modal-based commit, push, pull, branch switch
- **Collapsible Sections**, **Help Tooltips**, **Branch Dropdown**
- **Commit Templates** with `{jira} {branch} {date} {author}` variables
- **Exclude Patterns**: glob-based file filtering
- **Repository File Browser**, **Merge Request Creation**, **Tags**, **Stash**
- **Debug Logging**: full HTTP request/response logging with export
- **Sparse Tree Picker**: tri-state checkboxes, live filter, expand/collapse all, auto-source from local clone or GitLab API

### GitLab Pages Compatibility
- Two-pass commit-time transform pipeline:
  - Pass 1: discover & move out-of-repo image assets into the repo's assets folder
  - Pass 2: rewrite `![[…]]` embeds, `[[…]]` wiki links, and `> [!…]` callouts to standard Markdown
- Transformed bytes spliced into Git index via `hash-object -w --stdin` + `update-index --cacheinfo`
- Vault notes are never modified — only the Git index
- Workdir-OID snapshot tracking suppresses the false "always modified" status that would otherwise appear

### Corporate GitLab Support
- SSL verification disable option (per-repo) — sets `GIT_SSL_NO_VERIFY` env var for CLI, toggles `NODE_TLS_REJECT_UNAUTHORIZED` for iso backend
- CLI backend embeds PAT in remote URL (`https://oauth2:<token>@host/...`) — replaces the iso backend's multi-format auth fallback (token-as-username → oauth2 → CI token)
- `.git` suffix auto-normalization
- Gzip workaround (`Accept-Encoding: identity`) for iso backend's HTTP client

---

## Key Technical Decisions

1. **Hybrid Git backend** — Git CLI primary because it supports sparse checkout, partial clones, and faster operations. isomorphic-git kept as a fallback for environments without Git (sandbox compatibility was the original rationale; preserved as a graceful degradation path).

2. **IGitBackend interface** — Extracted from the original `GitOperations` class. Both backends `implements IGitBackend`; everything else (UI, manager, pipeline) consumes the interface. Enables the hybrid model without conditional logic scattered through callers.

3. **Manual sparse-checkout apply** — `git sparse-checkout set` crashes on Git for Windows 2.53 with "invalid path '/'". The plugin bypasses this by writing the patterns file directly and using plumbing commands (`git update-index --skip-worktree`, manual file deletion) to enforce the cone. Same end-state, no crash.

4. **Strict cone mode** — The plugin drops the `/*` root-include pattern from cone-mode setups. Documentation-vault users typically want only their selected folders, not the entire repo root.

5. **Hard-link mirror over directory junction** — Obsidian doesn't index reparse points. Hard links share the same inode as the clone file so edits flow through transparently, but each file is a real entry from Obsidian's perspective.

6. **Strict cone alias matching** — `matchesCone` in git-cli-backend treats root-level files as outside the cone (vs. Git default). Aligns with strict cone mode pattern generation.

7. **Path translation centralized** in `JunctionManager` — Every UI / ownership-check site that needs to map between vault paths and repo paths goes through one of two methods. No prefix matching scattered across files.

8. **Myers diff algorithm (in-house)** — No external dependency for diff computation.

9. **Simplified blame via log walking** — `git-cli-backend` uses `git blame --porcelain` directly; `git-iso-backend` walks history (isomorphic-git has no native blame).

10. **Render guard pattern** — Prevents overlapping async renders in ItemView.

11. **CRLF auto-handling** — Sets `core.autocrlf=true` on Windows to prevent false "modified" status.

12. **Scroll/focus preservation** — Saves and restores scroll position, focused element, and cursor across re-renders.

---

## Data Schema (excerpts from `src/types.ts`)

```typescript
interface SubTreeConfig {
    id: string;
    name: string;
    localPath: string;            // legacy / default base path for alias seeding
    repositoryUrl: string;
    token: string;
    currentBranch: string;
    enabled: boolean;
    disableSslVerification?: boolean;
    ignorePatterns?: string[];
    gitlabPagesCompat?: GitLabPagesCompatConfig;
    sparseCheckout?: SparseCheckoutConfig;
    hiddenClone?: HiddenCloneConfig;
}

interface SparseCheckoutConfig {
    enabled: boolean;
    paths: string[];              // repo-root-relative, forward-slash
}

interface HiddenCloneConfig {
    enabled: boolean;
    cloneFolder: string;          // default: .gitlab-clones/<repo-id>
    aliases: Record<string, string>;  // sparse path -> vault alias path
}
```

---

## Migration & Backward Compatibility

- **1.x → 2.0**: Existing repositories load without any change. They start on the CLI backend if Git is detected (same `.git` directory works for both backends) or the iso backend otherwise. Sparse checkout and hidden-clone are opt-in per repo.
- **Sparse checkout is reversible**: untoggle the option to restore the full working tree via `git sparse-checkout disable`.
- **Hidden clone is forward-only by design**: untoggling removes the junctions/mirrors but leaves the clone in the hidden folder. Users can manually rename to restore the old layout if desired.

---

## Build & Deploy

```bash
npm run build              # TypeScript check + esbuild production bundle
node release.mjs           # Copies main.js, manifest.json, styles.css to _release/
```

Deploy to a vault by copying the three artefact files into `<vault>/.obsidian/plugins/obsidian-gitlab/`.

---

## License

MIT License
