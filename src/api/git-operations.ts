/**
 * Git operations using isomorphic-git
 * Handles local Git repository operations
 */

import * as git from 'isomorphic-git';
import http from 'isomorphic-git/http/node';
import * as fs from 'fs';
import { Notice } from 'obsidian';
import { GitFile, FileStatus, GitCommit, GitBranch, SyncStatus, MergeConflict, GitTag, StashEntry } from '../types';

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
 *
 * `files` keys on POSIX-style repo-relative paths. Values are raw bytes.
 */
export interface IndexOverrideSnapshot {
	files: Map<string, Uint8Array>;
	addedAssetPaths?: string[];
}

export type CommitTransformHook = (stagedPaths: string[]) => Promise<IndexOverrideSnapshot>;

/**
 * Result of applying overrides to the index. `workdirOids` carries the
 * git blob OID of the *original* workdir bytes (before the override) for
 * every transformed file — these are persisted by the plugin so that
 * subsequent statusMatrix calls can suppress the "always modified" state.
 */
export interface ApplyOverridesResult {
	touched: string[];
	workdirOids: Record<string, string>;
}

/**
 * Return shape for commit/amendCommit. `transformedWorkdirOids` is set
 * only when a transform hook ran and produced overrides.
 */
export interface CommitResult {
	sha: string;
	transformedWorkdirOids?: Record<string, string>;
}
import { DebugLogger } from '../utils/debug-logger';

// Enhanced HTTP client with gzip handling and detailed logging
const createEnhancedHttp = (token: string, authFormat: { username: string, password: string }) => {
	return {
		async request({ url, method, headers, body }: any) {
			// Don't request gzip encoding - let the server send uncompressed data
			const modifiedHeaders = {
				...headers,
				'Accept-Encoding': 'identity' // Request uncompressed
			};
			
			DebugLogger.log('GitOps', 'HTTP Request', { 
				url, 
				method: method || 'GET',
				headers: { ...modifiedHeaders, Authorization: '[REDACTED]' }
			});
			
			try {
				const response = await http.request({ 
					url, 
					method, 
					headers: modifiedHeaders, 
					body 
				});
				
				// Capture response body for logging
				let bodyPreview = '[Empty]';
				if (response.body) {
					try {
						// Response body might be AsyncIterableIterator or Buffer
						const bodyStr = response.body.toString();
						bodyPreview = bodyStr.substring(0, 200);
					} catch {
						bodyPreview = '[Binary/Stream data]';
					}
				}
				
				DebugLogger.log('GitOps', 'HTTP Response', { 
					url,
					statusCode: response.statusCode,
					statusMessage: response.statusMessage,
					headers: response.headers,
					contentEncoding: response.headers?.['content-encoding'] || 'none',
					bodyPreview
				});
				
				return response;
			} catch (error: any) {
				DebugLogger.error('GitOps', 'HTTP Request failed', { 
					url, 
					error: {
						message: error.message,
						statusCode: error.statusCode,
						statusMessage: error.statusMessage,
						code: error.code
					}
				});
				throw error;
			}
		}
	};
};

export interface GitOperationsConfig {
	dir: string;
	author: {
		name: string;
		email: string;
	};
	disableSslVerification?: boolean;
	ignorePatterns?: string[];
}

/**
 * Match a file path against gitignore-style glob patterns.
 * Supports: *, **, ?, and directory patterns ending with /
 */
function matchesIgnorePattern(filePath: string, patterns: string[]): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	for (const pattern of patterns) {
		if (globMatch(normalized, pattern)) return true;
		// Also match if any parent directory matches a directory pattern
		const parts = normalized.split('/');
		for (let i = 1; i <= parts.length; i++) {
			const partial = parts.slice(0, i).join('/');
			if (globMatch(partial, pattern)) return true;
		}
	}
	return false;
}

/**
 * Simple glob matching (supports *, **, ?)
 */
function globMatch(text: string, pattern: string): boolean {
	// Convert glob to regex
	let regex = '';
	let i = 0;
	while (i < pattern.length) {
		const c = pattern[i];
		if (c === '*') {
			if (pattern[i + 1] === '*') {
				if (pattern[i + 2] === '/') {
					regex += '(?:.*/)?';
					i += 3;
				} else {
					regex += '.*';
					i += 2;
				}
			} else {
				regex += '[^/]*';
				i++;
			}
		} else if (c === '?') {
			regex += '[^/]';
			i++;
		} else if (c === '.') {
			regex += '\\.';
			i++;
		} else {
			regex += c;
			i++;
		}
	}

	try {
		return new RegExp(`^${regex}$`).test(text);
	} catch {
		return false;
	}
}

/**
 * Wrapper for Git operations using isomorphic-git
 */
export class GitOperations {
	private config: GitOperationsConfig;
	private fs: typeof fs;
	/**
	 * Per-path workdir blob OIDs captured at the last successful
	 * transformed commit. Used by statusMatrix to suppress files that
	 * appear modified only because HEAD holds the transformed blob.
	 */
	private pagesCompatSnapshot: Record<string, string> = {};

	constructor(config: GitOperationsConfig) {
		this.config = config;
		this.fs = fs;
		DebugLogger.log('GitOps', `Initialized for directory: ${config.dir}`);
	}

	/**
	 * Inject (or replace) the per-path snapshot of workdir blob OIDs
	 * recorded at the last GitLab Pages transformed commit. The plugin
	 * calls this on initialization and after every transformed commit so
	 * that statusMatrix can hide files whose workdir bytes are unchanged
	 * since they were last committed in transformed form.
	 */
	setPagesCompatSnapshot(snapshot: Record<string, string> | undefined): void {
		this.pagesCompatSnapshot = snapshot ? { ...snapshot } : {};
	}

	/**
	 * Read raw workdir bytes for a repo-relative path. Returns null if
	 * the file is missing or unreadable.
	 */
	private readWorkdirBytes(filepath: string): Uint8Array | null {
		try {
			// eslint-disable-next-line @typescript-eslint/no-var-requires
			const path = require('path');
			const abs = path.join(this.config.dir, filepath);
			const buf = this.fs.readFileSync(abs);
			return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
		} catch {
			return null;
		}
	}

	/**
	 * Check if a file path matches any of the configured ignore patterns
	 */
	isIgnored(filePath: string): boolean {
		const patterns = this.config.ignorePatterns;
		if (!patterns || patterns.length === 0) return false;
		return matchesIgnorePattern(filePath, patterns);
	}

