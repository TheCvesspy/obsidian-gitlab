# GitLab Integration for Obsidian — User Guide

> **Version 2.0** · Author: Quill of the Weavers

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Git Backend (CLI vs isomorphic-git)](#git-backend-cli-vs-isomorphic-git)
3. [Plugin Settings](#plugin-settings)
4. [Side Panel Overview](#side-panel-overview)
5. [Repository Selector](#repository-selector)
6. [Branch Management](#branch-management)
7. [Sync Status](#sync-status)
8. [Action Buttons](#action-buttons)
9. [Changes & Staging](#changes--staging)
10. [Commit Section](#commit-section)
11. [Commit Templates](#commit-templates)
12. [Stash](#stash)
13. [Tags](#tags)
14. [Repository File Browser](#repository-file-browser)
15. [Recent Commits](#recent-commits)
16. [Diff Viewer](#diff-viewer)
17. [File History & Change Authors](#file-history--change-authors)
18. [Git Graph](#git-graph)
19. [Merge Request Creation](#merge-request-creation)
20. [Conflict Resolution](#conflict-resolution)
21. [Exclude Patterns](#exclude-patterns)
22. [Sparse Checkout](#sparse-checkout)
23. [Hidden Clone & Mirror Aliases](#hidden-clone--mirror-aliases)
24. [GitLab Pages Compatibility](#gitlab-pages-compatibility)
25. [Quick Commands](#quick-commands)
26. [Debug Logging](#debug-logging)
27. [Command Palette](#command-palette)
28. [Keyboard Shortcuts](#keyboard-shortcuts)
29. [Troubleshooting](#troubleshooting)

---

## Getting Started

### What This Plugin Does

This plugin connects folders (sub-trees) in your Obsidian vault to GitLab repositories, giving you full version control directly inside Obsidian. Each folder can be linked to a different repository — ideal for documentation-as-code workflows.

### First-Time Setup

1. **Open Settings** → Community Plugins → GitLab Integration → ⚙️ Settings
2. **Set your author info**: Enter your name and email under "Global Settings" — these appear on your commits
3. **Add a repository mapping**:
   - Click **"Add Repository Mapping"**
   - Fill in a friendly name (e.g. "Project Docs")
   - Set **Local Path** to the vault folder (e.g. `Documentation/ProjectX`)
   - Paste the **GitLab Repository URL** (e.g. `https://gitlab.com/team/project-docs.git`)
   - Enter your **Personal Access Token** (needs `read_repository` + `write_repository` scopes)
   - Set the **Default Branch** (usually `main`)
   - For corporate/self-hosted GitLab with self-signed certificates, enable **Disable SSL Verification**
4. **Open the panel**: Click the Git branch icon (🔀) in the left ribbon, or use the command palette: `Open GitLab Panel`
5. **Pull** to fetch the latest content from your repository

---

## Git Backend (CLI vs isomorphic-git)

Version 2.0 introduced a hybrid Git backend. On startup the plugin probes for a `git` binary on your PATH:

- **Git CLI found** → all operations run through the CLI. Sparse checkout, hidden-clone aliases, partial clones (`--filter=blob:none`), and other advanced features are available. Fastest path, full feature parity with command-line Git.
- **Git CLI not found** → falls back to the built-in [isomorphic-git](https://isomorphic-git.org/) (pure JavaScript Git). No system dependency, but no sparse checkout or hidden-clone support.

You can see which backend is active in **Settings → GitLab Integration** at the top of the page, e.g.:

```
Git backend: CLI — git 2.43.0 (git). Sparse checkout available.
```

or

```
Git backend: Built-in (isomorphic-git). Install Git CLI to enable sparse checkout.
```

The two backends are interchangeable for existing repositories — switching from one to the other (by installing or uninstalling Git CLI) needs only a plugin reload. The repository on disk is just a normal Git working directory; either backend operates on it the same way.

---

## Plugin Settings

Access via: **Settings → Community Plugins → GitLab Integration → ⚙️**

### Global Settings

| Setting | Description |
|---------|-------------|
| **Default Author Name** | Your name as it appears on Git commits |
| **Default Author Email** | Your email as it appears on Git commits |
| **Show Status Indicators** | Toggle colored status badges (M/A/D/?) in the Obsidian file explorer |
| **Auto-Fetch Interval** | Periodically check remote for new changes (in minutes, `0` = disabled) |

### Repository Mappings

Each mapping connects a vault folder to a GitLab repository. You can have multiple mappings — each folder connects to exactly one repository.

| Field | Description |
|-------|-------------|
| **Repository Name** | A friendly label (shown in the panel dropdown) |
| **Local Path** | The folder path inside your vault |
| **GitLab Repository URL** | HTTPS URL of the Git repository (`.git` suffix is added automatically) |
| **Personal Access Token** | Your GitLab token for authentication |
| **Default Branch** | Branch to use when initializing (typically `main` or `master`) |
| **Enabled** | Toggle this repository on/off without removing the configuration |
| **Disable SSL Verification** | For corporate GitLab with self-signed certificates |
| **Exclude Patterns** | Glob patterns for files/folders to hide from the plugin (see [Exclude Patterns](#exclude-patterns)) |

### Commit Templates

Predefined message formats you can quickly apply when committing. See [Commit Templates](#commit-templates).

### Configuration Import/Export

- **Export**: Save all repository configurations to a JSON file (tokens included — handle securely!)
- **Import**: Load configurations from a previously exported JSON file

---

## Side Panel Overview

The side panel is your main workspace for Git operations. Open it by:
- Clicking the **Git branch icon** (🔀) in the left ribbon
- Command palette: **"Open GitLab Panel"**

The panel contains these sections from top to bottom:

1. **Repository Selector** — choose which repository to work with
2. **Current Branch** — see and switch branches
3. **Sync Status** — ahead/behind indicators
4. **Action Buttons** — Pull, Push, Fetch, Graph, MR
5. **Changes** — list of modified files with staging checkboxes
6. **Commit** — write commit messages with JIRA and template support
7. **Stash** — save and restore work-in-progress
8. **Tags** — create and manage version tags
9. **Repository Files** — browse all files (including non-Markdown)
10. **Recent Commits** — last 10 commits on current branch

---

## Repository Selector

If you have multiple repository mappings configured, use the dropdown at the top of the side panel to switch between them. The panel updates to show the status of the selected repository.

---

## Branch Management

The **Current Branch** section shows your active branch and provides:

| Button | Action |
|--------|--------|
| **Switch Branch** | Opens a list of available local branches to switch to |
| **New Branch** | Creates a new branch from the current HEAD and switches to it |

> **Tip**: Create feature branches for different documentation tasks, then merge them via Merge Requests.

---

## Sync Status

Shows the relationship between your local branch and the remote:

| Indicator | Meaning |
|-----------|---------|
| **↑ N ahead** | You have N local commits not yet pushed to the remote |
| **↓ N behind** | The remote has N commits you haven't pulled yet |
| **✓ Up to date** | Your local branch matches the remote |

---

## Action Buttons

| Button | Action | When to Use |
|--------|--------|-------------|
| **⬇ Pull** | Download and merge remote changes into your local branch | When the remote has new commits (↓ behind) |
| **⬆ Push** | Upload your local commits to the remote | After committing changes (↑ ahead) |
| **↻ Fetch** | Check the remote for new changes without merging | To update the sync status without changing files |
| **⎇ Graph** | Open the Git Graph view in a new tab | To visualize branch history and merges |
| **🔀 MR** | Open the Merge Request creation dialog | To propose merging your branch into another |

---

## Changes & Staging

The **Changes** section lists all files that differ from the last commit. Each file shows:

- **☐ Checkbox** — Check to **stage** the file (include it in the next commit). Uncheck to **unstage**.
- **File path** — Click to open the [Diff Viewer](#diff-viewer) showing what changed
- **📜** — Click to view [File History](#file-history--change-authors) for this file
- **Status badge** — Color-coded indicator:

| Badge | Color | Meaning |
|-------|-------|---------|
| **M** | Orange | Modified — file content has changed |
| **A** | Green | Added — new file staged for commit |
| **D** | Red | Deleted — file has been removed |
| **?** | Gray | Untracked — new file not yet staged |
| **!** | Red | Conflicted — merge conflict needs resolution |

> **Workflow**: Check the files you want to commit → write a message → click Commit. Only staged (checked) files are included.

---

## Commit Section

### JIRA Ticket

Enter a JIRA ticket number (e.g. `PROJ-123`). When set, commit messages are automatically prefixed with:
```
Changes for JIRA: PROJ-123
Your commit message here
```

The JIRA field persists across commits for convenience when working on the same ticket.

### Commit Message

Type your commit message in the text area. A **preview** shows the final message format when both JIRA ticket and message are filled in.

### Commit Button

The Commit button is enabled only when:
- ✅ At least one file is staged (checked)
- ✅ A commit message is entered
- ✅ No other operation is in progress

---

## Commit Templates

Templates let you quickly fill in commit messages with a predefined format.

### Using Templates

1. Select a template from the **Template** dropdown in the commit section
2. The commit message textarea is automatically filled with the template
3. Variables in the template are replaced with current values:

| Variable | Replaced With |
|----------|--------------|
| `{jira}` | The current JIRA ticket field value |
| `{branch}` | The current branch name |
| `{date}` | Today's date |
| `{author}` | Your default author name from settings |

4. You can edit the filled message before committing

### Built-in Templates

| Template | Format |
|----------|--------|
| **Conventional (docs)** | `docs: {jira}` + newline |
| **Conventional (fix)** | `fix: {jira}` + newline |
| **JIRA-prefixed** | `[{jira}] ` |
| **Simple** | `Update {branch} — {date}` |

### Managing Templates

In **Settings → Commit Templates**:
- **Add Template**: Create custom templates with any format
- **Edit**: Modify existing template name or format
- **Remove**: Delete a template
- **Reset to Defaults**: Restore the 4 built-in templates

---

## Stash

The stash is a temporary storage for work-in-progress changes. Use it when you need to switch branches but aren't ready to commit.

| Button | Action |
|--------|--------|
| **📦 Stash** | Save all current changes to the stash (prompts for optional message). Files revert to the last commit. |
| **Pop** | Apply the stash entry and remove it from the stash list |
| **Apply** | Apply the stash entry but keep it in the list (useful if you want to apply the same changes to multiple branches) |
| **✕** | Drop (delete) a specific stash entry without applying it |
| **Clear All Stashes** | Remove all stash entries (shown when there are 2+ entries) |

> **Workflow**: Stash → Switch branch → Do work → Switch back → Pop

---

## Tags

Tags mark specific commits as important versions (e.g. `v1.0`, `release-2024-Q1`).

| Button | Action |
|--------|--------|
| **+ Tag** | Create a new tag on the current commit. Optionally add a message to create an **annotated tag** (includes author and timestamp). |
| **⬆** | Push the tag to the remote GitLab server |
| **✕** | Delete the tag locally |

### Lightweight vs. Annotated Tags

- **Lightweight** (no message): Just a pointer to a commit — like a bookmark
- **Annotated** (with message): Includes author, date, and description — recommended for releases

> Tags also appear as 🏷️ labels in the [Git Graph](#git-graph).

---

## Repository File Browser

The **Repository Files** section shows **all** files in the repository directory, including non-Markdown files (images, PDFs, configs, source code). This is useful for:

- Seeing the complete repository structure
- Adding attachments via the **+ Add File** button (opens a file picker)
- Clicking files to open them (Markdown opens in Obsidian, others open with the system default app)

Files are colored by their Git status (green = added, orange = modified, red = deleted).

> **Note**: Files matching your [Exclude Patterns](#exclude-patterns) are hidden from this browser.

---

## Recent Commits

Shows the last 10 commits on the current branch with:
- Commit message (first line)
- Author name
- Relative date
- Short SHA hash (7 characters)

---

## Diff Viewer

The diff viewer shows exactly what changed in a file, comparing the committed version (HEAD) with your working copy.

### Opening the Diff Viewer

- **Click a file name** in the Changes section of the side panel
- **Command palette**: `View File Diff (Active File)` — diffs the currently open file

### Reading the Diff

| Color | Meaning |
|-------|---------|
| 🟢 Green background | Lines **added** (new content) |
| 🔴 Red background | Lines **removed** (old content) |
| No background | Context lines (unchanged) |

The header shows:
- File path
- **+N** additions and **-N** deletions count
- Labels showing what's being compared (e.g. "HEAD → Working Copy")

Each changed section is grouped into **hunks** with line number ranges.

---

## File History & Change Authors

View the complete commit history of a specific file and see who changed each line.

### Opening File History

- Click the **📜** icon next to a file in the Changes section
- **Command palette**: `View File History (Active File)`

### Commit List (Left Panel)

Shows every commit that modified this file, with:
- Author avatar (initials)
- Commit message
- Author name, relative date, short SHA
- **↔ Compare** button — opens a diff between that version and your current working copy

Click any commit to view the file as it was at that point in time (right panel).

### Change Author Annotations

Click **"👤 Authors Off"** to toggle annotations **On**. When enabled, a gutter column appears showing who last modified each block of lines, with their name and date.

---

## Git Graph

A visual representation of your repository's branch structure, merges, and commits.

### Opening the Git Graph

- Click **⎇ Graph** in the action buttons
- **Command palette**: `Open Git Graph`

### Reading the Graph

- **Colored lines** represent different branches
- **Dots** on lines represent commits
- **Curved lines** connecting branches represent merges
- **Branch labels** (colored badges) show where each branch currently points
- **🏷️ Tag labels** show tagged commits

### Controls

| Control | Description |
|---------|-------------|
| **Repository selector** | Switch between repositories (if multiple configured) |
| **Commits depth** | How many commits to display (50, 100, 200, or 500) |
| **↻ Refresh** | Reload the graph |

---

## Merge Request Creation

Create GitLab Merge Requests (MRs) directly from Obsidian, enabling documentation review workflows.

### Opening the MR Dialog

- Click **🔀 MR** in the action buttons
- The dialog pre-fills with sensible defaults

### Fields

| Field | Description |
|-------|-------------|
| **Source branch** | Your current branch (read-only) — the branch with your changes |
| **Target branch** | The branch to merge into (defaults to the repository's default branch) |
| **Title** | The merge request title (auto-filled: "Merge source into target") |
| **JIRA Ticket** | Optional — prepended to the MR description |
| **Description** | Markdown-formatted description of the changes |

### After Creation

- A success notification appears with the MR number
- The MR page opens automatically in your browser
- Your team can review the changes on GitLab

> **Tip**: Push your changes before creating an MR — GitLab needs the branch to exist on the remote.

---

## Conflict Resolution

When pulling changes that conflict with your local edits, the conflict resolution view helps you resolve them.

### How Conflicts Happen

Conflicts occur when both you and someone else modified the same lines in a file. Git cannot automatically decide which version to keep.

### Resolving Conflicts

1. After a pull with conflicts, a notification appears: **"Resolve Conflicts"**
2. The conflict view opens showing each conflicted file as a tab
3. For each conflict section, you see two panes:
   - **Ours (current)** — your local version
   - **Theirs (incoming)** — the remote version

4. Choose a resolution for each conflict:

| Button | Action |
|--------|--------|
| **← Accept Ours** | Keep your version, discard theirs |
| **Accept Theirs →** | Keep the remote version, discard yours |
| **Accept Both** | Include both versions (yours first, then theirs) |

5. Once all conflicts in a file are resolved, the file tab shows ✅
6. When all files are resolved, click **"✅ Apply All Resolutions & Stage"**
7. The resolved files are staged — commit them to complete the merge

---

## Exclude Patterns

Configure glob patterns to hide files and folders from the plugin's file browser and status tracking. Useful for excluding source code, build artifacts, or other non-documentation content.

### Setting Patterns

In repository settings (Edit a repository mapping), enter patterns in the **Exclude Patterns** textarea, one per line:

```
src/**
build/**
*.exe
node_modules/**
.env
dist/**
```

### Pattern Syntax

| Pattern | Matches |
|---------|---------|
| `*.exe` | All .exe files |
| `src/**` | Everything inside the src/ folder |
| `build/**` | Everything inside build/ |
| `*.min.js` | All minified JavaScript files |
| `temp_*` | Files starting with "temp_" |

> **Note**: Excluded files are hidden from the plugin UI only. They still exist in the Git repository.

---

## Sparse Checkout

Sparse checkout lets you work with only a subset of a Git repository — useful when you've been pointed at a large monorepo but only need a single team's content, or when you want to keep a docs-focused vault lean.

### How it works

Git tracks every file in the repository normally, but only the directories you select are present on disk and visible in your vault. Branch switches and pulls automatically respect the selection — Git fetches the data but only materialises the included paths into the working tree.

The plugin uses **cone mode** (the modern, performant variant of sparse checkout) under the hood, and the actual on-disk apply step bypasses some Git for Windows bugs by writing the sparse-checkout patterns file directly and using plumbing commands (`git update-index --skip-worktree`) to enforce the selection. End result is identical to what `git sparse-checkout set …` would do, just more reliable on Windows.

### Requirements

- Git CLI installed and detected by the plugin (see [Git Backend](#git-backend-cli-vs-isomorphic-git))
- Sparse checkout is per-repository — you can enable it for some repos and leave others as full clones

### Enabling

1. Open **Settings → GitLab Integration**
2. Click **Edit** on the repository
3. Scroll to the **Sparse checkout** section
4. Toggle **Enable sparse checkout** on
5. Either:
   - Type paths into the textarea (one per line, repo-root-relative, forward slashes — e.g. `docs/cs/analysis`)
   - Or click **Browse…** to open the folder picker (see below)
6. Save

After save, the plugin re-runs the repository finalisation, applies the sparse-checkout configuration, and removes excluded files from your vault. You'll see a green notice: `Sparse checkout active in "<repo-name>": <paths>`.

### Folder tree picker (Browse… button)

The picker shows the repository's folder structure with checkboxes. Behaviour:

- **Folder-only selection** — cone mode is directory-based, so files aren't individually selectable
- **Auto-source**:
  1. If the repo is already cloned locally → reads tree via `git ls-tree HEAD` (offline, instant)
  2. Otherwise → fetches the tree via GitLab REST API (`/projects/:id/repository/tree?recursive=true`)
- **Tri-state checkboxes**: full / partial (descendant selected) / unchecked
- **Smart selection rules**:
  - Selecting a parent removes redundant child selections automatically
  - Deselecting a child whose parent was selected intelligently expands the selection to siblings
- **Live filter**, **expand/collapse all**, **clear selection** buttons
- Initial selection auto-expands ancestors of already-selected folders
- Summary row at the bottom shows the canonical (deduplicated) path list that will be saved on **Apply**

### Strict cone mode

By default Git's cone mode includes all root-level files (via the `/*` pattern). The plugin intentionally departs from this and uses **strict cone mode**: only the directories you select are visible. Root-level files (e.g. `README.md`, `mkdocs.yml`) are excluded unless they happen to be inside one of your selected directories. This matches the typical documentation-vault use case.

If you need root files visible too, simply add the repo root (`.`) or specific root-level subdirectories to the sparse path list.

### Operational notes

- **Branch switching** with sparse checkout: switching branches preserves your sparse configuration. Files newly added in the target branch (that fall inside the cone) materialise; files removed elsewhere don't appear.
- **Pull / fetch**: Git fetches all objects but only updates the working tree for cone-included paths.
- **Editing the sparse path list**: saving an updated set re-runs the apply step, removing newly-excluded files and restoring newly-included ones from HEAD. Local uncommitted changes outside the cone may block the update — commit or stash first if necessary.
- **Disabling sparse checkout**: untoggle the option and save. The plugin runs `git sparse-checkout disable`, which restores the full working tree.

---

## Hidden Clone & Mirror Aliases

Sparse checkout solves "I only want some folders." This feature solves "I only want some folders, AND I want them at different vault paths than where they live in the repo."

### Problem this solves

Imagine your repo URL is `https://gitlab.com/team/pv-documentation` and your sparse selection is `docs/cs/analysis`. Even with sparse checkout active, your vault tree shows:

```
Dokumentace/PnB/pv-documentation/
└─ docs/
   └─ cs/
      └─ analysis/
         └─ <content>
```

Four wrapper folders before you reach the content you actually care about. **Hidden Clone & Mirror Aliases** lets you replace that with a flat:

```
Dokumentace/PnB - analysis/
└─ <content>
```

### How it works

1. The actual Git clone is moved to a **hidden vault folder** (`.gitlab-clones/<repo-id>/`). Obsidian ignores folders starting with `.` by default, so this stays out of your file tree.
2. For each sparse path, a **vault-relative alias** is created — a folder at the path of your choice (e.g. `Dokumentace/PnB - analysis`).
3. Each alias is populated with **NTFS hard links** to every file in the sparse source folder.

Hard links share the same inode as the source: editing a file at the alias updates the same file Git tracks in the clone. Git status, commit, pull, push all "just work" because they operate on the clone, and the hard links reflect changes transparently.

### Why not directory junctions?

The plugin's first implementation used Windows directory junctions (`mklink /J`). Junctions work at the OS level but **Obsidian's vault indexer doesn't follow them** — content inside a junction never appears in the file explorer or Quick Switcher. NTFS hard links don't have this problem because each file is a real, indexable entry from Obsidian's perspective.

### Requirements

- **Windows** (NTFS hard links). The toggle is hidden / disabled on other platforms.
- **Git CLI** detected by the plugin
- **Sparse checkout** enabled with at least one path (this feature is meaningless without it — you'd be mirroring the whole repo)

### Enabling

1. In the repository modal, ensure **Sparse checkout** is enabled with the paths you want
2. Scroll to **Hidden clone & junctions** → toggle on
3. (Optional) Edit **Hidden clone folder** — defaults to `.gitlab-clones/<repo-id>`
4. For each sparse path, an editable **alias** field appears. Set the vault path you want to see — e.g.:
   - `docs/cs/analysis` → `Dokumentace/PnB - analysis`
   - `docs/assets` → `Dokumentace/PnB - assets`
5. Save

On save, the plugin runs a one-shot migration:

1. Stops the file watcher
2. Atomic `fs.renameSync` of the clone from its old vault location to the hidden folder
3. Persists the new configuration
4. Re-initialises the repo (sparse checkout, junction reconcile)
5. Restarts the watcher

Both the migration and the per-load reconcile use rollback-safe patterns: if anything fails, the clone is restored to its previous location and `hiddenClone.enabled` is cleared so the next plugin load is sane.

### Reconciliation

On every plugin load (and after every refresh of a hidden-clone repo), the plugin runs a **mirror reconcile** for each alias:

- Walks the sparse source folder
- Creates hard links for files that don't yet have one
- Removes hard links for files that have been deleted from the clone
- Cleans up empty directories
- Leaves correctly-linked files alone (cheap idempotent walk)

So pulls, commits, and branch switches that change the file set are reflected in your aliases automatically.

### Lifecycle and edge cases

- **Editing a file via the alias**: edits flow through the shared inode to the clone. Git status sees the change. ✓
- **Plugin commit / push / pull**: the plugin operates on the clone. ✓
- **Adding a new file via the plugin's Upload Files modal**: lands in the clone, surfaces at the alias on next refresh. ✓
- **Adding a new file directly via Obsidian at an alias path**: the file is NOT yet in the clone, and the next reconcile sweep will delete it as stale. To create new files in a hidden-clone repo, use the plugin's Upload Files modal until a "promote new vault files" feature is added.
- **Manually deleting a junction folder**: the next reconcile recreates the mirror.
- **Manually deleting the clone folder**: re-init flow runs as if a fresh repo. You'll need to re-pull.

### Disabling

Untoggle **Enable hidden clone with junctions** and save:
- All mirror folders are removed (their hard links — the inode references in the clone remain)
- The clone stays where it is (`.gitlab-clones/<id>/`). To move it back to a visible vault folder, edit **Local Path** in the modal and the next finalize will use that path.

---

## GitLab Pages Compatibility

If you publish a repository as a GitLab Pages site, Obsidian-only markdown syntaxes won't render correctly out of the box. The plugin can rewrite staged `.md` files at commit time so they become standard, GitLab-Pages-friendly markdown — **without ever modifying your vault notes**. The transformed content is written directly into the Git index, so Obsidian keeps showing the original wiki-style links and callouts.

### Enabling

1. Open plugin settings → find your repository mapping → click **Edit**.
2. Scroll to the **GitLab Pages compatibility** section.
3. Toggle **Enable GitLab Pages transform**.
4. (Optional) Adjust the assets folder and per-transform toggles.
5. Save.

From the next commit on (whether from the side panel or Quick Commit), staged `.md` files will be transformed before being written to the Git tree.

### What gets transformed

| Obsidian syntax | Becomes |
|---|---|
| `![[diagram.png]]` | `![](diagram.png)` |
| `![[diagram.png\|alt text]]` | `![alt text](diagram.png)` |
| `![[diagram.png\|300]]` | `<img src="diagram.png" width="300" />` |
| `![[diagram.png\|alt\|300x200]]` | `<img src="diagram.png" alt="alt" width="300" height="200" />` |
| `[[Other Note]]` | `[Other Note](Other%20Note.md)` |
| `[[Other Note\|nice name]]` | `[nice name](Other%20Note.md)` |
| `[[Other Note#Heading]]` | `[Other Note](Other%20Note.md#heading)` |
| `> [!note] Title`<br>`> body` | `> ℹ️ **Note — Title**`<br>`>`<br>`> body` |
| `> [!warning] …` | `> ⚠️ **Warning — …**` |
| `> [!danger] …` | `> ⛔ **Danger — …**` |
| `> [!tip] …` | `> 💡 **Tip — …**` |
| `> [!success] …` | `> ✅ **Success — …**` |
| `> [!question] …` | `> ❓ **Question — …**` |

Code fences and inline code are protected — content inside `` ``` `` blocks or `` `code` `` spans is never rewritten.

### Out-of-repo images

A common Obsidian setup keeps attachments in a central folder (e.g. `Attachments/`) far from the doc folder you've mapped to a GitLab repo. When the plugin encounters an image embed whose source lives outside the repo, it:

1. Resolves the real file using Obsidian's link resolver (`metadataCache`).
2. Copies the image bytes into `<repo>/<assetsFolder>/<filename>` inside the commit (not on disk — only in the Git tree).
3. Rewrites the link to point at that path, relative to the markdown file.

If two different images would land at the same filename, the second gets a short hash suffix (e.g. `diagram.abc123.png`).

### Settings reference

| Setting | Default | Description |
|---|---|---|
| Enable GitLab Pages transform | Off | Master switch for this repository |
| Assets folder | `assets` | Where out-of-repo images are copied (relative to repo root) |
| Transform image embeds | On | Rewrite `![[…]]` |
| Transform wiki links | On | Rewrite `[[…]]` |
| Transform callouts | On | Rewrite `> [!…]` blocks |

### Behavior notes

- **Vault is never modified.** Your `.md` files on disk keep their Obsidian syntax. Only the Git blob committed to the index contains the transformed content. Run `git show HEAD:path/to/note.md` to see what was actually committed.
- **Per-repo opt-in.** Repos without the toggle behave exactly as before — zero impact on existing workflows.
- **Unresolved targets are left alone.** If `metadataCache` can't find an image or wiki target, the original syntax is preserved and a warning is written to the debug log. Commits are never blocked.
- **Wiki links to targets outside the repo are not rewritten** (they wouldn't be useful on Pages anyway).
- **Amend works the same way** — `Amend last commit` runs the transform too.
- **Non-markdown files** pass through unchanged.

### Verifying

After committing a transformed file:

```bash
git show HEAD:docs/my-note.md
```

You should see standard markdown image links, standard `[text](file.md)` links, and emoji-prefixed blockquote callouts. The corresponding file in the vault is unchanged.

---

## Quick Commands

Quick Commands let you perform common Git operations from the **command palette** (`Ctrl+P` / `Cmd+P`) without opening the side panel. Ideal for fast workflows.

### Quick Commit

Opens a standalone modal for committing changes:

1. **Repository selector** — choose which repository (auto-selected if only one)
2. **Changed files list** — check/uncheck files to stage, with **Select All** / **Deselect All** buttons
3. **JIRA Ticket** — optional ticket reference prepended to the commit message
4. **Template** — select a commit template to pre-fill the message
5. **Commit message** — write your commit description
6. **Commit** — commits staged files
7. **Commit & Push** — commits and immediately pushes to remote

### Quick Push

Pushes the current branch to remote. If you have multiple repositories, a selector appears to choose which one. For new branches not yet on remote, this publishes the branch.

### Quick Pull

Pulls latest changes from remote. Shows a warning if you have uncommitted changes, giving you the option to cancel or proceed.

### Quick Switch Branch

Opens a list of available branches for the selected repository. Click a branch name to switch to it. Warns you if you have uncommitted changes.

> **Tip**: Assign keyboard shortcuts to these commands in Settings → Hotkeys → search "GitLab" for maximum speed.

---

## Debug Logging

The plugin logs detailed information about Git operations, HTTP requests, and authentication for troubleshooting.

### Viewing Logs

- **Command palette**: `View Debug Logs` — opens a modal showing recent log entries

### Log Actions

| Button | Action |
|--------|--------|
| **↻ Refresh** | Reload the log display |
| **⬇ Export** | Download logs as a text file |
| **🗑 Clear** | Clear all stored logs |

### What's Logged

- HTTP requests and responses (URLs, status codes, headers)
- Authentication attempts and results
- Git operation starts and completions
- Errors with stack traces

> **Security**: Tokens in Authorization headers are automatically redacted in logs.

---

## Command Palette

All plugin commands available via `Ctrl+P` (or `Cmd+P` on Mac):

| Command | Action |
|---------|--------|
| **Open GitLab Panel** | Open the side panel |
| **Open Git Graph** | Open the Git Graph in a new tab |
| **Quick Commit** | Open the quick commit modal |
| **Quick Push** | Push to remote (with repo selector if needed) |
| **Quick Pull** | Pull from remote (with uncommitted changes warning) |
| **Quick Switch Branch** | Switch branch via modal |
| **View File Diff (Active File)** | Show diff for the currently open file |
| **View File History (Active File)** | Show history for the currently open file |
| **Open User Guide** | Open this guide inside Obsidian |
| **View Debug Logs** | Open the debug log viewer |
| **Export Debug Logs** | Download logs as a file |
| **Clear Debug Logs** | Clear all stored logs |

---

## Keyboard Shortcuts

You can assign custom keyboard shortcuts to any command:

1. Go to **Settings → Hotkeys**
2. Search for "GitLab"
3. Click the `+` icon next to any command to assign a shortcut

**Recommended shortcuts**:
- `Ctrl+Shift+G` → Open GitLab Panel
- `Ctrl+Shift+D` → View File Diff
- `Ctrl+Shift+H` → View File History

---

## Troubleshooting

### Authentication Fails (401 Unauthorized)

- **Check your token**: Ensure it hasn't expired and has `read_repository` + `write_repository` scopes
- **Re-enter the token**: Edit the repository mapping and paste the token again
- **Token type**: For self-hosted GitLab, use a Personal Access Token (not a Deploy Token)

### SSL Certificate Errors

For corporate/self-hosted GitLab instances with self-signed certificates:
- Edit the repository mapping
- Enable **"Disable SSL Verification"**

### Push Rejected

- **Pull first**: The remote may have new commits. Pull, resolve any conflicts, then push again
- **Branch protection**: Check if the target branch has push protection rules on GitLab

### Files Not Showing

- Check your **Exclude Patterns** — they might be hiding the files
- Ensure the **Local Path** in repository settings points to the correct folder
- Click **↻ Refresh** in the panel header

### "Not a Git Repository" Error

The plugin initializes a `.git` directory in your local path automatically. If this fails:
1. Ensure the local path folder exists
2. Check file system permissions
3. Try removing the `.git` folder and re-adding the repository mapping

### Slow Performance with Large Repositories

- Reduce the Git Graph **Commits depth** to 50
- Add **Exclude Patterns** for large directories (e.g. `node_modules/**`, `vendor/**`)
- Reduce the **Auto-Fetch Interval** or set it to `0`

---

## FAQ

**Q: Can I connect multiple folders to the same repository?**
A: No, each folder connects to exactly one repository. However, you can connect different folders to different repositories.

**Q: Does the plugin work with GitHub/Bitbucket?**
A: The Git operations (commit, push, pull, etc.) use standard Git protocols and work with any Git hosting. The Merge Request creation feature is GitLab-specific.

**Q: Are my tokens stored securely?**
A: Tokens are stored in Obsidian's plugin data file, which is local to your machine. They are not encrypted, so treat the data file with appropriate care.

**Q: Can I use SSH instead of HTTPS?**
A: Currently only HTTPS with Personal Access Tokens is supported.

**Q: What happens if I edit a file both in Obsidian and on GitLab?**
A: When you pull, the plugin will attempt to merge changes. If the same lines were edited, you'll see the [Conflict Resolution](#conflict-resolution) view.

---

*This guide is also accessible from within Obsidian via the command palette: **"GitLab: Open User Guide"***
