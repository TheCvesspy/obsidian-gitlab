/**
 * Contextual help text for all plugin sections.
 * Used for tooltips, info buttons, and the in-app guide.
 */

export const HELP_TEXT: Record<string, { title: string; short: string; detail: string }> = {
	// Side Panel Sections
	'repository-selector': {
		title: 'Repository Selector',
		short: 'Switch between configured repository mappings',
		detail: 'Select which repository to view and manage. Each repository maps a vault folder to a GitLab remote. Configure repositories in Settings → GitLab Integration.',
	},
	'current-branch': {
		title: 'Branch Management',
		short: 'View, switch, or create branches',
		detail: 'Shows your active branch. Use "Switch Branch" to change to another local branch, or "New Branch" to create a feature branch from the current HEAD. Branches help organize different documentation tasks.',
	},
	'sync-status': {
		title: 'Sync Status',
		short: 'Shows how your local branch compares to the remote',
		detail: '↑ Ahead = you have local commits to push. ↓ Behind = remote has commits to pull. ✓ Up to date = local and remote match. Use Fetch to refresh this status.',
	},
	'actions': {
		title: 'Action Buttons',
		short: 'Core Git operations',
		detail: 'Pull: download remote changes. Push: upload local commits. Fetch: check for remote changes without merging. Graph: visualize branch history. MR: create a GitLab Merge Request.',
	},
	'changes': {
		title: 'Changes & Staging',
		short: 'Files that differ from the last commit — check to stage for commit',
		detail: 'Each file shows its status (M=Modified, A=Added, D=Deleted, ?=Untracked). Check the box to stage a file for the next commit. Click the file name to view its diff. Click 📜 to see its history.',
	},
	'commit': {
		title: 'Commit Section',
		short: 'Write a message and commit staged changes',
		detail: 'Enter a JIRA ticket (optional — auto-prepended to message). Select a template to pre-fill the message. Write your commit message and click Commit. Only checked (staged) files are included.',
	},
	'templates': {
		title: 'Commit Templates',
		short: 'Pre-defined message formats with variable substitution',
		detail: 'Select a template to fill the commit message. Variables: {jira} = JIRA ticket, {branch} = current branch, {date} = today\'s date, {author} = your name. Manage templates in Settings.',
	},
	'stash': {
		title: 'Stash',
		short: 'Temporarily save uncommitted changes',
		detail: 'Stash saves your work-in-progress so you can switch branches cleanly. By default the stash includes untracked files (new notes), so nothing slips through. Pop = apply & remove. Apply = apply & keep. Drop = delete without applying. Branch from stash = recover a stash that no longer applies cleanly on a fresh branch. Hover a changed file to "Stash this file" only.',
	},
	'tags': {
		title: 'Tags',
		short: 'Mark specific commits as versions or milestones',
		detail: 'Create lightweight tags (bookmarks) or annotated tags (with message, author, date — recommended for releases). Push tags to remote to share with your team. Tags appear as 🏷️ labels in the Git Graph.',
	},
	'file-browser': {
		title: 'Repository File Browser',
		short: 'Browse all files in the repository, including non-Markdown',
		detail: 'Shows the complete directory tree of your repository. Files are colored by Git status. Click to open (Markdown in Obsidian, others in system app). Use "+ Add File" to copy files into the repo. Files matching exclude patterns are hidden.',
	},
	'recent-commits': {
		title: 'Recent Commits',
		short: 'Last 10 commits on the current branch',
		detail: 'Shows commit message, author, date, and short SHA. For full history with branching visualization, use the Git Graph view.',
	},

	// Views
	'diff-view': {
		title: 'Diff Viewer',
		short: 'Shows line-by-line changes between HEAD and working copy',
		detail: 'Green = added lines, Red = removed lines. Changes are grouped into hunks with line numbers. Header shows total additions (+) and deletions (-).',
	},
	'file-history': {
		title: 'File History',
		short: 'Commit history for a specific file with optional change author annotations',
		detail: 'Left panel: commits that modified this file. Click a commit to see the file at that version. "↔ Compare" opens a diff with the current working copy. Toggle "👤 Authors" to see who last modified each line block.',
	},
	'git-graph': {
		title: 'Git Graph',
		short: 'Visual branch and merge history',
		detail: 'Colored lines = branches. Dots = commits. Curves = merges. Branch labels and 🏷️ tag labels show on matching commits. Adjust "Commits" depth for more or less history.',
	},
	'conflict-resolution': {
		title: 'Conflict Resolution',
		short: 'Resolve merge conflicts with a visual two-pane editor',
		detail: 'Shows "Ours" (your version) and "Theirs" (remote version) side by side. Choose Accept Ours, Accept Theirs, or Accept Both for each conflict. Once all files are resolved, click "Apply All Resolutions & Stage" to continue.',
	},
	'merge-request': {
		title: 'Merge Request',
		short: 'Create a GitLab MR to propose merging your branch',
		detail: 'Set source (your branch) and target (where to merge). Add a title, description, and optional JIRA ticket. Push your branch first — GitLab needs it on the remote. The MR opens in your browser after creation.',
	},

	// Settings
	'exclude-patterns': {
		title: 'Exclude Patterns',
		short: 'Glob patterns to hide files from the plugin',
		detail: 'One pattern per line. Examples: src/** (exclude source code), *.exe (exclude executables), node_modules/** (exclude dependencies). Excluded files are hidden from the UI only — they remain in the Git repository.',
	},
	'ssl-verification': {
		title: 'SSL Verification',
		short: 'Disable for corporate GitLab with self-signed certificates',
		detail: '⚠️ Only enable this for trusted internal GitLab instances. When disabled, the plugin will accept any SSL certificate when communicating with the GitLab server.',
	},
};

/**
 * Get the full GUIDE.md content for displaying in Obsidian
 */
export function getGuideContent(): string {
	// This returns a reference — the actual guide is loaded from the file
	return 'Open GUIDE.md in the plugin folder for the full user guide.';
}