	/**
	 * Initialize a new Git repository
	 */
	async init(): Promise<void> {
		try {
			DebugLogger.log('GitOps', 'Initializing repository', { dir: this.config.dir });
			
			await git.init({
				fs: this.fs,
				dir: this.config.dir,
				defaultBranch: 'main',
			});

			await this.ensureAutoCrlf();
			
			DebugLogger.log('GitOps', 'Repository initialized successfully');
		} catch (error) {
			DebugLogger.error('GitOps', 'Init failed', error);
			this.handleError('Failed to initialize repository', error);
			throw error;
		}
	}

	/**
	 * Ensure core.autocrlf is set to normalize line endings on Windows
	 */
	async ensureAutoCrlf(): Promise<void> {
		try {
			await git.setConfig({
				fs: this.fs,
				dir: this.config.dir,
				path: 'core.autocrlf',
				value: 'true',
			});
			DebugLogger.log('GitOps', 'Set core.autocrlf = true');
		} catch (error) {
			DebugLogger.log('GitOps', 'Could not set core.autocrlf', { error });
		}
	}

	/**
	 * Add or update a remote
	 */
	async addRemote(name: string, url: string): Promise<void> {
		try {
			// Normalize URL: ensure it ends with .git for Git protocol compatibility
			let normalizedUrl = url.trim();
			if (!normalizedUrl.endsWith('.git')) {
				normalizedUrl = normalizedUrl + '.git';
				DebugLogger.log('GitOps', 'Normalized URL by appending .git', { original: url, normalized: normalizedUrl });
			}
			
			DebugLogger.log('GitOps', 'Adding remote', { name, url: normalizedUrl, dir: this.config.dir });
			
			// Check if remote already exists
			const remotes = await git.listRemotes({ fs: this.fs, dir: this.config.dir });
			const existingRemote = remotes.find(r => r.remote === name);
			
			if (existingRemote) {
				// Remove and re-add to update URL
				await git.deleteRemote({ fs: this.fs, dir: this.config.dir, remote: name });
				DebugLogger.log('GitOps', 'Removed existing remote', { name });
			}
			
			await git.addRemote({
				fs: this.fs,
				dir: this.config.dir,
				remote: name,
				url: normalizedUrl,
			});
			
			DebugLogger.log('GitOps', 'Remote added successfully', { name, url: normalizedUrl });
		} catch (error) {
			DebugLogger.error('GitOps', 'Add remote failed', error);
			this.handleError('Failed to add remote', error);
			throw error;
		}
	}

	/**
	 * Clone a repository
	 */
	async clone(url: string, token: string, branch?: string): Promise<void> {
		try {
			// Normalize URL: ensure it ends with .git for Git protocol compatibility
			let normalizedUrl = url.trim();
			if (!normalizedUrl.endsWith('.git')) {
				normalizedUrl = normalizedUrl + '.git';
				DebugLogger.log('GitOps', 'Normalized clone URL by appending .git', { original: url, normalized: normalizedUrl });
			}
			
			DebugLogger.log('GitOps', 'Starting clone', { url: normalizedUrl, branch, dir: this.config.dir });
			
			// Use enhanced HTTP client with gzip handling
			const authFormat = { username: 'oauth2', password: token };
			const enhancedHttp = createEnhancedHttp(token, authFormat);
			
			if (this.config.disableSslVerification) {
				DebugLogger.warn('GitOps', 'SSL verification disabled for clone');
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
			}
			
			await git.clone({
				fs: this.fs,
				http: enhancedHttp,
				dir: this.config.dir,
				url: normalizedUrl,
				ref: branch,
				singleBranch: false,
				depth: 1,
				onAuth: () => {
					DebugLogger.log('GitOps', 'Auth callback triggered for clone (oauth2 format)');
					return { 
						username: 'oauth2', 
						password: token 
					};
				},
			});
			
			if (this.config.disableSslVerification) {
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
			}
			
			DebugLogger.log('GitOps', 'Clone completed successfully');
		} catch (error) {
			if (this.config.disableSslVerification) {
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
			}
			DebugLogger.error('GitOps', 'Clone failed', error);
			this.handleError('Failed to clone repository', error);
			throw error;
		}
	}

	/**
	 * Get current branch name
	 */
	async getCurrentBranch(): Promise<string> {
		try {
			return await git.currentBranch({
				fs: this.fs,
				dir: this.config.dir,
				fullname: false,
			}) || 'main';
		} catch (error) {
			this.handleError('Failed to get current branch', error);
			throw error;
		}
	}

	/**
	 * List all branches
	 */
	async listBranches(): Promise<GitBranch[]> {
		try {
			const branches = await git.listBranches({
				fs: this.fs,
				dir: this.config.dir,
			});

			// Get remote-tracking branches to detect orphaned locals
			let remoteBranchNames: Set<string> = new Set();
			try {
				const remoteBranches = await git.listBranches({
					fs: this.fs,
					dir: this.config.dir,
					remote: 'origin',
				});
				remoteBranchNames = new Set(remoteBranches);
			} catch {
				// Remote may not be configured; treat all as having remotes
			}

			const currentBranch = await this.getCurrentBranch();

			return await Promise.all(
				branches.map(async (name) => {
					try {
						const oid = await git.resolveRef({
							fs: this.fs,
							dir: this.config.dir,
							ref: name,
						});

						return {
							name,
							isCurrent: name === currentBranch,
							commitSha: oid,
							isRemote: false,
							remoteExists: remoteBranchNames.size > 0 ? remoteBranchNames.has(name) : undefined,
						};
					} catch (e) {
						return {
							name,
							isCurrent: name === currentBranch,
							commitSha: '',
							isRemote: false,
							remoteExists: remoteBranchNames.size > 0 ? remoteBranchNames.has(name) : undefined,
						};
					}
				})
			);
		} catch (error) {
			this.handleError('Failed to list branches', error);
			throw error;
		}
	}

	/**
	 * Create a new branch
	 */
	async createBranch(branchName: string, startPoint?: string): Promise<void> {
		try {
			const object = startPoint || await this.getCurrentBranch();
			await git.branch({
				fs: this.fs,
				dir: this.config.dir,
				ref: branchName,
				object,
				checkout: false,
			});
		} catch (error) {
			this.handleError('Failed to create branch', error);
			throw error;
		}
	}

	/**
	 * Switch to a different branch
	 */
	async checkout(branchName: string, options?: { force?: boolean }): Promise<void> {
		try {
			await git.checkout({
				fs: this.fs,
				dir: this.config.dir,
				ref: branchName,
				force: options?.force === true,
			});
		} catch (error) {
			this.handleError('Failed to checkout branch', error);
			throw error;
		}
	}

	/**
	 * Delete a branch
	 */
	async deleteBranch(branchName: string): Promise<void> {
		try {
			await git.deleteBranch({
				fs: this.fs,
				dir: this.config.dir,
				ref: branchName,
			});
		} catch (error) {
			this.handleError('Failed to delete branch', error);
			throw error;
		}
	}

