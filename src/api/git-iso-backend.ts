/**
 * isomorphic-git backend adapter.
 *
 * Wraps the existing GitOperations class to implement IGitBackend.
 * Sparse checkout methods throw UnsupportedOperationError since
 * isomorphic-git has no sparse checkout support.
 *
 * During the V2 migration, GitOperations is kept intact and this
 * adapter delegates to it. Once the CLI backend is the primary path
 * and everything has stabilized, the isomorphic-git code can be
 * inlined here and git-operations.ts removed.
 */

import { GitOperations, type IndexOverrideSnapshot as IsoIndexOverride, type CommitTransformHook as IsoTransformHook } from './git-operations';
import type {
	IGitBackend,
	GitBackendConfig,
	IndexOverrideSnapshot,
	CommitTransformHook,
	ApplyOverridesResult,
	CommitResult,
} from './git-backend';
import { SparseCheckoutStubs } from './git-backend';
import type { GitFile, GitCommit, GitBranch, SyncStatus, GitTag, StashEntry, StashPushOptions, StashFileChange } from '../types';
import { UnsupportedOperationError } from './git-cli-executor';

export class GitIsoBackend implements IGitBackend {
	private ops: GitOperations;

	constructor(config: GitBackendConfig) {
		this.ops = new GitOperations({
			dir: config.dir,
			author: config.author,
			disableSslVerification: config.disableSslVerification,
			ignorePatterns: config.ignorePatterns,
		});
	}

	// ---- Lifecycle ----
	setPagesCompatSnapshot(snapshot: Record<string, string> | undefined): void {
		this.ops.setPagesCompatSnapshot(snapshot);
	}
	isIgnored(filePath: string): boolean {
		return this.ops.isIgnored(filePath);
	}
	getRepoDir(): string {
		return this.ops.getRepoDir();
	}

	// ---- Repository setup ----
	init(): Promise<void> { return this.ops.init(); }
	ensureAutoCrlf(): Promise<void> { return this.ops.ensureAutoCrlf(); }
	addRemote(name: string, url: string): Promise<void> { return this.ops.addRemote(name, url); }
	clone(url: string, token: string, branch?: string): Promise<void> { return this.ops.clone(url, token, branch); }

	// ---- Branch operations ----
	getCurrentBranch(): Promise<string> { return this.ops.getCurrentBranch(); }
	listBranches(): Promise<GitBranch[]> { return this.ops.listBranches(); }
	createBranch(branchName: string, startPoint?: string): Promise<void> { return this.ops.createBranch(branchName, startPoint); }
	checkout(branchName: string, options?: { force?: boolean }): Promise<void> { return this.ops.checkout(branchName, options); }
	deleteBranch(branchName: string): Promise<void> { return this.ops.deleteBranch(branchName); }
	isBranchMergedInto(branch: string, target: string): Promise<boolean> { return this.ops.isBranchMergedInto(branch, target); }

	// ---- Status ----
	status(filepath: string): Promise<string> { return this.ops.status(filepath); }
	statusMatrix(): Promise<GitFile[]> { return this.ops.statusMatrix(); }
	listAllFiles(): Promise<{ path: string; isDirectory: boolean; size: number }[]> { return this.ops.listAllFiles(); }
	async listTrackedFolders(_ref?: string): Promise<string[]> {
		const entries = await this.ops.listAllFiles();
		return entries
			.filter(e => e.isDirectory)
			.map(e => e.path)
			.sort();
	}

	// ---- Staging ----
	add(filepaths: string[]): Promise<void> { return this.ops.add(filepaths); }
	remove(filepaths: string[]): Promise<void> { return this.ops.remove(filepaths); }
	reset(filepaths: string[]): Promise<void> { return this.ops.reset(filepaths); }

	// ---- Blob / index manipulation ----
	writeBlob(content: Uint8Array): Promise<string> { return this.ops.writeBlob(content); }
	updateIndexBlob(filepath: string, oid: string, add: boolean): Promise<void> { return this.ops.updateIndexBlob(filepath, oid, add); }
	applyIndexOverrides(snapshot: IndexOverrideSnapshot): Promise<ApplyOverridesResult> {
		return this.ops.applyIndexOverrides(snapshot as IsoIndexOverride);
	}

