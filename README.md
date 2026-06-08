# Obsidian GitLab Integration

A comprehensive GitLab integration for [Obsidian](https://obsidian.md). Connect sub-trees of your vault to GitLab repositories with full Git functionality — commit, push, pull, branch, merge, view history, and more — all without leaving Obsidian.

**New in 2.0**: Hybrid Git backend (Git CLI primary, isomorphic-git fallback), **sparse checkout** for working with just a subfolder of a large repository, and **hidden-clone + hard-link mirror aliases** for renaming deep repo paths into clean vault locations. See [What's new in 2.0](#whats-new-in-20) below.

> ⚠️ **Corporate/Self-Hosted GitLab Users**: If you connect to an internal GitLab instance with self-signed certificates, enable the **Disable SSL Verification** option in the plugin settings to bypass certificate errors.

## Features

### Core Git Operations
- 📝 **Commit, Pull & Push** — Stage files, write commit messages, and sync with GitLab
- 🌳 **Multi-Repository Support** — Connect multiple vault sub-trees to different GitLab repositories
- ⚔️ **Conflict Resolution** — Built-in UI for reviewing and resolving merge conflicts
- ⚠️ **Pull Conflict Warning** — Warns before pulling when local changes could cause conflicts

### Branch & Tag Management
- 🔀 **Branch Dropdown** — Switch branches instantly from an inline dropdown (no modal)
- 🆕 **New Branch & Publish** — Create local branches and publish them to the remote
- 🏷️ **Tags Management** — Create, list, and delete Git tags
- 🗑️ **Branch Deletion** — Remove local and remote branches

### History & Visualization
- 📊 **Git Graph** — Visual commit graph showing branch topology and merge history
- 🔎 **Diff Viewer** — Side-by-side diff view for inspecting file changes
- 📜 **File History** — Browse the full commit history of any file
- 👤 **Change Author Annotations** — Git blame annotations showing who changed each line

### Advanced Features
- ✂️ **Sparse Checkout** — Work with just the folders you care about from a large repo. Cone-mode selection via folder picker; the rest stays in Git but isn't downloaded to your vault. (Requires Git CLI.)
- 🗂️ **Hidden Clone + Mirror Aliases** — Move the clone to a hidden vault folder (`.gitlab-clones/`) and surface each sparse path at a vault location of your choice via NTFS hard-link mirroring. Eliminates deep nested paths from your file tree. (Windows + Git CLI.)
- 🔧 **Hybrid Git Backend** — Uses your system's Git CLI when available (full feature set, sparse checkout, partial clone) and falls back to the built-in [isomorphic-git](https://isomorphic-git.org/) when Git isn't installed (no system dependency).
- 📦 **Stash Support** — Stash and restore uncommitted changes
- 📋 **Commit Templates** — Predefined commit message templates with JIRA ticket support
- 🔀 **Merge Request Creation** — Open GitLab merge requests directly from Obsidian
- 📂 **Repository File Browser** — Browse repository files and their Git status
- 🚫 **Exclude Patterns** — Define patterns (like `.gitignore`) to exclude files from tracking
- 🌐 **GitLab Pages Compatibility** — Optionally rewrite Obsidian-only syntax (image embeds, wiki links, callouts) on commit so docs render correctly on GitLab Pages, without modifying your vault notes

### Interface & Usability
- 🎨 **Collapsible UI Sections** — Clean, organized side panel with collapsible sections
- ⚡ **Quick Commands** — Quick Commit, Quick Push, Quick Pull, and Quick Switch Branch
- 🔍 **Status Indicators** — File and folder Git status shown in the file explorer
- 📖 **Built-in User Guide** — Access the user guide directly from within Obsidian
- ⚙️ **Flexible Configuration** — GUI settings panel and JSON config file support
- 🔐 **Secure Authentication** — GitLab personal access token support

## Installation

### From Obsidian Community Plugins

1. Open Obsidian Settings
2. Navigate to Community Plugins
3. Search for **"GitLab Integration"**
4. Click Install

### Manual Installation

1. Download the latest release
2. Extract `main.js`, `manifest.json`, and `styles.css` to your vault's `.obsidian/plugins/obsidian-gitlab/` directory
3. Reload Obsidian
4. Enable the plugin in Settings → Community Plugins

### Build from Source

```bash
# Clone the repository
git clone <repository-url>
cd obsidian-gitlab

# Install dependencies
npm install

# Build the plugin
npm run build

# Copy to your vault's plugin directory
cp main.js manifest.json styles.css /path/to/your/vault/.obsidian/plugins/obsidian-gitlab/
```

## Setup

### 1. Generate a GitLab Personal Access Token

1. Go to your GitLab instance → **Settings → Access Tokens**
2. Create a new token with the following scopes:
   - `read_repository`
   - `write_repository`
3. Copy the token (you'll need it in the next step)

### 2. Configure Repository Mappings

#### Via Settings Panel

1. Open Obsidian Settings → **GitLab Integration**
2. Configure global settings (author name, email)
3. Click **"Add Repository Mapping"**
4. Fill in:
   - **Name**: A friendly name for this mapping
   - **Local Path**: Path to the sub-tree folder (e.g., `Projects/MyProject`)
   - **Repository URL**: Your GitLab repository URL (HTTPS)
   - **Access Token**: The personal access token from step 1
   - **Current Branch**: The branch to work with (e.g., `main`)
5. Save the mapping

> 💡 **Self-hosted GitLab**: Toggle **Disable SSL Verification** in settings if your instance uses a self-signed certificate.

#### Via Configuration File

Create or import a JSON configuration file:

```json
{
  "repositories": [
    {
      "id": "my-project",
      "name": "My Project",
      "localPath": "Projects/MyProject",
      "repositoryUrl": "https://gitlab.example.com/team/my-project.git",
      "token": "glpat-xxxxxxxxxxxx",
      "currentBranch": "main",
      "enabled": true
    }
  ],
  "showStatusIndicators": true,
  "defaultAuthorName": "Your Name",
  "defaultAuthorEmail": "your.email@example.com",
  "autoFetchInterval": 0
}
```

## Usage

### Opening the GitLab Panel

- Click the **Git branch icon** in the ribbon
- Or use the command palette: **"GitLab: Open GitLab Panel"**

### Making Commits

1. Open the GitLab panel
2. Select your repository from the dropdown
3. Review changed files in the file list
4. Check the files you want to stage
5. Write a commit message (or use a **commit template**)
6. Click **"Commit"**

> 💡 Use **Quick Commit** from the command palette to stage all changes and commit in one step.

### Pulling and Pushing

- **Pull**: Click the **Pull** button to fetch and merge remote changes
- **Push**: Click the **Push** button to upload your commits to GitLab
- **Quick Push / Quick Pull**: Use quick commands from the command palette for one-click operations

> ⚠️ The plugin will warn you if pulling could cause conflicts with your local changes.

### Branch Management

- Select a branch from the **branch dropdown** at the top of the panel
- Create new branches and **publish** them to the remote
- Delete branches (except the current one) with the delete button
- Use **Quick Switch Branch** from the command palette for fast switching

### Tags

- Create tags on the current commit
- View and manage existing tags
- Delete tags when no longer needed

### Stashing Changes

- **Stash** uncommitted changes to save them temporarily
- **Restore** stashed changes when you're ready to continue working

### Git Graph

- Open the **Git Graph** to visualize commit history and branch topology
- See merge points, branch divergence, and commit relationships at a glance

### Diff Viewer & File History

- View **side-by-side diffs** for any changed file
- Browse the **full commit history** of a file
- See **change author annotations** (blame) to identify who changed each line

### Merge Request Creation

- Create **GitLab merge requests** directly from the plugin
- Set source and target branches, title, and description without leaving Obsidian

### Handling Merge Conflicts

When conflicts occur during pull or merge:

1. The conflict resolution modal appears automatically
2. Review the conflicting changes side-by-side
3. Choose an action:
   - **Accept Ours**: Keep your local version
   - **Accept Theirs**: Use the remote version
   - **Manual Edit**: Edit the file directly to resolve
4. Mark as resolved and continue

### Exclude Patterns

Define exclude patterns in settings to ignore files from Git tracking, similar to `.gitignore`. Useful for vault-specific files you don't want to commit.

### Visual Status Indicators

When enabled, files and folders in the file explorer show their Git status:

| Indicator | Meaning |
|-----------|---------|
| **M** | Modified |
| **A** | Added |
| **D** | Deleted |
| **?** | Untracked |
| **!** | Conflicted |

Folders connected to repositories display a folder icon indicator.

### Sparse Checkout

If you only need part of a large repository (e.g. one team's documentation in a monorepo), enable **sparse checkout** in the repository modal:

1. Edit the repository → expand **Sparse checkout** section
2. Toggle **Enable sparse checkout**
3. Click **Browse…** to open the folder tree picker, or type paths directly into the textarea (one per line, repo-root-relative)
4. Save

Only the selected directories are downloaded into your vault. Other paths remain tracked by Git but stay out of your file tree. Branch switches and pulls respect the sparse configuration automatically.

> Sparse checkout requires Git CLI installed on your system (>= 2.25). Without it, the plugin falls back to a full clone via isomorphic-git.

### Hidden Clone with Mirror Aliases (Windows)

For documentation repos where the clone's path is deeply nested (e.g. `Dokumentace/PnB/pv-documentation/docs/cs/analysis/`), you can move the clone into a hidden folder and surface each sparse path at a clean vault location:

1. Make sure **Sparse checkout** is enabled and has at least one path
2. Scroll to **Hidden clone & junctions** in the repository modal
3. Toggle **Enable hidden clone with junctions**
4. Optionally edit the **Hidden clone folder** (defaults to `.gitlab-clones/<repo-id>` — hidden by Obsidian since it starts with a dot)
5. Each sparse path gets an editable **alias** field — set the vault path you want to see in the file explorer (e.g. `Dokumentace/PnB - analysis`)
6. Save

On save, the plugin:
- Moves the existing clone into the hidden folder (one-time, atomic, with rollback)
- Creates NTFS hard-link mirrors at each alias path so Obsidian sees real files at the clean locations

**Why hard links instead of junctions?** Obsidian doesn't index directory junctions / reparse points. NTFS hard links share the same inode as the source file — edits through the alias path update the same file Git tracks, transparently.

**Lifecycle:**
- Adding files via the plugin's **Upload file** modal: the file lands in the clone and shows up at the alias on next refresh.
- Editing existing files via the vault: the change flows straight to Git through the shared inode.
- Pulling new files: the next refresh adds them to the mirror.
- Files created directly in the vault at an alias path (not via the plugin): use the **Upload file** modal to promote them into the clone — otherwise they'll be swept as stale on the next mirror reconcile.

To disable, untoggle the option in the modal and save. Mirrors are removed; the clone stays where it is (you can manually rename the folder if desired).

### GitLab Pages Compatibility

If you publish a repository as a GitLab Pages site, Obsidian-only syntaxes won't render correctly out of the box: `![[image.png]]` embeds, `[[wiki links]]`, and `> [!note]` callouts are non-standard markdown. Enable **GitLab Pages compatibility** on a per-repo basis to have the plugin rewrite staged `.md` files at commit time.

**Important:** the rewritten content is written directly into the Git index. Your actual vault notes are never touched, so Obsidian continues to work normally.

To enable, edit the repository mapping and toggle **Enable GitLab Pages transform**. The following per-transform toggles are available:

| Transform | Input | Output |
|-----------|-------|--------|
| Image embeds | `![[diagram.png]]` | `![](diagram.png)` |
| Image embeds with width | `![[diagram.png\|300]]` | `<img src="diagram.png" width="300" />` |
| Wiki links | `[[Other Note]]` | `[Other Note](Other%20Note.md)` |
| Wiki links with alias / heading | `[[Other Note#Section\|alias]]` | `[alias](Other%20Note.md#section)` |
| Callouts | `> [!warning] Heads up` | `> ⚠️ **Warning — Heads up**` |

**Out-of-repo images** (images stored elsewhere in your vault, e.g. a central `Attachments/` folder) are automatically copied into the repo's assets folder (default: `assets/`) and the link is rewritten to point at the new location. Filename collisions with different sources are resolved with a short hash suffix.

**Settings:**

| Setting | Description | Default |
|---------|-------------|---------|
| Enable GitLab Pages transform | Master switch for the repo | Off |
| Assets folder | Folder (relative to repo root) where out-of-repo images are copied | `assets` |
| Transform image embeds | Convert `![[…]]` syntax | On |
| Transform wiki links | Convert `[[…]]` syntax | On |
| Transform callouts | Convert `> [!…]` callouts | On |

Unresolved links (image not found, wiki target missing) are left as-is and a warning is written to the debug log — they won't block your commit.

## Configuration Options

| Setting | Description | Default |
|---------|-------------|---------|
| Default Author Name | Name to use for commits | `""` |
| Default Author Email | Email to use for commits | `""` |
| Show Status Indicators | Display Git status in file explorer | `true` |
| Auto Fetch Interval | Minutes between automatic fetches (0 = disabled) | `0` |
| Disable SSL Verification | Skip SSL certificate checks (for self-hosted GitLab) | `false` |
| Exclude Patterns | File patterns to exclude from Git tracking | `[]` |
| Sparse Checkout | Per-repo: only check out selected directories | Off |
| Hidden Clone & Junctions | Per-repo: move clone to hidden folder, alias sparse paths | Off |

## Requirements

- Obsidian v1.0.0 or higher (desktop only)
- Internet connection for GitLab operations
- GitLab account with repository access (GitLab.com or self-hosted)
- **Optional but recommended**: Git CLI (>= 2.25) installed and on your PATH. Without it, the plugin falls back to the built-in isomorphic-git — full clones only, no sparse checkout, no hidden-clone aliases. The plugin auto-detects Git on startup and shows which backend is active in the settings tab.

## Troubleshooting

### Viewing Debug Logs

1. Open Command Palette (Ctrl/Cmd+P)
2. Type **"GitLab: View Debug Logs"**
3. Review the detailed logs showing:
   - All Git operations attempted
   - Authentication attempts
   - Error details with stack traces
4. You can:
   - **Refresh** to see new logs
   - **Export** logs to a file for bug reports
   - **Clear** logs to start fresh

### "Failed to pull/push/fetch"

**Possible causes:**
- Repository not initialized with remote origin
- Authentication token invalid or expired
- Network connectivity issues
- Repository URL incorrect

**Solutions:**
1. Open Debug Logs (Command Palette → "GitLab: View Debug Logs")
2. Look for detailed error messages in the logs
3. Verify your Personal Access Token is valid
4. Check the repository URL in settings
5. Try removing and re-adding the repository mapping
6. Ensure the folder exists in your vault

### SSL / Certificate Errors

If you are connecting to a corporate or self-hosted GitLab instance:

1. Open Obsidian Settings → **GitLab Integration**
2. Enable **Disable SSL Verification**
3. Retry the operation

### Authentication Errors

- Verify your personal access token is valid and has the correct scopes
- Check that the token hasn't expired
- Ensure the repository URL is correct (HTTPS format)

### Merge Conflicts

- Use the built-in conflict resolution UI
- Manually edit files if needed (conflicts are marked with standard Git markers)
- Ensure all conflicts are resolved before continuing

### Performance Issues

- Large repositories may take time to clone initially
- Use exclude patterns to skip large or unnecessary files
- Disable auto-fetch if you don't need it

## Privacy & Security

- Personal access tokens are stored securely in Obsidian's encrypted data storage
- Tokens are never committed to your vault or shared
- All Git operations use HTTPS with token authentication
- No data is sent to third parties

## Contributing

Contributions are welcome! Please see [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

## License

MIT License — see [LICENSE](LICENSE) for details.

## What's new in 2.0

- **Hybrid Git backend**: the plugin now prefers your system's Git CLI for all operations, with [isomorphic-git](https://isomorphic-git.org/) as a fallback when Git isn't installed. This unlocks sparse checkout, partial clones (`--filter=blob:none`), faster operations on large repos, and standard git auth via URL-embedded tokens.
- **Sparse checkout** with cone mode and a folder-tree picker. Auto-source: reads the tree from your local clone if present, otherwise fetches via the GitLab REST API.
- **Hidden clone + hard-link mirrors**: opt-in mode that moves the clone to a hidden vault folder and surfaces each sparse path at a vault location of your choice. Solves the "documentation repo with deeply nested path" UX problem.
- **GitLab Pages compatibility** still works under both backends.
- Existing repository configurations from 1.x are picked up automatically — no migration required for users who don't enable the new features.

## Acknowledgments

- Built with the [Obsidian Plugin API](https://github.com/obsidianmd/obsidian-api)
- Git operations: system Git CLI primary, [isomorphic-git](https://isomorphic-git.org/) fallback
- Direct fetch calls for GitLab REST API integration

---

**Version 2.0** · Created by **Quill of the Weavers**