	/**
	 * Get file status
	 */
	async status(filepath: string): Promise<string> {
		try {
			const status = await git.status({
				fs: this.fs,
				dir: this.config.dir,
				filepath,
			});
			return status;
		} catch (error) {
			return 'unknown';
		}
	}

	/**
	 * Get status of all files
	 */
	async statusMatrix(): Promise<GitFile[]> {
		try {
			const matrix = await git.statusMatrix({
				fs: this.fs,
				dir: this.config.dir,
			});

			const files: GitFile[] = [];

			for (const [filepath, headStatus, workdirStatus, stageStatus] of matrix) {
				// Skip if file hasn't changed
				if (headStatus === 1 && workdirStatus === 1 && stageStatus === 1) {
					continue;
				}

				// Skip files matching ignore patterns
				if (this.isIgnored(filepath)) {
					continue;
				}

				let status: FileStatus;
				let staged = false;

				if (headStatus === 0 && workdirStatus === 2 && stageStatus === 0) {
					status = FileStatus.UNTRACKED;
				} else if (headStatus === 0 && workdirStatus === 2 && stageStatus === 2) {
					status = FileStatus.ADDED;
					staged = true;
				} else if (headStatus === 1 && workdirStatus === 2 && stageStatus === 1) {
					status = FileStatus.MODIFIED;
				} else if (headStatus === 1 && workdirStatus === 2 && stageStatus === 2) {
					status = FileStatus.MODIFIED;
					staged = true;
				} else if (headStatus === 1 && workdirStatus === 0 && stageStatus === 1) {
					status = FileStatus.DELETED;
				} else if (headStatus === 1 && workdirStatus === 0 && stageStatus === 0) {
					status = FileStatus.DELETED;
					staged = true;
				} else {
					status = FileStatus.UNMODIFIED;
				}

				// GitLab Pages compatibility: a file shows as MODIFIED here
				// because HEAD holds the transformed blob while the workdir
				// keeps the original Obsidian content. If the workdir bytes
				// still hash to the OID we recorded at the last transformed
				// commit, the user hasn't actually edited it — suppress.
				if (
					!staged &&
					status === FileStatus.MODIFIED &&
					this.pagesCompatSnapshot[filepath]
				) {
					const bytes = this.readWorkdirBytes(filepath);
					if (bytes) {
						try {
							const { oid } = await git.hashBlob({ object: bytes });
							if (oid === this.pagesCompatSnapshot[filepath]) {
								continue;
							}
						} catch {
							// fall through and report as modified
						}
					}
				}

				files.push({
					path: filepath,
					status,
					staged,
				});
			}

			return files;
		} catch (error) {
			this.handleError('Failed to get status', error);
			throw error;
		}
	}

