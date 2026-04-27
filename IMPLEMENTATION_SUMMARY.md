# Obsidian GitLab Plugin — Implementation Summary

> **Version 1.2** · Author: Quill of the Weavers

---

## Architecture

**Plugin Pattern**: Standard Obsidian plugin (`Plugin` base class)
**Language**: TypeScript with strict type checking
**Git Client**: isomorphic-git (pure JavaScript — no CLI dependency, works cross-platform)
**GitLab API**: Direct `fetch` calls to GitLab REST API v4
**Build System**: esbuild for fast compilation
**Platform**: Desktop only (Electron/Node.js)

---

## Project Structure

```
src/
├── main.ts                         # Plugin entry point, command registration, settings tab
├── settings.ts                     # Settings persistence manager
├── types.ts                        # All TypeScript interfaces and types
├── api/
│   ├── git-operations.ts           # All Git operations via isomorphic-git
│   └── gitlab-client.ts            # GitLab REST API client (MRs, project info)
├── core/
│   └── repository-manager.ts       # Multi-repository state coordination
├── ui/
│   ├── side-panel-view.ts          # Main sidebar panel (ItemView)
│   ├── git-graph-view.ts           # Git graph visualization (ItemView)
│   ├── diff-view.ts                # File diff viewer (ItemView)
│   ├── file-history-view.ts        # File history & blame (ItemView)
│   ├── conflict-resolution-view.ts # Merge conflict resolver (ItemView)
│   ├── repository-modal.ts         # Repository add/edit modal
│   ├── merge-request-modal.ts      # GitLab MR creation modal
│   ├── quick-commit-modal.ts       # Quick commit modal (command palette)
│   ├── quick-actions-modal.ts      # Quick push/pull/branch modals
│   └── file-explorer-status.ts     # File explorer status decorations
└── utils/
    ├── diff.ts                     # Myers diff algorithm implementation
    ├── path-utils.ts               # Path normalization utilities
    ├── validators.ts               # Input validation (URLs, paths)
    ├── icons.ts                    # GitLab logo SVG + icon registration
    ├── help-text.ts                # Contextual help text for UI sections
    └── debug-logger.ts             # Debug logging with history
```

---

## Features

### Core Git Operations
- Clone, pull, push, fetch with multi-format auth fallback
- Commit with staging/unstaging, author info
- Branch create, switch, delete, list
- Stash push/pop/apply/drop/clear
- Tag create/delete/push
- Status matrix with CRLF handling (core.autocrlf)

### UI Features
- **Side Panel**: Full git controls in Obsidian sidebar
- **Git Graph**: Branch/merge visualization with author info
- **Diff Viewer**: Unified diff with line numbers, add/remove highlighting
- **File History**: Commit-level file history with content preview
- **Change Authors**: Line-level blame annotations
- **Conflict Resolution**: Three-option resolver (ours/theirs/both)
- **Quick Commands**: Modal-based commit, push, pull, branch switch from command palette
- **Collapsible Sections**: Save UI space
- **Branch Dropdown**: Inline branch switching (no modal needed)
- **New Branch Publishing**: Push new local branches to remote
- **Commit Templates**: Pre-defined templates with {jira}, {branch}, {date}, {author} variables
- **Exclude Patterns**: Glob-based file filtering (like .gitignore)
- **Repository File Browser**: Browse tracked files
- **Merge Request Creation**: Create GitLab MRs from Obsidian
- **Help Tooltips**: ⓘ icons with contextual help for each section
- **Debug Logging**: Full HTTP request/response logging with export

### Corporate GitLab Support
- SSL verification disable option (self-signed certificates)
- Multi-format auth fallback (token-as-username → oauth2 → CI token)
- Gzip workaround (`Accept-Encoding: identity`)
- `.git` suffix normalization for git-upload-pack

---

## Key Technical Decisions

1. **isomorphic-git over Git CLI** — No external dependencies, works in Electron sandbox
2. **Direct fetch over @gitbeaker** — Smaller bundle, fewer dependencies
3. **Myers diff algorithm (in-house)** — No dependency for diff computation
4. **Simplified blame via log walking** — isomorphic-git has no native blame
5. **Render guard pattern** — Prevents overlapping async renders in ItemView
6. **CRLF auto-handling** — Sets `core.autocrlf=true` on Windows to prevent false "modified" status
7. **Scroll/focus preservation** — Saves and restores scroll position, focused element, and cursor across re-renders

---

## Build & Deploy

```bash
npm run build          # TypeScript check + esbuild production bundle
node release.mjs       # Copies main.js, manifest.json, styles.css to _release/
```

---

## License

MIT License