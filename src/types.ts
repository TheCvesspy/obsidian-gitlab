/**
 * TypeScript interfaces and types for the GitLab Obsidian plugin
 */

/**
 * Configuration for a single sub-tree to repository mapping
 */
export interface SubTreeConfig {
	/** Unique identifier for this mapping */
	id: string;
	/** Name/description of this repository mapping */
	name: string;
	/** Path to the sub-tree folder within the vault (relative to vault root) */
	localPath: string;
	/** GitLab repository URL (HTTPS) */
	repositoryUrl: string;
	/** GitLab personal access token for authentication */
	token: string;
	/** Current active branch */
	currentBranch: string;
	/** Whether this mapping is enabled */
	enabled: boolean;
	/** Last sync timestamp */
	lastSync?: number;
	/** Disable SSL certificate verification (for self-signed/corporate certs) */
	disableSslVerification?: boolean;
	/** Glob patterns to exclude from plugin sync/display (one per line, gitignore-style) */
	ignorePatterns?: string[];
	/** GitLab Pages compatibility transform applied to .md files at commit time */
	gitlabPagesCompat?: GitLabPagesCompatConfig;
}

/**
 * Per-repository configuration for the GitLab Pages compatibility transform.
 *
 * When enabled, staged markdown files are rewritten on commit so that
 * Obsidian-only syntaxes (image embeds, wiki links, callouts) render
 * correctly on GitLab Pages. The user's vault notes are never modified —
 * the rewritten content is written directly into the Git index.
 */
export interface GitLabPagesCompatConfig {
	/** Master toggle for this repo */
	enabled: boolean;
	/** Folder (relative to repo root) where out-of-repo images are copied. Default: "assets" */
	assetsFolder?: string;
	/** Convert ![[image.png]] embeds. Default: true */
	transformImages?: boolean;
	/** Convert [[note]] wiki links. Default: true */
	transformWikiLinks?: boolean;
	/** Convert > [!note] callouts. Default: true */
	transformCallouts?: boolean;
	/**
	 * Maximum size in bytes of an out-of-repo image that the pipeline
	 * will move into the assets folder. Larger files cause the commit to
	 * abort with an error so the user can decide what to do. Default: 10 MiB.
	 */
	maxAssetBytes?: number;
}

/**
 * Plugin settings stored in Obsidian data
 */
export interface GitLabPluginSettings {
	/** List of repository mappings */
	repositories: SubTreeConfig[];
	/** Show status indicators in file explorer */
	showStatusIndicators: boolean;
	/** Default commit author name */
	defaultAuthorName: string;
	/** Default commit author email */
	defaultAuthorEmail: string;
	/** Auto-fetch interval in minutes (0 = disabled) */
	autoFetchInterval: number;
	/** Commit message templates */
	commitTemplates: CommitTemplate[];
	/** Whether auto-commit is enabled */
	autoCommitEnabled: boolean;
	/** Auto-commit interval in minutes */
	autoCommitInterval: number;
	/** Auto-commit message template (supports {date}, {branch}, {author}) */
	autoCommitMessage: string;
	/** Whether to automatically push after auto-commit */
	autoPushAfterCommit: boolean;
	/** Whether to sync (fetch/pull) on startup */
	syncOnStartup: boolean;
	/** Sync mode on startup: fetch only or pull */
	syncOnStartupMode: 'fetch' | 'pull';
	/**
	 * Per-repo snapshot of workdir blob OIDs at the time of the last
	 * GitLab Pages transformed commit. Used to suppress the "always
	 * modified" status that would otherwise show for transformed files
	 * (since HEAD has the transformed blob but the workdir keeps the
	 * Obsidian-flavored original). Keyed by repo id, then by repo-relative
	 * POSIX path.
	 */
	pagesCompatSnapshots?: Record<string, Record<string, string>>;
	/**
	 * Last-active side-panel tab per repository id. Used to restore the user's
	 * tab context when switching between repos. Tab ids match those defined
	 * in `side-panel-view.ts` (e.g. "changes", "files", "history", ...).
	 */
	activeTabByRepo?: Record<string, string>;
}

/**
 * Git file status
 */
export enum FileStatus {
	UNMODIFIED = 'unmodified',
	MODIFIED = 'modified',
	ADDED = 'added',
	DELETED = 'deleted',
	RENAMED = 'renamed',
	COPIED = 'copied',
	UNTRACKED = 'untracked',
	IGNORED = 'ignored',
	CONFLICTED = 'conflicted'
}

/**
 * Represents a file with its Git status
 */
export interface GitFile {
	/** Path relative to repository root */
	path: string;
	/** Current Git status */
	status: FileStatus;
	/** Whether file is staged */
	staged: boolean;
	/** Original path (for renames) */
	oldPath?: string;
}

/**
 * Git commit information
 */