	// ---- Commit ----
	commit(message: string, author?: { name: string; email: string }, transformHook?: CommitTransformHook): Promise<CommitResult> {
		return this.ops.commit(message, author, transformHook as IsoTransformHook | undefined);
	}
	amendCommit(message: string, author?: { name: string; email: string }, transformHook?: CommitTransformHook): Promise<CommitResult> {
		return this.ops.amendCommit(message, author, transformHook as IsoTransformHook | undefined);
	}
	revertCommit(sha: string, author?: { name: string; email: string }): Promise<string> {
		return this.ops.revertCommit(sha, author);
	}

	// ---- Remote operations ----
	pull(remote: string, branch: string, token: string): Promise<void> { return this.ops.pull(remote, branch, token); }
	push(remote: string, branch: string, token: string): Promise<void> { return this.ops.push(remote, branch, token); }
	fetch(remote: string, token: string): Promise<void> { return this.ops.fetch(remote, token); }

	// ---- History ----
	log(ref?: string, depth?: number): Promise<GitCommit[]> { return this.ops.log(ref, depth); }
	getAllBranchLogs(depth?: number): Promise<{ commits: GitCommit[]; branchHeads: Map<string, string> }> { return this.ops.getAllBranchLogs(depth); }
	merge(theirBranch: string): Promise<void> { return this.ops.merge(theirBranch); }
	getSyncStatus(remote: string, branch: string): Promise<SyncStatus> { return this.ops.getSyncStatus(remote, branch); }

	// ---- File content ----
	getFileAtCommit(filepath: string, ref?: string): Promise<string | null> { return this.ops.getFileAtCommit(filepath, ref); }
	getWorkingCopyContent(filepath: string): Promise<string | null> { return this.ops.getWorkingCopyContent(filepath); }
	getFileHistory(filepath: string, depth?: number): Promise<GitCommit[]> { return this.ops.getFileHistory(filepath, depth); }
	getFileBlame(filepath: string): Promise<Array<{ startLine: number; endLine: number; commit: GitCommit }>> { return this.ops.getFileBlame(filepath); }

	// ---- Tags ----
	listTags(): Promise<GitTag[]> { return this.ops.listTags(); }
	createTag(name: string, options?: { message?: string; oid?: string }): Promise<void> { return this.ops.createTag(name, options); }
	deleteTag(name: string): Promise<void> { return this.ops.deleteTag(name); }
	pushTag(tagName: string, token: string): Promise<void> { return this.ops.pushTag(tagName, token); }

	// ---- Stash ----
	// The iso-git wrapper only knows how to take a message string, so we
	// drop the other StashPushOptions on the floor. Untracked-file inclusion
	// and pathspec stashes are CLI-only features for now.
	stashPush(opts?: StashPushOptions): Promise<void> { return this.ops.stashPush(opts?.message); }
	stashPop(index?: number): Promise<void> { return this.ops.stashPop(index); }
	stashApply(index?: number): Promise<void> { return this.ops.stashApply(index); }
	stashList(): Promise<StashEntry[]> { return this.ops.stashList(); }
	stashDrop(index: number): Promise<void> { return this.ops.stashDrop(index); }
	stashClear(): Promise<void> { return this.ops.stashClear(); }
	async stashShow(_index: number): Promise<StashFileChange[]> {
		// iso-git's stash plugin doesn't surface a per-file diff cheaply.
		// Returning [] is treated as "no preview available" by the UI rather
		// than as an error — the actions still work.
		return [];
	}
	async stashBranch(_index: number, _branchName: string): Promise<void> {
		throw new UnsupportedOperationError('Create branch from stash requires the Git CLI backend.');
	}

	// ---- Sparse checkout (not supported) ----
	sparseCheckoutInit = SparseCheckoutStubs.sparseCheckoutInit;
	sparseCheckoutSet = SparseCheckoutStubs.sparseCheckoutSet;
	sparseCheckoutAdd = SparseCheckoutStubs.sparseCheckoutAdd;
	sparseCheckoutList = SparseCheckoutStubs.sparseCheckoutList;
	sparseCheckoutDisable = SparseCheckoutStubs.sparseCheckoutDisable;
	isSparseCheckout = SparseCheckoutStubs.isSparseCheckout;
}
