/**
 * Repository Manager
 * Manages multiple sub-tree to repository mappings
 */

import { App, TFile, TFolder } from 'obsidian';
import { SubTreeConfig, RepositoryState, GitFile, FileStatus, SyncStatus, GitLabPluginSettings } from '../types';
import { GitOperations } from '../api/git-operations';
import { normalizePath, isPathWithin } from '../utils/path-utils';
import * as path from 'path';
import * as fs from 'fs';

export type FileChangeListener = (repositoryId: string) => void;
export type InitializationCompleteListener = () => void;

/**
 * Manages Git operations across multiple repository mappings
 */
export class RepositoryManager {
	private app: App;
	private repositories: Map<string, RepositoryState>;
	private gitOps: Map<string, GitOperations>;
	private settings: GitLabPluginSettings | null = null;
	private lastAutoFetch: Map<string, number> = new Map();
	private watchers: Map<string, fs.FSWatcher> = new Map();
	private fileChangeListener: FileChangeListener | null = null;
	private initializationCompleteListener: InitializationCompleteListener | null = null;

	constructor(app: App) {
		this.app = app;
		this.repositories = new Map();
		this.gitOps = new Map();
	}

	/**
	 * Register a single listener invoked when a watched repo reports a
	 * filesystem change. Events are already gated per-repo; the caller is
	 * expected to debounce and batch.
	 */
	setFileChangeListener(listener: FileChangeListener | null): void {
		this.fileChangeListener = listener;
	}

	/**
	 * Register a listener invoked once `finalizeInitialization()` finishes
	 * (success or not). Used by the plugin to re-render already-open views
	 * that rendered with placeholder state during the fast phase.
	 */
	setInitializationCompleteListener(listener: InitializationCompleteListener | null): void {
		this.initializationCompleteListener = listener;
	}

	/**
	 * Start a recursive fs.watch on the repo's local path. Ignores events
	 * inside `.git/` — everything else flows to the listener and gets
	 * filtered properly by statusMatrix + ignorePatterns on refresh.
	 *
	 * Recursive watching is natively supported on Windows and macOS. On
	 * Linux (non-recursive fs.watch) this watches only the top-level dir,
	 * which is a known degradation; users can fall back to manual refresh
	 * or the auto-fetch interval.
	 */
	private startWatcher(repoId: string, absRepoPath: string): void {
		this.stopWatcher(repoId);
		try {
			if (!fs.existsSync(absRepoPath)) return;
			const watcher = fs.watch(absRepoPath, { recursive: true }, (_eventType, filename) => {
				if (!filename) return;
				const name = filename.toString().replace(/\\/g, '/');
				if (name === '.git' || name.startsWith('.git/')) return;
				this.fileChangeListener?.(repoId);
			});
			watcher.on('error', (err) => {
				console.warn(`fs.watch error for repo ${repoId}:`, err);
			});
			this.watchers.set(repoId, watcher);
		} catch (err) {
			console.warn(`Failed to start fs.watch for repo ${repoId}:`, err);
		}
	}

	private stopWatcher(repoId: string): void {
		const existing = this.watchers.get(repoId);
		if (existing) {
			try { existing.close(); } catch { /* ignore */ }
			this.watchers.delete(repoId);
		}
	}

	stopAllWatchers(): void {
		for (const id of Array.from(this.watchers.keys())) {
			this.stopWatcher(id);
		}
	}

	/**
	 * Update settings reference (call when settings change)
	 */
	setSettings(settings: GitLabPluginSettings): void {
		this.settings = settings;
	}

	/**
	 * Fast-phase initialization. Registers every enabled repo synchronously
	 * (GitOperations instance + placeholder state) without hitting the disk
	 * beyond the vault adapter or touching the network. Returns in a handful
	 * of milliseconds so the plugin's `onload()` does not block Obsidian's
	 * startup. Callers MUST follow up with `finalizeInitialization()`
	 * (typically via `onLayoutReady`) to run the heavy git work.
	 */
	async initialize(configs: SubTreeConfig[]): Promise<void> {
		this.stopAllWatchers();
		this.repositories.clear();
		this.gitOps.clear();

		for (const config of configs) {
			if (config.enabled) {
				this.registerRepositoryFast(config);
			}
		}
	}

	/**
	 * Deferred-phase initialization. Walks every fast-registered repo and
	 * runs the per-repo git work that used to happen inside `onload()`:
	 * `.git` creation if missing, remote config, autocrlf, fs.watch setup,
	 * and the first full `refreshRepository` (fetch + branches + statusMatrix).
	 * Runs repos sequentially so we do not slam a single token with
	 * simultaneous fetches. One broken repo does not abort the others.
	 */
	async finalizeInitialization(): Promise<void> {
		const ids = Array.from(this.gitOps.keys());
		for (const id of ids) {
			try {
				await this.finalizeRepository(id);
			} catch (error) {
				console.error(`Failed to finalize repository ${id}:`, error);
			}
		}
		this.initializationCompleteListener?.();
	}