export interface GitCommit {
	/** Commit SHA */
	sha: string;
	/** Commit message */
	message: string;
	/** Author name */
	authorName: string;
	/** Author email */
	authorEmail: string;
	/** Commit timestamp */
	timestamp: number;
	/** Parent commit SHAs */
	parents: string[];
}

/**
 * Git branch information
 */
export interface GitBranch {
	/** Branch name */
	name: string;
	/** Whether this is the current branch */
	isCurrent: boolean;
	/** Latest commit SHA */
	commitSha: string;
	/** Whether this is a remote branch */
	isRemote: boolean;
	/** Whether a corresponding remote-tracking branch exists (false = orphaned/zombie branch) */
	remoteExists?: boolean;
}

/**
 * Repository synchronization status
 */
export interface SyncStatus {
	/** Number of commits ahead of remote */
	ahead: number;
	/** Number of commits behind remote */
	behind: number;
	/** Whether there are uncommitted changes */
	hasUncommittedChanges: boolean;
	/** Whether there are untracked files */
	hasUntrackedFiles: boolean;
	/** Whether the remote branch doesn't exist yet (new local branch) */
	remoteBranchMissing?: boolean;
	/** Last fetch timestamp */
	lastFetch?: number;
}

/**
 * Merge conflict information
 */
export interface MergeConflict {
	/** File path with conflict */
	path: string;
	/** Conflict markers content */
	content: string;
	/** Our version */
	ours: string;
	/** Their version */
	theirs: string;
	/** Base version (common ancestor) */
	base?: string;
}

/**
 * Repository state information
 */
export interface RepositoryState {
	/** Repository configuration */
	config: SubTreeConfig;
	/** Current branch */
	currentBranch: string;
	/** All branches */
	branches: GitBranch[];
	/** Files with their status */
	files: GitFile[];
	/** Sync status */
	syncStatus: SyncStatus;
	/** Active merge conflicts */
	conflicts: MergeConflict[];
	/** Whether a Git operation is in progress */
	operationInProgress: boolean;
	/** Whether deferred initialization (git config, first refresh) has completed */
	initializationComplete: boolean;
}

/**
 * Merge Request information
 */
export interface MergeRequestParams {
	sourceBranch: string;
	targetBranch: string;
	title: string;
	description: string;
}

export interface MergeRequestResult {
	iid: number;
	title: string;
	webUrl: string;
	state: string;
	sourceBranch: string;
	targetBranch: string;
}

/**
 * Merge request note/comment
 */
export interface MergeRequestNote {
	id: number;
	body: string;
	author: { name: string; username: string };
	created_at: string;
	system: boolean;
}

/**
 * Merge request approval status
 */
export interface MergeRequestApproval {
	approved: boolean;
	approvals_required: number;
	approvals_left: number;
	approved_by: Array<{ user: { name: string; username: string } }>;
}

/**
 * CI/CD Pipeline info
 */
export interface Pipeline {
	id: number;
	status: 'running' | 'pending' | 'success' | 'failed' | 'canceled' | 'skipped' | 'created' | 'manual';
	ref: string;
	sha: string;
	web_url: string;
	created_at: string;
}

/**
 * CI/CD Pipeline job
 */
export interface PipelineJob {
	id: number;
	name: string;
	stage: string;
	status: string;
}

/**
 * Commit message template
 */
export interface CommitTemplate {
	id: string;
	name: string;
	/** Template string with variables: {jira}, {branch}, {date}, {author} */
	template: string;
}

/**
 * Git tag info
 */
export interface GitTag {
	name: string;
	oid: string;
	message?: string;
	tagger?: string;
	timestamp?: number;
}

/**
 * Stash entry
 */
export interface StashEntry {
	index: number;
	message: string;
	oid: string;
}

/**
 * Built-in commit templates
 */
export const DEFAULT_COMMIT_TEMPLATES: CommitTemplate[] = [
	{
		id: 'conventional-docs',
		name: 'Conventional (docs)',
		template: 'docs: {jira}\n\n',
	},
	{
		id: 'conventional-fix',
		name: 'Conventional (fix)',
		template: 'fix: {jira}\n\n',
	},
	{
		id: 'jira-prefixed',
		name: 'JIRA-prefixed',
		template: '[{jira}] ',
	},
	{
		id: 'simple',
		name: 'Simple',
		template: 'Update {branch} — {date}',
	},
];

/**
 * Default plugin settings
 */
export const DEFAULT_SETTINGS: GitLabPluginSettings = {
	repositories: [],
	showStatusIndicators: true,
	defaultAuthorName: '',
	defaultAuthorEmail: '',
	autoFetchInterval: 0,
	commitTemplates: [...DEFAULT_COMMIT_TEMPLATES],
	autoCommitEnabled: false,
	autoCommitInterval: 5,
	autoCommitMessage: 'auto: vault backup {date}',
	autoPushAfterCommit: false,
	syncOnStartup: false,
	syncOnStartupMode: 'fetch',
};
