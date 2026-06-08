import { GitFile, GitCommit, GitBranch, SyncStatus, GitTag, StashEntry, StashPushOptions, StashFileChange } from '../types';
import { UnsupportedOperationError } from './git-cli-executor';

/**
 * Snapshot of overrides to splice into the Git index before committing.
 *
 * - `files`: paths (relative to repo root) whose blob should be replaced
 *   with the given content. Used to commit a transformed version of a
 *   markdown file without modifying the user's working copy.
 * - `addedAssetPaths`: repo-relative paths of new files the pipeline put
 *   on disk (e.g. images moved into the assets folder). The commit flow
 *   stages these via git.add before the actual commit so the working
 *   tree, index and HEAD all agree.
 */
export interface IndexOverrideSnapshot {
	files: Map<string, Uint8Array>;
	addedAssetPaths?: string[];
}

export type CommitTransformHook = (stagedPaths: string[]) => Promise<IndexOverrideSnapshot>;

export interface ApplyOverridesResult {
	touched: string[];
	workdirOids: Record<string, string>;
}

export interface CommitResult {
	sha: string;
	transformedWorkdirOids?: Record<string, string>;
}

export interface GitBackendConfig {
	dir: string;
	author: {
		name: string;
		email: string;
	};
	disableSslVerification?: boolean;
	ignorePatterns?: string[];
	/** Git CLI path override (only used by GitCliBackend) */
	gitPath?: string;
}

/**
 * Backend-agnostic interface for all Git operations the plugin needs.
 * Implemented by GitIsoBackend (isomorphic-git) and GitCliBackend (CLI).
 */
export interface IGitBackend {
	// ---- Lifecycle ----
	setPagesCompatSnapshot(snapshot: Record<string, string> | undefined): void;
	isIgnored(filePath: string): boolean;
	getRepoDir(): string;

	// ---- Repository setup ----
	init(): Promise<void>;
	ensureAutoCrlf(): Promise<void>;
	addRemote(name: string, url: string): Promise<void>;
	clone(url: string, token: string, branch?: string): Promise<void>;

	// ---- Branch operations ----
	getCurrentBranch(): Promise<string>;
	listBranches(): Promise<GitBranch[]>;
	createBranch(branchName: string, startPoint?: string): Promise<void>;
	checkout(branchName: string, options?: { force?: boolean }): Promise<void>;
	deleteBranch(branchName: string): Promise<void>;
	isBranchMergedInto(branch: string, target: string): Promise<boolean>;

	// ---- Status / file listing ----
	status(filepath: string): Promise<string>;
	statusMatrix(): Promise<GitFile[]>;
	listAllFiles(): Promise<{ path: string; isDirectory: boolean; size: number }[]>;
	/** List all tracked folders in the repo at the given ref (default HEAD). */
	listTrackedFolders(ref?: string): Promise<string[]>;

	// ---- Staging ----
	add(filepaths: string[]): Promise<void>;
	remove(filepaths: string[]): Promise<void>;
	reset(filepaths: string[]): Promise<void>;

	// ---- Blob / index manipulation (Pages compat pipeline) ----
	writeBlob(content: Uint8Array): Promise<string>;
	updateIndexBlob(filepath: string, oid: string, add: boolean): Promise<void>;
	applyIndexOverrides(snapshot: IndexOverrideSnapshot): Promise<ApplyOverridesResult>;

	// ---- Commit ----
	commit(
		message: string,
		author?: { name: string; email: string },
		transformHook?: CommitTransformHook,
	): Promise<CommitResult>;
	amendCommit(
		message: string,
		author?: { name: string; email: string },
		transformHook?: CommitTransformHook,
	): Promise<CommitResult>;
	revertCommit(sha: string, author?: { name: string; email: string }): Promise<string>;

	// ---- Remote operations ----
	pull(remote: string, branch: string, token: string): Promise<void>;
	push(remote: string, branch: string, token: string): Promise<void>;
	fetch(remote: string, token: string): Promise<void>;

	// ---- History ----
	log(ref?: string, depth?: number): Promise<GitCommit[]>;
	getAllBranchLogs(depth?: number): Promise<{ commits: GitCommit[]; branchHeads: Map<string, string> }>;
	merge(theirBranch: string): Promise<void>;
	getSyncStatus(remote: string, branch: string): Promise<SyncStatus>;

	// ---- File content ----
	getFileAtCommit(filepath: string, ref?: string): Promise<string | null>;
	getWorkingCopyContent(filepath: string): Promise<string | null>;
	getFileHistory(filepath: string, depth?: number): Promise<GitCommit[]>;
	getFileBlame(filepath: string): Promise<Array<{
		startLine: number;
		endLine: number;
		commit: GitCommit;
	}>>;

	// ---- Tags ----
	listTags(): Promise<GitTag[]>;
	createTag(name: string, options?: { message?: string; oid?: string }): Promise<void>;
	deleteTag(name: string): Promise<void>;
	pushTag(tagName: string, token: string): Promise<void>;

	// ---- Stash ----
	/**
	 * Create a new stash entry. `opts.message` becomes the subject line;
	 * `opts.includeUntracked` (default true at the call site) passes `-u`
	 * so new files Obsidian users routinely have lying around are captured.
	 */
	stashPush(opts?: StashPushOptions): Promise<void>;
	stashPop(index?: number): Promise<void>;
	stashApply(index?: number): Promise<void>;
	stashList(): Promise<StashEntry[]>;
	stashDrop(index: number): Promise<void>;
	stashClear(): Promise<void>;
	/**
	 * Return the per-file change list for a single stash entry. Used by
	 * the side panel to expand a stash row and show what's inside. May
	 * return an empty array on backends that don't support the introspection.
	 */
	stashShow(index: number): Promise<StashFileChange[]>;
	/**
	 * Create a new branch from a stash entry (`git stash branch`). Pops
	 * the stash on success. Useful when a stash no longer applies cleanly
	 * to the current branch. Optional — backends that can't implement it
	 * should throw UnsupportedOperationError.
	 */
	stashBranch(index: number, branchName: string): Promise<void>;

	// ---- Sparse checkout (CLI backend only) ----
	sparseCheckoutInit(coneMode?: boolean): Promise<void>;
	sparseCheckoutSet(paths: string[]): Promise<void>;
	sparseCheckoutAdd(paths: string[]): Promise<void>;
	sparseCheckoutList(): Promise<string[]>;
	sparseCheckoutDisable(): Promise<void>;
	isSparseCheckout(): Promise<boolean>;
}

/**
 * Default implementations for sparse checkout methods that throw
 * UnsupportedOperationError. Mixed into backends that don't support sparse.
 */
export const SparseCheckoutStubs = {
	async sparseCheckoutInit(_coneMode?: boolean): Promise<void> {
		throw new UnsupportedOperationError('sparseCheckoutInit');
	},
	async sparseCheckoutSet(_paths: string[]): Promise<void> {
		throw new UnsupportedOperationError('sparseCheckoutSet');
	},
	async sparseCheckoutAdd(_paths: string[]): Promise<void> {
		throw new UnsupportedOperationError('sparseCheckoutAdd');
	},
	async sparseCheckoutList(): Promise<string[]> {
		throw new UnsupportedOperationError('sparseCheckoutList');
	},
	async sparseCheckoutDisable(): Promise<void> {
		throw new UnsupportedOperationError('sparseCheckoutDisable');
	},
	async isSparseCheckout(): Promise<boolean> {
		return false;
	},
};