	/**
	 * Synchronous, cheap half of `addRepository`. Constructs GitOperations,
	 * seeds a placeholder state, and registers both in the maps. Intentionally
	 * does no filesystem or network I/O — `finalizeRepository` handles that.
	 */
	private registerRepositoryFast(config: SubTreeConfig): void {
		const authorName = this.settings?.defaultAuthorName || 'Obsidian User';
		const authorEmail = this.settings?.defaultAuthorEmail || 'user@obsidian.md';

		const repoDir = path.join((this.app.vault.adapter as any).basePath, config.localPath);
		const gitOps = new GitOperations({
			dir: repoDir,
			author: {
				name: authorName,
				email: authorEmail,
			},
			disableSslVerification: config.disableSslVerification || false,
			ignorePatterns: config.ignorePatterns || [],
		});

		const state: RepositoryState = {
			config,
			currentBranch: config.currentBranch,
			branches: [],
			files: [],
			syncStatus: {
				ahead: 0,
				behind: 0,
				hasUncommittedChanges: false,
				hasUntrackedFiles: false,
			},
			conflicts: [],
			operationInProgress: false,
			initializationComplete: false,
		};

		this.repositories.set(config.id, state);
		this.gitOps.set(config.id, gitOps);
	}

	/**
	 * Deferred-phase per-repo work. Runs init/addRemote if the repo is new,
	 * or addRemote + ensureAutoCrlf on an existing repo. Starts the fs
	 * watcher and triggers the first full refresh. Marks the state as
	 * fully initialized once it is safe for UI to treat it as "live".
	 */
	private async finalizeRepository(repositoryId: string): Promise<void> {
		const state = this.repositories.get(repositoryId);
		const gitOps = this.gitOps.get(repositoryId);
		if (!state || !gitOps) return;

		const config = state.config;
		const repoDir = path.join((this.app.vault.adapter as any).basePath, config.localPath);

		const gitDir = path.join(repoDir, '.git');
		const isGitRepo = fs.existsSync(gitDir);

		if (!isGitRepo) {
			if (!fs.existsSync(repoDir)) {
				fs.mkdirSync(repoDir, { recursive: true });
			}
			await gitOps.init();
			await gitOps.addRemote('origin', config.repositoryUrl);
			// Skip eager fetch: refreshRepository below fetches (throttled),
			// and `performStartupSync` also fetches if the user has it enabled.
		} else {
			await gitOps.addRemote('origin', config.repositoryUrl);
			await gitOps.ensureAutoCrlf();
		}

		this.startWatcher(config.id, repoDir);

		await this.refreshRepository(config.id);

		state.initializationComplete = true;
	}

	/**
	 * Add a repository mapping. Used by the settings UI for single-repo
	 * additions — runs both phases back-to-back so callers observe the
	 * same behavior as before the split.
	 */
	async addRepository(config: SubTreeConfig): Promise<void> {
		try {
			this.registerRepositoryFast(config);
			await this.finalizeRepository(config.id);
		} catch (error) {
			console.error(`Failed to add repository ${config.id}:`, error);
			throw error;
		}
	}

	/**
	 * Remove a repository mapping
	 */
	removeRepository(repositoryId: string): void {
		this.stopWatcher(repositoryId);
		this.repositories.delete(repositoryId);
		this.gitOps.delete(repositoryId);
	}

	/**
	 * Get repository state by ID
	 */
	getRepository(repositoryId: string): RepositoryState | undefined {
		return this.repositories.get(repositoryId);
	}

	/**
	 * Get all repositories
	 */
	getAllRepositories(): RepositoryState[] {
		return Array.from(this.repositories.values());
	}

	/**
	 * Find which repository a file belongs to
	 */
	getRepositoryForFile(file: TFile): RepositoryState | undefined {
		const filePath = normalizePath(file.path);

		for (const state of this.repositories.values()) {
			const repoPath = normalizePath(state.config.localPath);
			if (isPathWithin(filePath, repoPath)) {
				return state;
			}
		}

		return undefined;
	}

	/**
	 * Find which repository a folder belongs to
	 */
	getRepositoryForFolder(folder: TFolder): RepositoryState | undefined {
		const folderPath = normalizePath(folder.path);

		for (const state of this.repositories.values()) {
			const repoPath = normalizePath(state.config.localPath);
			if (isPathWithin(folderPath, repoPath) || folderPath === repoPath) {
				return state;
			}
		}

		return undefined;
	}

