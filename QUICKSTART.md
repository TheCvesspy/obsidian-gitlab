# Obsidian GitLab Plugin - Quick Start Guide

## 🚀 Getting Started

### Prerequisites

1. **Obsidian** installed on your computer
2. **GitLab account** with repository access
3. **Personal Access Token** from GitLab with repository permissions

### Installation

1. Download the latest release files:
   - `main.js`
   - `manifest.json`
   - `styles.css`

2. Create plugin directory:
   ```
   <your-vault>/.obsidian/plugins/obsidian-gitlab/
   ```

3. Copy the three files into the directory

4. Restart Obsidian and enable the plugin in Settings → Community Plugins

### Getting Your GitLab Token

1. Log in to your GitLab account
2. Go to **Settings** → **Access Tokens**
3. Click **Add new token**
4. Configure:
   - **Token name**: `Obsidian-Sync`
   - **Expiration date**: Set as needed
   - **Scopes**: Select `read_repository`, `write_repository`
5. Click **Create personal access token**
6. **Copy the token** (you won't see it again!)

## ⚙️ Configuration

### Step 1: Global Settings

1. Open Obsidian **Settings** → **GitLab Integration**
2. Set your default Git author information:
   - **Default Author Name**: Your name
   - **Default Author Email**: Your email

### Step 2: Add Repository Mapping

1. In the GitLab Integration settings
2. Click **Add Repository Mapping**
3. Fill in the form:

```
Repository Name: My Notes
Local Path: PersonalNotes
GitLab Repository URL: https://gitlab.com/username/my-notes.git
Personal Access Token: glpat-xxxxxxxxxxxxxxxxxxxx
Default Branch: main
Enabled: ✓
```

4. Click **Add**

### Understanding Paths

- **Local Path**: Folder within your vault (e.g., `Projects/Work`)
- Must be **relative** to your vault root
- Each sub-tree can only connect to **one** repository
- Multiple sub-trees can connect to **different** repositories

### Example Multi-Repository Setup

```
Vault Structure:
├── PersonalNotes/    → gitlab.com/username/personal-notes
├── WorkDocs/         → gitlab.com/company/work-docs  
└── Projects/
    ├── ProjectA/     → gitlab.com/username/project-a
    └── ProjectB/     → gitlab.com/username/project-b
```

## 🎯 Daily Usage

### Opening the GitLab Panel

**Three ways:**
1. Click the **Git branch icon** in the left ribbon
2. Use Command Palette (Ctrl/Cmd+P): `GitLab: Open GitLab Panel`
3. Use the hotkey (if configured)

### Making Changes and Committing

1. **Make changes** to your files in Obsidian
2. **Open the GitLab panel**
3. **Select your repository** from the dropdown
4. **Review changes** in the Changes section
   - ✓ Check files you want to commit
   - Files show status: M (Modified), A (Added), D (Deleted), ? (Untracked)
5. **Write commit message** in the text area
6. Click **Commit** button

### Syncing with Remote

#### Pull Changes (Download)

1. Click the **⬇ Pull** button
2. Wait for completion notification
3. Changes are merged into your local files

#### Push Changes (Upload)

1. Make sure you have commits to push (shows "↑ X ahead")
2. Click the **⬆ Push** button
3. Wait for completion notification

#### Fetch Updates

- Click **↻ Fetch** to check for remote changes without merging
- Updates the ahead/behind counter

### Understanding Sync Status

- **✓ Up to date**: Local and remote are in sync
- **↑ 2 ahead**: You have 2 local commits to push
- **↓ 3 behind**: Remote has 3 commits you haven't pulled

## 📋 Common Workflows

### Workflow 1: Start of Day

```
1. Open Obsidian
2. Open GitLab panel
3. Click Pull to get latest changes
4. Start working
```

### Workflow 2: End of Day

```
1. Review changes in GitLab panel
2. Check files to commit
3. Write meaningful commit message
4. Click Commit
5. Click Push to upload
```

### Workflow 3: Working on Different Machines

**On Computer A:**
```
1. Make changes
2. Commit
3. Push
```

**On Computer B:**
```
1. Pull latest changes
2. Work on files
3. Commit and Push
```

## 🌿 Branch Management

### Viewing & Switching Branches

- The current branch is shown in a **dropdown selector** in the side panel
- Select a different branch from the dropdown to switch
- If you have uncommitted changes, you'll see a warning

### Creating New Branches

- Click **New Branch** button next to the dropdown
- Enter a name for the new branch
- The branch is created from the current HEAD

### Publishing New Branches

- New local branches show a **"⬆ Publish"** button instead of "Push"
- Click Publish to push the branch to remote for the first time

## 🔍 File Status Indicators

When enabled, files in the explorer show status badges:

- **M**: Modified file
- **A**: Added (new) file
- **D**: Deleted file
- **?**: Untracked file
- **!**: Conflicted file (needs resolution)

## 📦 Backup & Configuration

### Export Configuration

1. Settings → GitLab Integration
2. Scroll to **Configuration Import/Export**
3. Click **Export**
4. Save JSON file securely
   - ⚠️ Tokens are redacted for security

### Import Configuration

1. Click **Import**
2. Select your JSON configuration file
3. Existing tokens are preserved for matching repositories

## 🆘 Troubleshooting

### "Authentication failed"

- Verify your Personal Access Token is correct
- Check token hasn't expired
- Ensure token has correct scopes (read_repository, write_repository)

### "Failed to pull changes"

- Make sure you don't have uncommitted changes
- Try committing first, then pull
- Check internet connection

### "Failed to push changes"

- Make sure you're up to date (pull first if behind)
- Check you have push permissions to the repository
- Verify repository URL is correct

### Repository not showing

- Check the repository is **Enabled** in settings
- Verify the local path exists in your vault
- Try removing and re-adding the repository mapping

## 💡 Best Practices

### Commit Messages

Write clear, descriptive commit messages:

✅ **Good:**
```
Add meeting notes for Q4 planning
Update project timeline with new milestones
Fix typos in README
```

❌ **Bad:**
```
update
changes
asdf
```

### Commit Frequency

- **Commit often**: After completing a logical unit of work
- **Push regularly**: At least once per session
- **Pull before working**: Avoid conflicts

### File Organization

- Keep repository sub-trees focused and organized
- Don't overlap repository paths
- Use .gitignore for files you don't want to sync

## 🔒 Security Notes

- **Tokens are encrypted** in Obsidian's storage
- **Never commit** tokens to your repositories
- **Rotate tokens** periodically for security
- **Use repository-specific tokens** for sensitive data
- **Don't export** configuration with tokens to untrusted locations

## 🛠️ Advanced Features

### Quick Commands

Use the command palette (`Ctrl+P`) for fast Git operations without opening the sidebar:

- **Quick Commit** — stage files, write message, commit (and optionally push)
- **Quick Push** — push to remote instantly
- **Quick Pull** — pull from remote with conflict warning
- **Quick Switch Branch** — switch branches via modal

### Multiple Repositories

- Each folder can be a separate repository
- Manage multiple projects independently
- Switch between repositories in the panel dropdown

### Git Graph

- Visual branch/merge/commit history
- Open via **⎇ Graph** button or command palette

### Diff Viewer & File History

- Click any file name in Changes to view its diff
- Click 📜 icon to see full file history with change author annotations

### Commit Templates

- Pre-defined templates with variables: `{jira}`, `{branch}`, `{date}`, `{author}`
- Configure in Settings → GitLab Integration → Commit Templates

### Stash & Tags

- Stash uncommitted changes for later
- Create and push tags to mark releases

### Exclude Patterns

- Configure glob patterns to hide files from the plugin (like `.gitignore`)
- Set in repository settings: e.g. `src/**`, `node_modules/**`, `*.exe`

### Merge Request Creation

- Create GitLab MRs directly from Obsidian
- Click **🔀 MR** button in the action row

### Conflict Resolution

- Built-in conflict resolution UI
- Side-by-side comparison with Accept Ours / Accept Theirs / Accept Both options

## 📚 Keyboard Shortcuts

Configure in Obsidian Settings → Hotkeys → search "GitLab":

- `Ctrl+Shift+G` → Open GitLab Panel
- `Ctrl+Shift+D` → View File Diff
- `Ctrl+Shift+H` → View File History
- Assign shortcuts to Quick Commit, Quick Push, Quick Pull, Quick Switch Branch

## 🌐 Resources

- **Repository**: [GitHub URL]
- **Issues**: Report bugs and request features
- **Discussions**: Ask questions and share tips
- **Documentation**: Full docs and API reference

## 🤝 Getting Help

1. Check this guide first
2. Search existing issues on GitHub
3. Ask in the Discussions section
4. Create a new issue with details:
   - Obsidian version
   - Plugin version
   - Steps to reproduce
   - Error messages

---

**Happy syncing! 🚀**