	/**
	 * List ALL files in the repository directory (any extension)
	 * Returns paths relative to the repo root
	 */
	async listAllFiles(): Promise<{ path: string; isDirectory: boolean; size: number }[]> {
		const results: { path: string; isDirectory: boolean; size: number }[] = [];
		const repoDir = this.config.dir;

		const walk = (dir: string, prefix: string) => {
			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					// Skip .git directory
					if (entry.name === '.git') continue;
					// Skip node_modules
					if (entry.name === 'node_modules') continue;

					const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
					const fullPath = `${dir}/${entry.name}`;

					// Skip files/directories matching ignore patterns
					if (this.isIgnored(relativePath)) continue;

					if (entry.isDirectory()) {
						results.push({ path: relativePath, isDirectory: true, size: 0 });
						walk(fullPath, relativePath);
					} else {
						try {
							const stat = fs.statSync(fullPath);
							results.push({ path: relativePath, isDirectory: false, size: stat.size });
						} catch {
							results.push({ path: relativePath, isDirectory: false, size: 0 });
						}
					}
				}
			} catch (error) {
				// Directory not readable
			}
		};

		walk(repoDir, '');
		return results;
	}

	/**
	 * Get the absolute directory path of the repository
	 */
	getRepoDir(): string {
		return this.config.dir;
	}

	/**
	 * Stage files
	 */
	async add(filepaths: string[]): Promise<void> {
		try {
			for (const filepath of filepaths) {
				await git.add({
					fs: this.fs,
					dir: this.config.dir,
					filepath,
				});
			}
		} catch (error) {
			this.handleError('Failed to stage files', error);
			throw error;
		}
	}

	/**
	 * Stage deleted files for removal
	 */
	async remove(filepaths: string[]): Promise<void> {
		try {
			for (const filepath of filepaths) {
				await git.remove({
					fs: this.fs,
					dir: this.config.dir,
					filepath,
				});
			}
		} catch (error) {
			this.handleError('Failed to stage file removal', error);
			throw error;
		}
	}

	/**
	 * Unstage files
	 */
	async reset(filepaths: string[]): Promise<void> {
		try {
			for (const filepath of filepaths) {
				await git.resetIndex({
					fs: this.fs,
					dir: this.config.dir,
					filepath,
				});
			}
		} catch (error) {
			this.handleError('Failed to unstage files', error);
			throw error;
		}
	}

	/**
	 * Write a raw blob to the object store and return its OID. Used by
	 * the commit transform pipeline to splice rewritten content into the
	 * index without touching the working tree.
	 */
	async writeBlob(content: Uint8Array): Promise<string> {
		return git.writeBlob({
			fs: this.fs,
			dir: this.config.dir,
			blob: content,
		});
	}

	/**
	 * Update a single index entry to point at the given blob OID. The
	 * file does NOT need to exist on disk — this is the whole point: we
	 * can stage a transformed version of a file while the user's working
	 * copy keeps the original Obsidian-flavored content.
	 *
	 * Pass `add: true` for paths that don't yet exist in the index
	 * (e.g. newly copied assets).
	 */
	async updateIndexBlob(filepath: string, oid: string, add: boolean): Promise<void> {
		await (git as any).updateIndex({
			fs: this.fs,
			dir: this.config.dir,
			filepath,
			oid,
			add,
		});
	}

	/**
	 * Apply a snapshot of overrides to the index. For each entry, the
	 * raw bytes are written as a blob and the index is updated to point
	 * at it. Returns the list of paths that were touched (for logging).
	 */
	async applyIndexOverrides(snapshot: IndexOverrideSnapshot): Promise<ApplyOverridesResult> {
		const touched: string[] = [];
		const workdirOids: Record<string, string> = {};
		for (const [path, bytes] of snapshot.files) {
			// Capture the workdir blob OID *before* we write the override.
			// This is what we'll persist so the next statusMatrix call can
			// recognize "workdir unchanged since last transformed commit".
			const wdBytes = this.readWorkdirBytes(path);
			if (wdBytes) {
				try {
					const { oid } = await git.hashBlob({ object: wdBytes });
					workdirOids[path] = oid;
				} catch {
					/* ignore — best-effort */
				}
			}
			const oid = await this.writeBlob(bytes);
			await this.updateIndexBlob(path, oid, false);
			touched.push(path);
		}
		return { touched, workdirOids };
	}

	/**
	 * Commit staged changes.
	 *
	 * If `transformHook` is provided it is invoked with the list of
	 * currently-staged paths after staging is complete; the hook returns
	 * an override snapshot which is spliced into the index just before
	 * the actual commit. This is how the GitLab Pages compatibility
	 * pipeline rewrites markdown without modifying the user's vault.
	 */
	async commit(
		message: string,
		author?: { name: string; email: string },
		transformHook?: CommitTransformHook,
	): Promise<CommitResult> {
		try {
			const authorInfo = author || this.config.author;
			let transformedWorkdirOids: Record<string, string> | undefined;

			if (transformHook) {
				const stagedPaths = (await this.statusMatrix()).filter((f) => f.staged).map((f) => f.path);
				const snapshot = await transformHook(stagedPaths);
				// Stage any assets the pipeline materialised on disk so they
				// land in the index just like normal files (no virtual blobs).
				if (snapshot.addedAssetPaths && snapshot.addedAssetPaths.length > 0) {
					await this.add(snapshot.addedAssetPaths);
					DebugLogger.log('GitOps', 'Staged transform-added assets', {
						count: snapshot.addedAssetPaths.length,
					});
				}
				if (snapshot.files.size > 0) {
					const result = await this.applyIndexOverrides(snapshot);
					DebugLogger.log('GitOps', 'Applied commit transform overrides', { count: result.touched.length });
					if (Object.keys(result.workdirOids).length > 0) {
						transformedWorkdirOids = result.workdirOids;
					}
				}
			}

			const sha = await git.commit({
				fs: this.fs,
				dir: this.config.dir,
				message,
				author: authorInfo,
			});

			// Update the in-memory snapshot immediately so the next
			// statusMatrix call (typically right after the commit, during
			// repo refresh) already suppresses the transformed files.
			if (transformedWorkdirOids) {
				Object.assign(this.pagesCompatSnapshot, transformedWorkdirOids);
			}

			return { sha, transformedWorkdirOids };
		} catch (error) {
			this.handleError('Failed to commit changes', error);
			throw error;
		}
	}

	/**
	 * Amend the last commit with currently staged changes and/or a new message
	 */
	async amendCommit(
		message: string,
		author?: { name: string; email: string },
		transformHook?: CommitTransformHook,
	): Promise<CommitResult> {
		try {
			const authorInfo = author || this.config.author;
			let transformedWorkdirOids: Record<string, string> | undefined;

			if (transformHook) {
				const stagedPaths = (await this.statusMatrix()).filter((f) => f.staged).map((f) => f.path);
				const snapshot = await transformHook(stagedPaths);
				if (snapshot.addedAssetPaths && snapshot.addedAssetPaths.length > 0) {
					await this.add(snapshot.addedAssetPaths);
					DebugLogger.log('GitOps', 'Staged transform-added assets (amend)', {
						count: snapshot.addedAssetPaths.length,
					});
				}
				if (snapshot.files.size > 0) {
					const result = await this.applyIndexOverrides(snapshot);
					DebugLogger.log('GitOps', 'Applied amend transform overrides', { count: result.touched.length });
					if (Object.keys(result.workdirOids).length > 0) {
						transformedWorkdirOids = result.workdirOids;
					}
				}
			}

			// Get the HEAD commit and its parent
			const [headCommit] = await git.log({
				fs: this.fs,
				dir: this.config.dir,
				depth: 1,
			});

			if (!headCommit) {
				throw new Error('No commits to amend');
			}

			const parentShas = headCommit.commit.parent;

			// Get current branch name to update its ref
			const branch = await this.getCurrentBranch();

			// Reset the branch ref to the parent commit (or remove if initial commit)
			if (parentShas.length > 0) {
				await git.writeRef({
					fs: this.fs,
					dir: this.config.dir,
					ref: `refs/heads/${branch}`,
					value: parentShas[0],
					force: true,
				});
			}

			// Now commit — this creates a new commit on top of the parent,
			// effectively replacing the old HEAD
			const sha = await git.commit({
				fs: this.fs,
				dir: this.config.dir,
				message,
				author: authorInfo,
			});

			DebugLogger.log('GitOps', 'Amended commit', { oldSha: headCommit.oid, newSha: sha });

			if (transformedWorkdirOids) {
				Object.assign(this.pagesCompatSnapshot, transformedWorkdirOids);
			}

			return { sha, transformedWorkdirOids };
		} catch (error) {
			this.handleError('Failed to amend commit', error);
			throw error;
		}
	}

	/**
	 * Revert a commit by creating a new commit that undoes its changes
	 */
	async revertCommit(sha: string, author?: { name: string; email: string }): Promise<string> {
		try {
			const authorInfo = author || this.config.author;

			// Read the commit to revert
			const commitResult = await git.readCommit({
				fs: this.fs,
				dir: this.config.dir,
				oid: sha,
			});

			const commitObj = commitResult.commit;
			if (commitObj.parent.length === 0) {
				throw new Error('Cannot revert the initial commit');
			}

			const parentSha = commitObj.parent[0];

			// Walk both trees to find differences
			const changes: Array<{ path: string; action: 'added' | 'deleted' | 'modified' }> = [];

			await git.walk({
				fs: this.fs,
				dir: this.config.dir,
				trees: [git.TREE({ ref: sha }), git.TREE({ ref: parentSha })],
				map: async (filepath, [commitEntry, parentEntry]) => {
					if (filepath === '.') return;

					const commitOid = commitEntry ? await commitEntry.oid() : null;
					const parentOid = parentEntry ? await parentEntry.oid() : null;
					const commitType = commitEntry ? await commitEntry.type() : null;
					const parentType = parentEntry ? await parentEntry.type() : null;

					// Skip directories
					if (commitType === 'tree' || parentType === 'tree') return;

					if (commitOid !== parentOid) {
						if (commitOid && !parentOid) {
							// File was added in the commit → delete it to revert
							changes.push({ path: filepath, action: 'added' });
						} else if (!commitOid && parentOid) {
							// File was deleted in the commit → restore it to revert
							changes.push({ path: filepath, action: 'deleted' });
						} else {
							// File was modified → restore parent version
							changes.push({ path: filepath, action: 'modified' });
						}
					}
				},
			});

			// Apply the inverse changes
			const path = require('path');
			for (const change of changes) {
				const fullPath = path.join(this.config.dir, change.path);

				if (change.action === 'added') {
					// File was added in the commit, so delete it
					if (fs.existsSync(fullPath)) {
						fs.unlinkSync(fullPath);
					}
					await git.remove({
						fs: this.fs,
						dir: this.config.dir,
						filepath: change.path,
					});
				} else {
					// File was deleted or modified — restore parent version
					const { blob } = await git.readBlob({
						fs: this.fs,
						dir: this.config.dir,
						oid: parentSha,
						filepath: change.path,
					});
					const dir = path.dirname(fullPath);
					if (!fs.existsSync(dir)) {
						fs.mkdirSync(dir, { recursive: true });
					}
					fs.writeFileSync(fullPath, Buffer.from(blob));
					await git.add({
						fs: this.fs,
						dir: this.config.dir,
						filepath: change.path,
					});
				}
			}

			// Create the revert commit
			const originalMessage = commitObj.message.split('\n')[0];
			const revertMessage = `Revert "${originalMessage}"\n\nThis reverts commit ${sha}.`;
			const revertSha = await git.commit({
				fs: this.fs,
				dir: this.config.dir,
				message: revertMessage,
				author: authorInfo,
			});

			DebugLogger.log('GitOps', 'Reverted commit', { revertedSha: sha, newSha: revertSha });
			return revertSha;
		} catch (error) {
			this.handleError('Failed to revert commit', error);
			throw error;
		}
	}

	/**
	 * Pull changes from remote
	 */
	async pull(remote: string, branch: string, token: string): Promise<void> {
		try {
			DebugLogger.log('GitOps', 'Starting pull', { remote, branch, dir: this.config.dir });
			DebugLogger.log('GitOps', 'Token check', { 
				tokenLength: token?.length || 0, 
				tokenPrefix: token ? token.substring(0, 6) + '...' : 'EMPTY',
				tokenType: typeof token
			});
			
			// First, make sure we have the remote configured
			const remotes = await git.listRemotes({ fs: this.fs, dir: this.config.dir });
			DebugLogger.log('GitOps', 'Existing remotes', remotes);
			
			if (!remotes.find(r => r.remote === remote)) {
				DebugLogger.warn('GitOps', `Remote '${remote}' not found in repository`);
				throw new Error(`Remote '${remote}' is not configured. Please ensure the repository was cloned or has a remote set up.`);
			}
			
			// Configure SSL if needed
			if (this.config.disableSslVerification) {
				DebugLogger.warn('GitOps', 'SSL verification disabled for pull');
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
			}
			
			// Try multiple authentication formats for GitLab
			let authAttempt = 0;
			const authFormats = [
				{ username: token, password: '', label: 'token as username' },
				{ username: 'oauth2', password: token, label: 'oauth2 format' },
				{ username: 'gitlab-ci-token', password: token, label: 'CI token format' },
			];
			
			let lastError: any = null;
			
			for (const authFormat of authFormats) {
				try {
					authAttempt++;
					DebugLogger.log('GitOps', `Pull attempt ${authAttempt} with ${authFormat.label}`);
					
					const enhancedHttp = createEnhancedHttp(token, authFormat);
					
					await git.pull({
						fs: this.fs,
						http: enhancedHttp,
						dir: this.config.dir,
						ref: branch,
						singleBranch: true,
						author: this.config.author,
						onAuth: () => {
							DebugLogger.log('GitOps', `Auth callback: using ${authFormat.label}`);
							return { 
								username: authFormat.username, 
								password: authFormat.password 
							};
						},
					});
					
					// If we get here, pull succeeded
					DebugLogger.log('GitOps', `Pull succeeded with ${authFormat.label}`);
					
					if (this.config.disableSslVerification) {
						process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
					}
					
					return; // Success!
					
				} catch (error: any) {
					lastError = error;
					if (error?.data?.statusCode === 401) {
						DebugLogger.warn('GitOps', `Auth format '${authFormat.label}' failed with 401, trying next...`);
						continue; // Try next auth format
					} else {
						// Non-auth error, don't try other formats
						throw error;
					}
				}
			}
			
			// All auth formats failed
			throw lastError || new Error('All authentication formats failed');
			
		} catch (error: any) {
			if (this.config.disableSslVerification) {
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
			}
			DebugLogger.error('GitOps', 'Pull failed', error);
			// Translate isomorphic-git's cryptic "Could not find <branch>" into something
			// actionable: this happens when the upstream branch has been deleted (e.g.
			// after the MR was merged and the source branch removed on GitLab).
			const msg = error?.message || String(error);
			if (/Could not find\s+\S+/i.test(msg)) {
				const friendly = new Error(
					`Branch "${branch}" no longer exists on ${remote} — it was likely merged and deleted. Switch to another branch (e.g. main) and delete this local branch.`
				);
				this.handleError('Failed to pull changes', friendly);
				throw friendly;
			}
			this.handleError('Failed to pull changes', error);
			throw error;
		}
	}

	/**
	 * Check if `branch` is fully merged into `target` (i.e. branch tip is an
	 * ancestor of target's tip). Used to determine whether it's safe to discard
	 * a local branch whose remote has been deleted.
	 */
	async isBranchMergedInto(branch: string, target: string): Promise<boolean> {
		try {
			const branchOid = await git.resolveRef({ fs: this.fs, dir: this.config.dir, ref: branch });
			const targetOid = await git.resolveRef({ fs: this.fs, dir: this.config.dir, ref: target });
			if (branchOid === targetOid) return true;
			const bases = await git.findMergeBase({
				fs: this.fs,
				dir: this.config.dir,
				oids: [branchOid, targetOid],
			});
			return Array.isArray(bases) && bases.includes(branchOid);
		} catch (e) {
			DebugLogger.warn('GitOps', 'isBranchMergedInto failed', e);
			return false;
		}
	}

	/**
	 * Push changes to remote
	 */
	async push(remote: string, branch: string, token: string): Promise<void> {
		try {
			DebugLogger.log('GitOps', 'Starting push', { remote, branch, dir: this.config.dir });
			
			if (this.config.disableSslVerification) {
				DebugLogger.warn('GitOps', 'SSL verification disabled for push');
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
			}
			
			// Try multiple authentication formats
			const authFormats = [
				{ username: token, password: '', label: 'token as username' },
				{ username: 'oauth2', password: token, label: 'oauth2 format' },
			];
			
			let lastError: any = null;
			let authAttempt = 0;
			
			for (const authFormat of authFormats) {
				try {
					authAttempt++;
					DebugLogger.log('GitOps', `Push attempt ${authAttempt} with ${authFormat.label}`);
					
					const enhancedHttp = createEnhancedHttp(token, authFormat);
					
					await git.push({
						fs: this.fs,
						http: enhancedHttp,
						dir: this.config.dir,
						ref: branch,
						remoteRef: branch,
						onAuth: () => {
							DebugLogger.log('GitOps', `Push auth: using ${authFormat.label}`);
							return { 
								username: authFormat.username, 
								password: authFormat.password 
							};
						},
					});
					
					DebugLogger.log('GitOps', `Push succeeded with ${authFormat.label}`);
					
					if (this.config.disableSslVerification) {
						process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
					}
					
					return;
					
				} catch (error: any) {
					lastError = error;
					if (error?.data?.statusCode === 401) {
						DebugLogger.warn('GitOps', `Push auth format '${authFormat.label}' failed, trying next...`);
						continue;
					} else {
						throw error;
					}
				}
			}
			
			throw lastError || new Error('All authentication formats failed');
			
		} catch (error) {
			if (this.config.disableSslVerification) {
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
			}
			DebugLogger.error('GitOps', 'Push failed', error);
			this.handleError('Failed to push changes', error);
			throw error;
		}
	}

	/**
	 * Fetch from remote
	 */
	async fetch(remote: string, token: string): Promise<void> {
		try {
			DebugLogger.log('GitOps', 'Starting fetch', { remote, dir: this.config.dir });
			
			if (this.config.disableSslVerification) {
				DebugLogger.warn('GitOps', 'SSL verification disabled for fetch');
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
			}
			
			// Try multiple authentication formats
			const authFormats = [
				{ username: token, password: '', label: 'token as username' },
				{ username: 'oauth2', password: token, label: 'oauth2 format' },
			];
			
			let lastError: any = null;
			let authAttempt = 0;
			
			for (const authFormat of authFormats) {
				try {
					authAttempt++;
					DebugLogger.log('GitOps', `Fetch attempt ${authAttempt} with ${authFormat.label}`);
					
					const enhancedHttp = createEnhancedHttp(token, authFormat);
					
					await git.fetch({
						fs: this.fs,
						http: enhancedHttp,
						dir: this.config.dir,
						remote,
						prune: true,
						onAuth: () => {
							DebugLogger.log('GitOps', `Fetch auth: using ${authFormat.label}`);
							return { 
								username: authFormat.username, 
								password: authFormat.password 
							};
						},
					});
					
					DebugLogger.log('GitOps', `Fetch succeeded with ${authFormat.label}`);
					
					if (this.config.disableSslVerification) {
						process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
					}
					
					return;
					
				} catch (error: any) {
					lastError = error;
					if (error?.data?.statusCode === 401) {
						DebugLogger.warn('GitOps', `Fetch auth format '${authFormat.label}' failed, trying next...`);
						continue;
					} else {
						throw error;
					}
				}
			}
			
			throw lastError || new Error('All authentication formats failed');
			
		} catch (error) {
			if (this.config.disableSslVerification) {
				process.env.NODE_TLS_REJECT_UNAUTHORIZED = '1';
			}
			DebugLogger.error('GitOps', 'Fetch failed', error);
			this.handleError('Failed to fetch from remote', error);
			throw error;
		}
	}

	/**
	 * Get commit log
	 */
	async log(ref?: string, depth = 20): Promise<GitCommit[]> {
		try {
			const commits = await git.log({
				fs: this.fs,
				dir: this.config.dir,
				ref,
				depth,
			});

			return commits.map(commit => ({
				sha: commit.oid,
				message: commit.commit.message,
				authorName: commit.commit.author.name,
				authorEmail: commit.commit.author.email,
				timestamp: commit.commit.author.timestamp * 1000,
				parents: commit.commit.parent,
			}));
		} catch (error) {
			this.handleError('Failed to get commit log', error);
			throw error;
		}
	}

	/**
	 * Get commit log from all branches combined and deduplicated
	 */
	async getAllBranchLogs(depth = 100): Promise<{ commits: GitCommit[]; branchHeads: Map<string, string> }> {
		try {
			const branches = await this.listBranches();
			const branchHeads = new Map<string, string>();
			const commitMap = new Map<string, GitCommit>();

			for (const branch of branches) {
				if (branch.commitSha) {
					branchHeads.set(branch.name, branch.commitSha);
				}
				try {
					const commits = await git.log({
						fs: this.fs,
						dir: this.config.dir,
						ref: branch.name,
						depth,
					});
					for (const c of commits) {
						if (!commitMap.has(c.oid)) {
							commitMap.set(c.oid, {
								sha: c.oid,
								message: c.commit.message,
								authorName: c.commit.author.name,
								authorEmail: c.commit.author.email,
								timestamp: c.commit.author.timestamp * 1000,
								parents: c.commit.parent,
							});
						}
					}
				} catch { /* branch may not have commits */ }
			}

			// Also try remote branches
			try {
				const remoteBranches = await git.listBranches({
					fs: this.fs,
					dir: this.config.dir,
					remote: 'origin',
				});
				for (const rb of remoteBranches) {
					try {
						const oid = await git.resolveRef({
							fs: this.fs,
							dir: this.config.dir,
							ref: `refs/remotes/origin/${rb}`,
						});
						branchHeads.set(`origin/${rb}`, oid);
					} catch { /* ignore */ }
				}
			} catch { /* no remote branches */ }

			const commits = Array.from(commitMap.values());
			commits.sort((a, b) => b.timestamp - a.timestamp);
			return { commits, branchHeads };
		} catch (error) {
			this.handleError('Failed to get full log', error);
			throw error;
		}
	}

	/**
	 * Merge a branch
	 */
	async merge(theirBranch: string): Promise<void> {
		try {
			await git.merge({
				fs: this.fs,
				dir: this.config.dir,
				ours: await this.getCurrentBranch(),
				theirs: theirBranch,
				author: this.config.author,
			});
		} catch (error) {
			this.handleError('Failed to merge branch', error);
			throw error;
		}
	}

	/**
	 * Get sync status (ahead/behind)
	 */
	async getSyncStatus(remote: string, branch: string): Promise<SyncStatus> {
		try {
			const localRef = `refs/heads/${branch}`;
			const remoteRef = `refs/remotes/${remote}/${branch}`;

			const localOid = await git.resolveRef({
				fs: this.fs,
				dir: this.config.dir,
				ref: localRef,
			});

			let remoteOid: string;
			try {
				remoteOid = await git.resolveRef({
					fs: this.fs,
					dir: this.config.dir,
					ref: remoteRef,
				});
			} catch (e) {
				// Remote branch doesn't exist yet — count only commits unique to this branch
				let ahead = 0;
				try {
					// Find a remote ref to compare against (prefer origin/main, then any remote branch)
					const remoteBranches = await git.listBranches({ fs: this.fs, dir: this.config.dir, remote: 'origin' });
					let compareRef: string | null = null;
					for (const candidate of ['main', 'master', 'develop']) {
						if (remoteBranches.includes(candidate)) {
							compareRef = `refs/remotes/origin/${candidate}`;
							break;
						}
					}
					if (!compareRef && remoteBranches.length > 0) {
						compareRef = `refs/remotes/origin/${remoteBranches[0]}`;
					}

					if (compareRef) {
						const compareOid = await git.resolveRef({ fs: this.fs, dir: this.config.dir, ref: compareRef });
						const localCommits = await git.log({ fs: this.fs, dir: this.config.dir, ref: localOid, depth: 50 });
						const parentCommits = await git.log({ fs: this.fs, dir: this.config.dir, ref: compareOid, depth: 50 });
						const parentShas = new Set(parentCommits.map(c => c.oid));
						ahead = localCommits.filter(c => !parentShas.has(c.oid)).length;
					} else {
						// No remote branches at all — count all local commits
						const localCommits = await git.log({ fs: this.fs, dir: this.config.dir, ref: localOid, depth: 50 });
						ahead = localCommits.length;
					}
				} catch {
					ahead = 1; // Safe fallback: at least 1 to enable push
				}

				const files = await this.statusMatrix();
				return {
					ahead,
					behind: 0,
					remoteBranchMissing: true,
					hasUncommittedChanges: files.some(f => f.staged),
					hasUntrackedFiles: files.some(f => f.status === FileStatus.UNTRACKED),
				};
			}

			// Count commits ahead/behind
			let ahead = 0;
			let behind = 0;

			const localCommits = await git.log({
				fs: this.fs,
				dir: this.config.dir,
				ref: localOid,
			});

			const remoteCommits = await git.log({
				fs: this.fs,
				dir: this.config.dir,
				ref: remoteOid,
			});

			// Simple comparison (not perfect but good enough)
			const localShas = new Set(localCommits.map(c => c.oid));
			const remoteShas = new Set(remoteCommits.map(c => c.oid));

			ahead = localCommits.filter(c => !remoteShas.has(c.oid)).length;
			behind = remoteCommits.filter(c => !localShas.has(c.oid)).length;

			// Check for uncommitted changes
			const files = await this.statusMatrix();
			const hasUncommittedChanges = files.some(f => f.staged);
			const hasUntrackedFiles = files.some(f => f.status === FileStatus.UNTRACKED);

			return {
				ahead,
				behind,
				hasUncommittedChanges,
				hasUntrackedFiles,
			};
		} catch (error) {
			console.error('Failed to get sync status:', error);
			return {
				ahead: 0,
				behind: 0,
				hasUncommittedChanges: false,
				hasUntrackedFiles: false,
			};
		}
	}

	/**
	 * Get file content at a specific commit (HEAD by default)
	 */
	async getFileAtCommit(filepath: string, ref: string = 'HEAD'): Promise<string | null> {
		try {
			const oid = await git.resolveRef({ fs: this.fs, dir: this.config.dir, ref });
			const { blob } = await git.readBlob({
				fs: this.fs,
				dir: this.config.dir,
				oid,
				filepath,
			});
			return new TextDecoder().decode(blob);
		} catch (error) {
			// File doesn't exist at this ref
			return null;
		}
	}

	/**
	 * Get working copy content for a file
	 */
	async getWorkingCopyContent(filepath: string): Promise<string | null> {
		try {
			const fullPath = require('path').join(this.config.dir, filepath);
			return this.fs.readFileSync(fullPath, { encoding: 'utf8' }) as string;
		} catch {
			return null;
		}
	}

	/**
	 * Get commit history for a specific file
	 */
	async getFileHistory(filepath: string, depth: number = 50): Promise<GitCommit[]> {
		try {
			const commits = await git.log({
				fs: this.fs,
				dir: this.config.dir,
				ref: 'HEAD',
				depth,
				filepath,
				follow: true,
				force: true,
			});

			return commits.map(commit => ({
				sha: commit.oid,
				message: commit.commit.message,
				authorName: commit.commit.author.name,
				authorEmail: commit.commit.author.email,
				timestamp: commit.commit.author.timestamp * 1000,
				parents: commit.commit.parent,
			}));
		} catch (error) {
			this.handleError('Failed to get file history', error);
			return [];
		}
	}

	/**
	 * Simplified blame: walks file history and attributes line ranges to commits.
	 * Returns blame entries mapping line ranges to their most recent changing commit.
	 */
	async getFileBlame(filepath: string): Promise<Array<{
		startLine: number;
		endLine: number;
		commit: GitCommit;
	}>> {
		try {
			const history = await this.getFileHistory(filepath, 100);
			if (history.length === 0) return [];

			const currentContent = await this.getWorkingCopyContent(filepath);
			if (!currentContent) return [];

			const currentLines = currentContent.split('\n');
			
			// Track which lines have been attributed
			const lineAttribution: Array<GitCommit | null> = new Array(currentLines.length).fill(null);
			
			let prevContent = currentContent;
			
			for (let i = 0; i < history.length; i++) {
				const commit = history[i];
				const commitContent = await this.getFileAtCommit(filepath, commit.sha);
				
				if (i === history.length - 1) {
					// Last commit — attribute all remaining unattributed lines
					for (let line = 0; line < lineAttribution.length; line++) {
						if (lineAttribution[line] === null) {
							lineAttribution[line] = commit;
						}
					}
					break;
				}
				
				if (commitContent === null) {
					// File was added in the previous commit
					const prevCommit = i > 0 ? history[i - 1] : history[0];
					for (let line = 0; line < lineAttribution.length; line++) {
						if (lineAttribution[line] === null) {
							lineAttribution[line] = prevCommit;
						}
					}
					break;
				}
				
				// Compare previous content with this commit's content to find changed lines
				if (i > 0 && commitContent !== prevContent) {
					const prevLines = prevContent.split('\n');
					const commitLines = commitContent.split('\n');
					
					// Simple diff: find lines in prevContent not in commitContent
					// Those were introduced by the commit at history[i-1]
					const prevCommit = history[i - 1];
					
					// Use a basic LCS-based approach to find which current lines correspond to changes
					const prevSet = new Set(commitLines);
					for (let line = 0; line < currentLines.length; line++) {
						if (lineAttribution[line] === null && !prevSet.has(currentLines[line])) {
							// This line might have been changed
							lineAttribution[line] = prevCommit;
						}
					}
				}
				
				prevContent = commitContent ?? prevContent;
			}
			
			// Collapse consecutive lines with same commit into ranges
			const result: Array<{ startLine: number; endLine: number; commit: GitCommit }> = [];
			let rangeStart = 0;
			let rangeCommit = lineAttribution[0] || history[0];
			
			for (let i = 1; i <= lineAttribution.length; i++) {
				const currentCommit = i < lineAttribution.length ? (lineAttribution[i] || history[0]) : null;
				if (!currentCommit || currentCommit.sha !== rangeCommit.sha) {
					result.push({
						startLine: rangeStart + 1,
						endLine: i,
						commit: rangeCommit,
					});
					if (currentCommit) {
						rangeStart = i;
						rangeCommit = currentCommit;
					}
				}
			}
			
			return result;
		} catch (error) {
			this.handleError('Failed to get file blame', error);
			return [];
		}
	}

	// ===== Tag Operations =====

	/**
	 * List all tags
	 */
	async listTags(): Promise<GitTag[]> {
		try {
			const tagNames = await git.listTags({ fs: this.fs, dir: this.config.dir });
			const tags: GitTag[] = [];

			for (const name of tagNames) {
				try {
					const oid = await git.resolveRef({ fs: this.fs, dir: this.config.dir, ref: `refs/tags/${name}` });
					let message: string | undefined;
					let tagger: string | undefined;
					let timestamp: number | undefined;

					// Try to read as annotated tag
					try {
						const tagObj = await git.readTag({ fs: this.fs, dir: this.config.dir, oid });
						message = tagObj.tag.message;
						tagger = tagObj.tag.tagger?.name;
						timestamp = tagObj.tag.tagger?.timestamp ? tagObj.tag.tagger.timestamp * 1000 : undefined;
					} catch {
						// Lightweight tag — no extra info
					}

					tags.push({ name, oid, message, tagger, timestamp });
				} catch {
					tags.push({ name, oid: '' });
				}
			}

			return tags;
		} catch (error) {
			this.handleError('Failed to list tags', error);
			return [];
		}
	}

	/**
	 * Create a tag (lightweight or annotated)
	 */
	async createTag(name: string, options?: { message?: string; oid?: string }): Promise<void> {
		try {
			if (options?.message) {
				await git.annotatedTag({
					fs: this.fs,
					dir: this.config.dir,
					ref: name,
					message: options.message,
					object: options?.oid,
					tagger: this.config.author,
				});
			} else {
				await git.tag({
					fs: this.fs,
					dir: this.config.dir,
					ref: name,
					object: options?.oid,
				});
			}
			DebugLogger.log('GitOps', `Tag created: ${name}`);
		} catch (error) {
			this.handleError('Failed to create tag', error);
			throw error;
		}
	}

	/**
	 * Delete a tag
	 */
	async deleteTag(name: string): Promise<void> {
		try {
			await git.deleteTag({ fs: this.fs, dir: this.config.dir, ref: name });
			DebugLogger.log('GitOps', `Tag deleted: ${name}`);
		} catch (error) {
			this.handleError('Failed to delete tag', error);
			throw error;
		}
	}

	/**
	 * Push a tag to remote
	 */
	async pushTag(tagName: string, token: string): Promise<void> {
		const originalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		if (this.config.disableSslVerification) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		}

		try {
			const enhancedHttp = createEnhancedHttp(token, { username: 'oauth2', password: token });
			await git.push({
				fs: this.fs,
				http: enhancedHttp,
				dir: this.config.dir,
				remote: 'origin',
				ref: `refs/tags/${tagName}`,
				onAuth: () => ({ username: 'oauth2', password: token }),
			});
			DebugLogger.log('GitOps', `Tag pushed: ${tagName}`);
		} catch (error) {
			this.handleError('Failed to push tag', error);
			throw error;
		} finally {
			if (this.config.disableSslVerification) {
				if (originalTls !== undefined) {
					process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTls;
				} else {
					delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
				}
			}
		}
	}

	// ===== Stash Operations =====

	/**
	 * Stash current changes
	 */
	async stashPush(message?: string): Promise<void> {
		try {
			await (git as any).stash({
				fs: this.fs,
				dir: this.config.dir,
				op: 'push',
				message,
			});
			DebugLogger.log('GitOps', `Stash pushed${message ? `: ${message}` : ''}`);
		} catch (error) {
			this.handleError('Failed to stash changes', error);
			throw error;
		}
	}

	/**
	 * Pop top stash entry (apply + remove)
	 */
	async stashPop(index?: number): Promise<void> {
		try {
			await (git as any).stash({
				fs: this.fs,
				dir: this.config.dir,
				op: 'pop',
				refIdx: index,
			});
			DebugLogger.log('GitOps', `Stash popped${index !== undefined ? ` (index ${index})` : ''}`);
		} catch (error) {
			this.handleError('Failed to pop stash', error);
			throw error;
		}
	}

	/**
	 * Apply a stash entry without removing it
	 */
	async stashApply(index?: number): Promise<void> {
		try {
			await (git as any).stash({
				fs: this.fs,
				dir: this.config.dir,
				op: 'apply',
				refIdx: index,
			});
			DebugLogger.log('GitOps', `Stash applied${index !== undefined ? ` (index ${index})` : ''}`);
		} catch (error) {
			this.handleError('Failed to apply stash', error);
			throw error;
		}
	}

	/**
	 * List stash entries
	 */
	async stashList(): Promise<StashEntry[]> {
		try {
			const result = await (git as any).stash({
				fs: this.fs,
				dir: this.config.dir,
				op: 'list',
			});
			
			// Parse stash list result
			if (Array.isArray(result)) {
				return result.map((entry: any, index: number) => ({
					index,
					message: typeof entry === 'string' ? entry : (entry?.message || `stash@{${index}}`),
					oid: typeof entry === 'object' ? (entry?.oid || '') : '',
				}));
			}
			
			return [];
		} catch (error) {
			// No stashes is not an error
			DebugLogger.log('GitOps', 'No stash entries found');
			return [];
		}
	}

	/**
	 * Drop a specific stash entry
	 */
	async stashDrop(index: number): Promise<void> {
		try {
			await (git as any).stash({
				fs: this.fs,
				dir: this.config.dir,
				op: 'drop',
				refIdx: index,
			});
			DebugLogger.log('GitOps', `Stash dropped: index ${index}`);
		} catch (error) {
			this.handleError('Failed to drop stash', error);
			throw error;
		}
	}

	/**
	 * Clear all stash entries
	 */
	async stashClear(): Promise<void> {
		try {
			await (git as any).stash({
				fs: this.fs,
				dir: this.config.dir,
				op: 'clear',
			});
			DebugLogger.log('GitOps', 'Stash cleared');
		} catch (error) {
			this.handleError('Failed to clear stash', error);
			throw error;
		}
	}

	/**
	 * Handle errors
	 */
	private handleError(context: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		const errorObj = error instanceof Error ? error : new Error(String(error));
		
		DebugLogger.error('GitOps', context, {
			message,
			stack: errorObj.stack,
			error: errorObj
		});
		
		console.error(`${context}:`, error);
		new Notice(`${context}: ${message}`);
	}
}