	/**
	 * Refresh repository state
	 */
	async refreshRepository(repositoryId: string): Promise<void> {
		const state = this.repositories.get(repositoryId);
		const gitOps = this.gitOps.get(repositoryId);

		if (!state || !gitOps) {
			return;
		}

		try {
			// Best-effort fetch+prune so we detect remote-deleted branches.
			// Throttled to once per 30s per repo to avoid hammering on every refresh.
			const now = Date.now();
			const last = this.lastAutoFetch.get(repositoryId) ?? 0;
			if (state.config.token && now - last > 30_000) {
				this.lastAutoFetch.set(repositoryId, now);
				try {
					await gitOps.fetch('origin', state.config.token);
				} catch (e) {
					// Non-fatal: offline, auth issues, etc. Refresh continues with cached refs.
					console.debug(`Auto-fetch failed for ${repositoryId}:`, e);
				}
			}

			// Get current branch
			state.currentBranch = await gitOps.getCurrentBranch();

			// Get branches
			state.branches = await gitOps.listBranches();

			// Get file status
			state.files = await gitOps.statusMatrix();

			// Get sync status
			state.syncStatus = await gitOps.getSyncStatus('origin', state.currentBranch);
		} catch (error) {
			console.error(`Failed to refresh repository ${repositoryId}:`, error);
		}
	}

	/**
	 * Lightweight refresh: only re-run statusMatrix to update the file list.
	 * Skips fetch, branch list, and sync status — safe to call on every vault
	 * event without hitting the network or re-enumerating refs.
	 */
	async refreshFilesOnly(repositoryId: string): Promise<void> {
		const state = this.repositories.get(repositoryId);
		const gitOps = this.gitOps.get(repositoryId);

		if (!state || !gitOps) return;

		try {
			state.files = await gitOps.statusMatrix();
		} catch (error) {
			console.error(`Failed to refresh files for repository ${repositoryId}:`, error);
		}
	}

	/**
	 * Find the repository ID that owns a given vault-relative path, or null.
	 */
	getRepositoryIdForPath(filePath: string): string | null {
		const normalized = normalizePath(filePath);
		for (const [id, state] of this.repositories.entries()) {
			const repoPath = normalizePath(state.config.localPath);
			if (isPathWithin(normalized, repoPath)) {
				return id;
			}
		}
		return null;
	}

	/**
	 * Refresh all repositories
	 */
	async refreshAll(): Promise<void> {
		const promises = Array.from(this.repositories.keys()).map(id =>
			this.refreshRepository(id)
		);
		await Promise.all(promises);
	}

	/**
	 * Get Git operations for repository
	 */
	getGitOps(repositoryId: string): GitOperations | undefined {
		return this.gitOps.get(repositoryId);
	}

	/**
	 * Check if a file path belongs to any repository
	 */
	isFileInRepository(filePath: string): boolean {
		const normalized = normalizePath(filePath);

		for (const state of this.repositories.values()) {
			const repoPath = normalizePath(state.config.localPath);
			if (isPathWithin(normalized, repoPath)) {
				return true;
			}
		}

		return false;
	}

	/**
	 * Get file status for a specific file
	 */
	async getFileStatus(filePath: string): Promise<FileStatus | null> {
		const normalized = normalizePath(filePath);

		for (const [id, state] of this.repositories.entries()) {
			const repoPath = normalizePath(state.config.localPath);
			if (isPathWithin(normalized, repoPath)) {
				const gitOps = this.gitOps.get(id);
				if (!gitOps) continue;

				// Get relative path within repository
				const relativePath = normalized.substring(repoPath.length + 1);

				try {
					const status = await gitOps.status(relativePath);
					return this.mapGitStatus(status);
				} catch (error) {
					return null;
				}
			}
		}

		return null;
	}

	/**
	 * Map isomorphic-git status to our FileStatus enum
	 */
	private mapGitStatus(status: string): FileStatus {
		switch (status) {
			case 'unmodified':
				return FileStatus.UNMODIFIED;
			case 'modified':
				return FileStatus.MODIFIED;
			case '*added':
				return FileStatus.ADDED;
			case '*deleted':
				return FileStatus.DELETED;
			case '*unmodified':
				return FileStatus.UNMODIFIED;
			case '*modified':
				return FileStatus.MODIFIED;
			default:
				return FileStatus.UNTRACKED;
		}
	}

	/**
	 * Set operation in progress flag
	 */
	setOperationInProgress(repositoryId: string, inProgress: boolean): void {
		const state = this.repositories.get(repositoryId);
		if (state) {
			state.operationInProgress = inProgress;
		}
	}
}
