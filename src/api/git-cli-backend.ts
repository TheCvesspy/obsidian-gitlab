/**
 * Git CLI backend — implements IGitBackend by shelling out to `git`.
 *
 * Requires Git >= 2.25 (for sparse-checkout) on the user's PATH.
 * Auth is handled by embedding the PAT in the remote URL for each
 * network command; SSL bypass uses the GIT_SSL_NO_VERIFY env var.
 */

import * as fs from 'fs';
import * as path from 'path';
import { Notice } from 'obsidian';
import { GitFile, FileStatus, GitCommit, GitBranch, SyncStatus, GitTag, StashEntry, StashPushOptions, StashFileChange } from '../types';
import type {
	IGitBackend,
	GitBackendConfig,
	IndexOverrideSnapshot,
	CommitTransformHook,
	ApplyOverridesResult,
	CommitResult,
} from './git-backend';
import { GitCliExecutor, GitCliError } from './git-cli-executor';
import { parseStatusV2 } from './git-status-parser';
import { DebugLogger } from '../utils/debug-logger';

// Build the contents of `.git/info/sparse-checkout` for strict cone-mode
// with the given directory list. Root files are NOT auto-included (we
// intentionally drop the leading-slash glob patterns that standard cone
// mode uses) — this matches the documentation-focused use case where the
// user wants ONLY the selected folders visible.
//
// Note: the sparse-checkout file is largely documentary in our
// implementation — actual cone application is done via the manual
// update-index walk in sparseCheckoutSet(). The file is still written so
// `git sparse-checkout list` and other tooling report the right values.
function buildConePatterns(paths: string[]): string[] {
	const lines: string[] = [];
	const seen = new Set<string>();
	const cleaned = paths
		.map(p => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
		.filter(p => p.length > 0);

	for (const fullPath of cleaned) {
		const parts = fullPath.split('/').filter(p => p.length > 0);
		let acc = '';
		for (let i = 0; i < parts.length; i++) {
			acc += '/' + parts[i];
			const isLeaf = i === parts.length - 1;
			const include = acc + '/';
			if (!seen.has(include)) {
				seen.add(include);
				lines.push(include);
				if (!isLeaf) {
					lines.push('!' + acc + '/*/');
				}
			}
		}
	}
	return lines;
}

/**
 * Strict cone-mode inclusion test for a tracked file path. A file is included
 * only if it equals one of the included paths exactly, or lives under one of
 * them. Root-level files are NOT auto-included — this differs from Git's
 * default cone mode (which includes root files via `/*`), and matches what
 * documentation-focused users typically want: only the selected folders.
 */
function matchesCone(filePath: string, includedPaths: string[]): boolean {
	const f = filePath.replace(/\\/g, '/');
	for (const p of includedPaths) {
		if (f === p) return true;
		if (f.startsWith(p + '/')) return true;
	}
	return false;
}

function matchesIgnorePattern(filePath: string, patterns: string[]): boolean {
	const normalized = filePath.replace(/\\/g, '/');
	for (const pattern of patterns) {
		if (globMatch(normalized, pattern)) return true;
		const parts = normalized.split('/');
		for (let i = 1; i <= parts.length; i++) {
			const partial = parts.slice(0, i).join('/');
			if (pattern.endsWith('/') && globMatch(partial, pattern.slice(0, -1))) return true;
			if (globMatch(partial, pattern)) return true;
		}
	}
	return false;
}

function globMatch(text: string, pattern: string): boolean {
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

export class GitCliBackend implements IGitBackend {
	private config: GitBackendConfig;
	private cli: GitCliExecutor;
	private pagesCompatSnapshot: Record<string, string> = {};
	// Active sparse-checkout partition (cone-mode include paths, repo-relative,
	// no leading/trailing slash). `null` = not yet loaded from disk; `[]` =
	// confirmed no partition. Used to filter statusMatrix and to re-apply
	// SKIP_WORKTREE after `git checkout`, since git clears SKIP_WORKTREE on
	// any file whose blob differs between branches (to avoid silent data loss).
	private sparsePartition: string[] | null = null;

	constructor(config: GitBackendConfig) {
		this.config = config;
		this.cli = new GitCliExecutor({
			gitPath: config.gitPath,
			cwd: config.dir,
			disableSsl: config.disableSslVerification,
		});
		DebugLogger.log('GitCli', `Initialized CLI backend for: ${config.dir}`);
	}

	// Load the active sparse-checkout partition from .git/info/sparse-checkout.
	// buildConePatterns() writes intermediate-parent includes (e.g. `/docs/`)
	// paired with sibling excludes (`!/docs/*/`) so git's cone parser exposes
	// the parent dir without recursing. For statusMatrix filtering we only
	// want the LEAF includes — directories that are recursively included.
	// A line `/X/` is a leaf iff no `!/X/*/` line exists alongside it.
	private loadSparsePartitionFromDisk(): string[] {
		try {
			const file = path.join(this.config.dir, '.git', 'info', 'sparse-checkout');
			if (!fs.existsSync(file)) return [];
			const raw = fs.readFileSync(file, 'utf8');
			const includes = new Set<string>();
			const intermediates = new Set<string>();
			for (const line of raw.split(/\r?\n/)) {
				const t = line.trim();
				if (!t || t.startsWith('#') || t === '/*') continue;
				if (t.startsWith('!')) {
					const m = t.match(/^!\/(.+?)\/\*\/?$/);
					if (m) intermediates.add(m[1]);
				} else if (t.startsWith('/') && t.endsWith('/')) {
					const cleaned = t.slice(1, -1);
					if (cleaned.length > 0) includes.add(cleaned);
				}
			}
			return [...includes].filter(p => !intermediates.has(p));
		} catch {
			return [];
		}
	}

	private getActivePartition(): string[] {
		if (this.sparsePartition === null) {
			this.sparsePartition = this.loadSparsePartitionFromDisk();
		}
		return this.sparsePartition;
	}

	// Restore SKIP_WORKTREE invariants after any git op that touches the
	// index/worktree (checkout, pull, merge, revert, stash pop/apply).
	// Git clears SKIP_WORKTREE on files whose blob differs between the trees
	// being reconciled, which silently leaks the sparse view. No-op when no
	// partition is configured. Failures are logged, not thrown — the user's
	// op already succeeded; a re-apply failure is degraded UX, not data loss.
	private async reapplySparsePartitionAfter(opName: string): Promise<void> {
		const partition = this.getActivePartition();
		if (partition.length === 0) return;
		try {
			await this.sparseCheckoutSet(partition);
		} catch (e) {
			DebugLogger.warn('GitCli', `Sparse re-apply after ${opName} failed`, { error: String(e) });
		}
	}

	// ---- helpers ----

	private authUrl(remoteUrl: string, token: string): string {
		return GitCliExecutor.buildAuthUrl(remoteUrl, token);
	}

	private async getRemoteUrl(): Promise<string> {
		try {
			return await this.cli.run(['remote', 'get-url', 'origin']);
		} catch {
			return '';
		}
	}

	private handleError(context: string, error: unknown): void {
		const message = error instanceof Error ? error.message : String(error);
		DebugLogger.error('GitCli', context, { message });
		console.error(`${context}:`, error);
		new Notice(`${context}: ${message}`);
	}

	// ---- Lifecycle ----

	setPagesCompatSnapshot(snapshot: Record<string, string> | undefined): void {
		this.pagesCompatSnapshot = snapshot ? { ...snapshot } : {};
	}

	isIgnored(filePath: string): boolean {
		const patterns = this.config.ignorePatterns;
		if (!patterns || patterns.length === 0) return false;
		return matchesIgnorePattern(filePath, patterns);
	}

	getRepoDir(): string {
		return this.config.dir;
	}

	// ---- Repository setup ----

	async init(): Promise<void> {
		try {
			await this.cli.run(['init', '--initial-branch=main']);
			await this.ensureAutoCrlf();
			DebugLogger.log('GitCli', 'Repository initialized');
		} catch (error) {
			this.handleError('Failed to initialize repository', error);
			throw error;
		}
	}

	async ensureAutoCrlf(): Promise<void> {
		try {
			await this.cli.run(['config', 'core.autocrlf', 'true']);
		} catch (error) {
			DebugLogger.log('GitCli', 'Could not set core.autocrlf', { error });
		}
	}

	async addRemote(name: string, url: string): Promise<void> {
		let normalizedUrl = url.trim();
		if (!normalizedUrl.endsWith('.git')) {
			normalizedUrl += '.git';
		}

		try {
			// Check if remote exists
			const result = await this.cli.runRaw(['remote', 'get-url', name]);
			if (result.exitCode === 0) {
				await this.cli.run(['remote', 'set-url', name, normalizedUrl]);
			} else {
				await this.cli.run(['remote', 'add', name, normalizedUrl]);
			}
			DebugLogger.log('GitCli', 'Remote configured', { name, url: normalizedUrl });
		} catch {
			try {
				await this.cli.run(['remote', 'add', name, normalizedUrl]);
			} catch (error) {
				this.handleError('Failed to add remote', error);
				throw error;
			}
		}
	}

	async clone(url: string, token: string, branch?: string): Promise<void> {
		try {
			let normalizedUrl = url.trim();
			if (!normalizedUrl.endsWith('.git')) normalizedUrl += '.git';

			const authUrl = this.authUrl(normalizedUrl, token);
			const args = ['clone', '--filter=blob:none', '--depth=1'];
			if (branch) args.push('--branch', branch);
			args.push(authUrl, this.config.dir);

			// Clone needs to run from parent dir since dir doesn't exist yet
			const parentDir = path.dirname(this.config.dir);
			await this.cli.run(args, { cwd: parentDir, timeout: 120_000 });

			// Replace auth URL with clean URL in remote config
			await this.cli.run(['remote', 'set-url', 'origin', normalizedUrl]);

			DebugLogger.log('GitCli', 'Clone completed');
		} catch (error) {
			this.handleError('Failed to clone repository', error);
			throw error;
		}
	}

	// ---- Branch operations ----

	async getCurrentBranch(): Promise<string> {
		try {
			const branch = await this.cli.run(['branch', '--show-current']);
			return branch || 'main';
		} catch {
			return 'main';
		}
	}

	async listBranches(): Promise<GitBranch[]> {
		try {
			const currentBranch = await this.getCurrentBranch();

			// Local branches
			const localOutput = await this.cli.run([
				'branch', '--format=%(refname:short)\t%(objectname:short)',
			]);

			// Remote branches
			let remoteBranchNames = new Set<string>();
			try {
				const remoteOutput = await this.cli.run([
					'branch', '-r', '--format=%(refname:short)',
				]);
				for (const line of remoteOutput.split('\n')) {
					const name = line.trim();
					if (name && !name.includes('->')) {
						remoteBranchNames.add(name.replace(/^origin\//, ''));
					}
				}
			} catch { /* no remote */ }

			const branches: GitBranch[] = [];
			for (const line of localOutput.split('\n')) {
				if (!line.trim()) continue;
				const [name, sha] = line.split('\t');
				branches.push({
					name: name.trim(),
					isCurrent: name.trim() === currentBranch,
					commitSha: (sha || '').trim(),
					isRemote: false,
					remoteExists: remoteBranchNames.size > 0 ? remoteBranchNames.has(name.trim()) : undefined,
				});
			}

			return branches;
		} catch (error) {
			this.handleError('Failed to list branches', error);
			throw error;
		}
	}

	async createBranch(branchName: string, startPoint?: string): Promise<void> {
		try {
			const args = ['branch', branchName];
			if (startPoint) args.push(startPoint);
			await this.cli.run(args);
		} catch (error) {
			this.handleError('Failed to create branch', error);
			throw error;
		}
	}

	async checkout(branchName: string, options?: { force?: boolean }): Promise<void> {
		try {
			const args = ['checkout'];
			if (options?.force) args.push('--force');
			args.push(branchName);
			await this.cli.run(args);
		} catch (error) {
			this.handleError('Failed to checkout branch', error);
			throw error;
		}

		await this.reapplySparsePartitionAfter('checkout');
	}

	async deleteBranch(branchName: string): Promise<void> {
		try {
			await this.cli.run(['branch', '-d', branchName]);
		} catch (error) {
			this.handleError('Failed to delete branch', error);
			throw error;
		}
	}

	async isBranchMergedInto(branch: string, target: string): Promise<boolean> {
		try {
			const result = await this.cli.runRaw(['merge-base', '--is-ancestor', branch, target]);
			return result.exitCode === 0;
		} catch {
			return false;
		}
	}

	// ---- Status / file listing ----

	async status(filepath: string): Promise<string> {
		try {
			const output = await this.cli.run(['status', '--porcelain=v2', '--', filepath]);
			if (!output.trim()) return 'unmodified';
			const files = parseStatusV2(output);
			return files.length > 0 ? files[0].status : 'unmodified';
		} catch {
			return 'unknown';
		}
	}

	async statusMatrix(): Promise<GitFile[]> {
		try {
			const output = await this.cli.run([
				'status', '--porcelain=v2', '--untracked-files=all',
			]);

			let files = parseStatusV2(output);

			// Apply ignore patterns
			files = files.filter(f => !this.isIgnored(f.path));

			// Sparse-partition filter. SKIP_WORKTREE bits can leak across
			// branch switches when blob content differs; without this filter
			// the UI would surface ghost entries (typically "deleted") for
			// files outside the user's selected cone. Renames need both
			// endpoints inside the cone to remain visible.
			const partition = this.getActivePartition();
			if (partition.length > 0) {
				files = files.filter(f => {
					if (!matchesCone(f.path, partition)) return false;
					if (f.oldPath && !matchesCone(f.oldPath, partition)) return false;
					return true;
				});
			}

			// Pages compat suppression: skip files that only look modified because
			// HEAD has the transformed blob and workdir has the original
			if (Object.keys(this.pagesCompatSnapshot).length > 0) {
				const filtered: GitFile[] = [];
				for (const f of files) {
					if (
						!f.staged &&
						f.status === FileStatus.MODIFIED &&
						this.pagesCompatSnapshot[f.path]
					) {
						try {
							const abs = path.join(this.config.dir, f.path);
							const buf = fs.readFileSync(abs);
							const oid = await this.cli.run(
								['hash-object', '--stdin'],
								{ stdin: buf },
							);
							if (oid.trim() === this.pagesCompatSnapshot[f.path]) {
								continue;
							}
						} catch { /* fall through */ }
					}
					filtered.push(f);
				}
				return filtered;
			}

			return files;
		} catch (error) {
			this.handleError('Failed to get status', error);
			throw error;
		}
	}

	async listTrackedFolders(ref = 'HEAD'): Promise<string[]> {
		try {
			const output = await this.cli.run([
				'ls-tree', '-r', '-d', '--name-only', ref,
			]);
			return output
				.split('\n')
				.map(l => l.trim().replace(/\\/g, '/'))
				.filter(l => l.length > 0)
				.sort();
		} catch {
			return [];
		}
	}

	async listAllFiles(): Promise<{ path: string; isDirectory: boolean; size: number }[]> {
		const results: { path: string; isDirectory: boolean; size: number }[] = [];
		const repoDir = this.config.dir;

		const walk = (dir: string, prefix: string) => {
			try {
				const entries = fs.readdirSync(dir, { withFileTypes: true });
				for (const entry of entries) {
					if (entry.name === '.git' || entry.name === 'node_modules') continue;
					const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
					const fullPath = `${dir}/${entry.name}`;
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
			} catch { /* not readable */ }
		};

		walk(repoDir, '');
		return results;
	}

	// ---- Staging ----

	async add(filepaths: string[]): Promise<void> {
		try {
			if (filepaths.length === 0) return;
			await this.cli.run(['add', '--', ...filepaths]);
		} catch (error) {
			this.handleError('Failed to stage files', error);
			throw error;
		}
	}

	async remove(filepaths: string[]): Promise<void> {
		try {
			if (filepaths.length === 0) return;
			await this.cli.run(['rm', '--cached', '--', ...filepaths]);
		} catch (error) {
			this.handleError('Failed to stage file removal', error);
			throw error;
		}
	}

	async reset(filepaths: string[]): Promise<void> {
		try {
			if (filepaths.length === 0) return;
			await this.cli.run(['restore', '--staged', '--', ...filepaths]);
		} catch (error) {
			this.handleError('Failed to unstage files', error);
			throw error;
		}
	}

	// ---- Blob / index manipulation ----

	async writeBlob(content: Uint8Array): Promise<string> {
		const oid = await this.cli.run(
			['hash-object', '-w', '--stdin'],
			{ stdin: Buffer.from(content) },
		);
		return oid.trim();
	}

	async updateIndexBlob(filepath: string, oid: string, add: boolean): Promise<void> {
		const args = ['update-index'];
		if (add) args.push('--add');
		args.push(`--cacheinfo`, `100644,${oid},${filepath}`);
		await this.cli.run(args);
	}

	async applyIndexOverrides(snapshot: IndexOverrideSnapshot): Promise<ApplyOverridesResult> {
		const touched: string[] = [];
		const workdirOids: Record<string, string> = {};

		// Stage asset files first
		if (snapshot.addedAssetPaths && snapshot.addedAssetPaths.length > 0) {
			await this.add(snapshot.addedAssetPaths);
			DebugLogger.log('GitCli', 'Staged transform-added assets', {
				count: snapshot.addedAssetPaths.length,
			});
		}

		for (const [filePath, bytes] of snapshot.files) {
			// Capture workdir blob OID before writing override
			try {
				const abs = path.join(this.config.dir, filePath);
				if (fs.existsSync(abs)) {
					const wdOid = await this.cli.run(
						['hash-object', '--stdin'],
						{ stdin: fs.readFileSync(abs) },
					);
					workdirOids[filePath] = wdOid.trim();
				}
			} catch { /* best effort */ }

			const oid = await this.writeBlob(bytes);
			await this.updateIndexBlob(filePath, oid, false);
			touched.push(filePath);
		}

		return { touched, workdirOids };
	}

	// ---- Commit ----

	async commit(
		message: string,
		author?: { name: string; email: string },
		transformHook?: CommitTransformHook,
	): Promise<CommitResult> {
		try {
			const authorInfo = author || this.config.author;
			let transformedWorkdirOids: Record<string, string> | undefined;

			if (transformHook) {
				const stagedPaths = (await this.statusMatrix()).filter(f => f.staged).map(f => f.path);
				const snapshot = await transformHook(stagedPaths);
				if (snapshot.files.size > 0 || (snapshot.addedAssetPaths && snapshot.addedAssetPaths.length > 0)) {
					const result = await this.applyIndexOverrides(snapshot);
					DebugLogger.log('GitCli', 'Applied commit transform overrides', { count: result.touched.length });
					if (Object.keys(result.workdirOids).length > 0) {
						transformedWorkdirOids = result.workdirOids;
					}
				}
			}

			const sha = await this.cli.run([
				'commit', '-m', message,
				'--author', `${authorInfo.name} <${authorInfo.email}>`,
			]);

			// Extract SHA from output
			const shaMatch = sha.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
			const commitSha = shaMatch ? shaMatch[1] : await this.cli.run(['rev-parse', 'HEAD']);

			if (transformedWorkdirOids) {
				Object.assign(this.pagesCompatSnapshot, transformedWorkdirOids);
			}

			return { sha: commitSha.trim(), transformedWorkdirOids };
		} catch (error) {
			this.handleError('Failed to commit changes', error);
			throw error;
		}
	}

	async amendCommit(
		message: string,
		author?: { name: string; email: string },
		transformHook?: CommitTransformHook,
	): Promise<CommitResult> {
		try {
			const authorInfo = author || this.config.author;
			let transformedWorkdirOids: Record<string, string> | undefined;

			if (transformHook) {
				const stagedPaths = (await this.statusMatrix()).filter(f => f.staged).map(f => f.path);
				const snapshot = await transformHook(stagedPaths);
				if (snapshot.files.size > 0 || (snapshot.addedAssetPaths && snapshot.addedAssetPaths.length > 0)) {
					const result = await this.applyIndexOverrides(snapshot);
					if (Object.keys(result.workdirOids).length > 0) {
						transformedWorkdirOids = result.workdirOids;
					}
				}
			}

			const output = await this.cli.run([
				'commit', '--amend', '-m', message,
				'--author', `${authorInfo.name} <${authorInfo.email}>`,
			]);

			const shaMatch = output.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
			const commitSha = shaMatch ? shaMatch[1] : await this.cli.run(['rev-parse', 'HEAD']);

			if (transformedWorkdirOids) {
				Object.assign(this.pagesCompatSnapshot, transformedWorkdirOids);
			}

			return { sha: commitSha.trim(), transformedWorkdirOids };
		} catch (error) {
			this.handleError('Failed to amend commit', error);
			throw error;
		}
	}

	async revertCommit(sha: string, author?: { name: string; email: string }): Promise<string> {
		try {
			const authorInfo = author || this.config.author;
			await this.cli.run([
				'revert', '--no-commit', sha,
			]);

			const originalMsg = await this.cli.run(['log', '-1', '--format=%s', sha]);
			const revertMessage = `Revert "${originalMsg.trim()}"\n\nThis reverts commit ${sha}.`;

			const output = await this.cli.run([
				'commit', '-m', revertMessage,
				'--author', `${authorInfo.name} <${authorInfo.email}>`,
			]);

			const shaMatch = output.match(/\[[\w/.-]+ ([0-9a-f]+)\]/);
			const revertSha = shaMatch ? shaMatch[1] : await this.cli.run(['rev-parse', 'HEAD']);
			await this.reapplySparsePartitionAfter('revert');
			return revertSha.trim();
		} catch (error) {
			this.handleError('Failed to revert commit', error);
			throw error;
		}
	}

	// ---- Remote operations ----

	async pull(remote: string, branch: string, token: string): Promise<void> {
		try {
			const remoteUrl = await this.getRemoteUrl();
			const authUrl = this.authUrl(remoteUrl, token);

			await this.cli.run(
				['pull', authUrl, branch],
				{ timeout: 120_000 },
			);
			DebugLogger.log('GitCli', 'Pull completed');
			await this.reapplySparsePartitionAfter('pull');
		} catch (error) {
			if (error instanceof GitCliError) {
				const msg = error.stderr || error.stdout;
				if (/Could not find|does not exist|couldn't find remote ref/i.test(msg)) {
					const friendly = new Error(
						`Branch "${branch}" no longer exists on ${remote} — it was likely merged and deleted. Switch to another branch.`
					);
					this.handleError('Failed to pull changes', friendly);
					throw friendly;
				}
			}
			this.handleError('Failed to pull changes', error);
			throw error;
		}
	}

	async push(remote: string, branch: string, token: string): Promise<void> {
		try {
			const remoteUrl = await this.getRemoteUrl();
			const authUrl = this.authUrl(remoteUrl, token);

			await this.cli.run(
				['push', authUrl, `HEAD:refs/heads/${branch}`],
				{ timeout: 120_000 },
			);
			DebugLogger.log('GitCli', 'Push completed');
		} catch (error) {
			this.handleError('Failed to push changes', error);
			throw error;
		}
	}

	async fetch(remote: string, token: string): Promise<void> {
		try {
			const remoteUrl = await this.getRemoteUrl();
			const authUrl = this.authUrl(remoteUrl, token);

			await this.cli.run(
				['fetch', '--prune', authUrl, '+refs/heads/*:refs/remotes/origin/*'],
				{ timeout: 120_000 },
			);
			DebugLogger.log('GitCli', 'Fetch completed');
		} catch (error) {
			this.handleError('Failed to fetch from remote', error);
			throw error;
		}
	}

	// ---- History ----

	async log(ref?: string, depth = 20): Promise<GitCommit[]> {
		try {
			const args = [
				'log',
				'--format=%H%n%s%n%an%n%ae%n%at%n%P%n---END---',
				`-n`, `${depth}`,
			];
			if (ref) args.push(ref);

			const output = await this.cli.run(args);
			return this.parseLogOutput(output);
		} catch (error) {
			this.handleError('Failed to get commit log', error);
			throw error;
		}
	}

	async getAllBranchLogs(depth = 100): Promise<{ commits: GitCommit[]; branchHeads: Map<string, string> }> {
		try {
			const branches = await this.listBranches();
			const branchHeads = new Map<string, string>();

			for (const b of branches) {
				if (b.commitSha) branchHeads.set(b.name, b.commitSha);
			}

			// Remote branch heads
			try {
				const remoteOutput = await this.cli.run([
					'branch', '-r', '--format=%(refname:short)\t%(objectname:short)',
				]);
				for (const line of remoteOutput.split('\n')) {
					if (!line.trim() || line.includes('->')) continue;
					const [name, sha] = line.split('\t');
					if (name && sha) branchHeads.set(name.trim(), sha.trim());
				}
			} catch { /* no remote */ }

			const output = await this.cli.run([
				'log', '--all',
				'--format=%H%n%s%n%an%n%ae%n%at%n%P%n---END---',
				`-n`, `${depth}`,
			]);

			const commits = this.parseLogOutput(output);
			commits.sort((a, b) => b.timestamp - a.timestamp);
			return { commits, branchHeads };
		} catch (error) {
			this.handleError('Failed to get full log', error);
			throw error;
		}
	}

	async merge(theirBranch: string): Promise<void> {
		try {
			await this.cli.run(['merge', theirBranch]);
		} catch (error) {
			this.handleError('Failed to merge branch', error);
			throw error;
		}
		await this.reapplySparsePartitionAfter('merge');
	}

	async getSyncStatus(remote: string, branch: string): Promise<SyncStatus> {
		try {
			let ahead = 0;
			let behind = 0;
			let remoteBranchMissing = false;

			// Check if remote tracking branch exists
			const refCheck = await this.cli.runRaw([
				'rev-parse', '--verify', `refs/remotes/${remote}/${branch}`,
			]);

			if (refCheck.exitCode !== 0) {
				remoteBranchMissing = true;
				// Count commits on this branch
				try {
					const countOutput = await this.cli.run([
						'rev-list', '--count', 'HEAD',
					]);
					ahead = parseInt(countOutput.trim()) || 1;
				} catch {
					ahead = 1;
				}
			} else {
				// Count ahead/behind
				try {
					const countOutput = await this.cli.run([
						'rev-list', '--left-right', '--count',
						`HEAD...${remote}/${branch}`,
					]);
					const parts = countOutput.trim().split(/\s+/);
					ahead = parseInt(parts[0]) || 0;
					behind = parseInt(parts[1]) || 0;
				} catch { /* default 0/0 */ }
			}

			const files = await this.statusMatrix();
			return {
				ahead,
				behind,
				remoteBranchMissing,
				hasUncommittedChanges: files.some(f => f.staged),
				hasUntrackedFiles: files.some(f => f.status === FileStatus.UNTRACKED),
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

	// ---- File content ----

	async getFileAtCommit(filepath: string, ref = 'HEAD'): Promise<string | null> {
		try {
			return await this.cli.run(['show', `${ref}:${filepath}`]);
		} catch {
			return null;
		}
	}

	async getWorkingCopyContent(filepath: string): Promise<string | null> {
		try {
			const fullPath = path.join(this.config.dir, filepath);
			return fs.readFileSync(fullPath, { encoding: 'utf8' });
		} catch {
			return null;
		}
	}

	async getFileHistory(filepath: string, depth = 50): Promise<GitCommit[]> {
		try {
			const output = await this.cli.run([
				'log', '--follow',
				'--format=%H%n%s%n%an%n%ae%n%at%n%P%n---END---',
				`-n`, `${depth}`,
				'--', filepath,
			]);
			return this.parseLogOutput(output);
		} catch {
			return [];
		}
	}

	async getFileBlame(filepath: string): Promise<Array<{
		startLine: number;
		endLine: number;
		commit: GitCommit;
	}>> {
		try {
			const output = await this.cli.run(['blame', '--porcelain', filepath]);
			return this.parseBlameOutput(output);
		} catch {
			return [];
		}
	}

	// ---- Tags ----

	async listTags(): Promise<GitTag[]> {
		try {
			const output = await this.cli.run([
				'tag', '-l', '--format=%(refname:short)\t%(objectname:short)\t%(objecttype)\t%(contents:subject)\t%(taggername)\t%(creatordate:unix)',
			]);

			const tags: GitTag[] = [];
			for (const line of output.split('\n')) {
				if (!line.trim()) continue;
				const parts = line.split('\t');
				tags.push({
					name: parts[0],
					oid: parts[1] || '',
					message: parts[3] || undefined,
					tagger: parts[4] || undefined,
					timestamp: parts[5] ? parseInt(parts[5]) * 1000 : undefined,
				});
			}
			return tags;
		} catch {
			return [];
		}
	}

	async createTag(name: string, options?: { message?: string; oid?: string }): Promise<void> {
		try {
			const args = ['tag'];
			if (options?.message) {
				args.push('-a', name, '-m', options.message);
			} else {
				args.push(name);
			}
			if (options?.oid) args.push(options.oid);
			await this.cli.run(args);
			DebugLogger.log('GitCli', `Tag created: ${name}`);
		} catch (error) {
			this.handleError('Failed to create tag', error);
			throw error;
		}
	}

	async deleteTag(name: string): Promise<void> {
		try {
			await this.cli.run(['tag', '-d', name]);
		} catch (error) {
			this.handleError('Failed to delete tag', error);
			throw error;
		}
	}

	async pushTag(tagName: string, token: string): Promise<void> {
		try {
			const remoteUrl = await this.getRemoteUrl();
			const authUrl = this.authUrl(remoteUrl, token);
			await this.cli.run(['push', authUrl, `refs/tags/${tagName}`]);
			DebugLogger.log('GitCli', `Tag pushed: ${tagName}`);
		} catch (error) {
			this.handleError('Failed to push tag', error);
			throw error;
		}
	}

	// ---- Stash ----

	async stashPush(opts?: StashPushOptions): Promise<void> {
		const args = ['stash', 'push'];
		if (opts?.includeUntracked) args.push('-u');
		if (opts?.keepIndex) args.push('--keep-index');
		if (opts?.message) args.push('-m', opts.message);
		if (opts?.paths && opts.paths.length > 0) {
			args.push('--');
			for (const p of opts.paths) args.push(p);
		}
		try {
			const output = await this.cli.run(args);
			// Git silently no-ops when there's nothing to stash. Surface that
			// instead of pretending it worked — the UI can show a clearer notice.
			if (/No local changes to save/i.test(output)) {
				throw new Error('Nothing to stash — your working tree is clean.');
			}
		} catch (error) {
			this.handleError('Failed to stash changes', error);
			throw error;
		}
	}

	async stashPop(index?: number): Promise<void> {
		try {
			const args = ['stash', 'pop'];
			if (index !== undefined) args.push(`stash@{${index}}`);
			await this.cli.run(args);
		} catch (error) {
			this.handleError('Failed to pop stash', error);
			throw error;
		}
		await this.reapplySparsePartitionAfter('stash pop');
	}

	async stashApply(index?: number): Promise<void> {
		try {
			const args = ['stash', 'apply'];
			if (index !== undefined) args.push(`stash@{${index}}`);
			await this.cli.run(args);
		} catch (error) {
			this.handleError('Failed to apply stash', error);
			throw error;
		}
		await this.reapplySparsePartitionAfter('stash apply');
	}

	async stashList(): Promise<StashEntry[]> {
		try {
			// %H = stash commit oid, %ct = committer date (epoch), %gs = reflog
			// subject ("WIP on <branch>: <oid> <msg>" or user-supplied message).
			// Tab-separated to keep parsing trivial. NUL between records would
			// be cleaner but git doesn't honor -z for stash list across all
			// versions, so we lean on the fact that tabs aren't in any of
			// these fields.
			const output = await this.cli.run([
				'stash', 'list', '--format=%gd%x09%H%x09%ct%x09%gs',
			]);
			const entries: StashEntry[] = [];
			for (const line of output.split('\n')) {
				if (!line.trim()) continue;
				const parts = line.split('\t');
				const ref = parts[0] ?? '';
				const oid = parts[1] ?? '';
				const tsRaw = parts[2] ?? '';
				const subject = parts.slice(3).join('\t');
				const indexMatch = ref.match(/\{(\d+)\}/);

				// Subject is typically "WIP on <branch>: <short-oid> <msg>" or
				// "On <branch>: <user message>". Extract branch + message.
				let branch: string | undefined;
				let message = subject;
				const wipMatch = subject.match(/^WIP on ([^:]+): [0-9a-f]+ (.*)$/);
				const onMatch = subject.match(/^On ([^:]+): (.*)$/);
				if (wipMatch) {
					branch = wipMatch[1];
					message = wipMatch[2];
				} else if (onMatch) {
					branch = onMatch[1];
					message = onMatch[2];
				}

				const ts = Number.parseInt(tsRaw, 10);
				entries.push({
					index: indexMatch ? Number.parseInt(indexMatch[1], 10) : entries.length,
					message: message || subject || ref,
					oid,
					branch,
					timestamp: Number.isFinite(ts) ? ts : undefined,
				});
			}
			return entries;
		} catch {
			return [];
		}
	}

	async stashDrop(index: number): Promise<void> {
		try {
			await this.cli.run(['stash', 'drop', `stash@{${index}}`]);
		} catch (error) {
			this.handleError('Failed to drop stash', error);
			throw error;
		}
	}

	async stashClear(): Promise<void> {
		try {
			await this.cli.run(['stash', 'clear']);
		} catch (error) {
			this.handleError('Failed to clear stash', error);
			throw error;
		}
	}

	async stashShow(index: number): Promise<StashFileChange[]> {
		// `git stash show --numstat -z stash@{N}` returns NUL-separated
		// "<add>\t<del>\t<path>" records — the same format as `git diff --numstat`.
		// We pair that with `git stash show --name-status -z` to recover the
		// per-file status letter (numstat doesn't include status).
		try {
			const ref = `stash@{${index}}`;
			const [numstat, namestatus] = await Promise.all([
				this.cli.run(['stash', 'show', '--numstat', '-z', ref]).catch(() => ''),
				this.cli.run(['stash', 'show', '--name-status', '-z', ref]).catch(() => ''),
			]);

			const statusByPath = new Map<string, string>();
			// name-status -z layout: <status>\0<path>\0(<path2>\0 for renames)\0...
			const nsTokens = namestatus.split(String.fromCharCode(0));
			for (let i = 0; i < nsTokens.length; ) {
				const status = nsTokens[i++];
				if (!status) { i++; continue; }
				const p1 = nsTokens[i++];
				if (!p1) continue;
				// R/C status is followed by a second path (new name).
				if (status.startsWith('R') || status.startsWith('C')) {
					const p2 = nsTokens[i++];
					if (p2) statusByPath.set(p2, status[0]);
					statusByPath.set(p1, status[0]);
				} else {
					statusByPath.set(p1, status[0]);
				}
			}

			const out: StashFileChange[] = [];
			const tokens = numstat.split(String.fromCharCode(0));
			for (let i = 0; i < tokens.length; i++) {
				const token = tokens[i];
				if (!token) continue;
				// numstat -z output: each record is "<add>\t<del>\t<path>" with
				// NUL terminator. Renames may emit the old/new path as separate
				// records in newer git — we keep it simple and treat the path
				// in the same record as authoritative.
				const m = token.match(/^(\d+|-)\t(\d+|-)\t(.+)$/);
				if (!m) continue;
				const adds = m[1] === '-' ? 0 : Number.parseInt(m[1], 10);
				const dels = m[2] === '-' ? 0 : Number.parseInt(m[2], 10);
				const p = m[3];
				out.push({
					path: p,
					status: statusByPath.get(p) || 'M',
					insertions: Number.isFinite(adds) ? adds : 0,
					deletions: Number.isFinite(dels) ? dels : 0,
				});
			}
			return out;
		} catch {
			return [];
		}
	}

	async stashBranch(index: number, branchName: string): Promise<void> {
		try {
			await this.cli.run(['stash', 'branch', branchName, `stash@{${index}}`]);
		} catch (error) {
			this.handleError('Failed to create branch from stash', error);
			throw error;
		}
		await this.reapplySparsePartitionAfter('stash branch');
	}

	// ---- Sparse checkout ----

	/**
	 * Remove stale .git/info/sparse-checkout.lock files. On Windows, a
	 * crashed or interrupted sparse-checkout invocation can leave the
	 * lock file behind, which blocks every subsequent sparse-checkout
	 * command with "Another git process seems to be running…".
	 *
	 * A lock file older than 10 seconds is considered stale (real
	 * sparse-checkout runs complete in milliseconds).
	 */
	private cleanStaleSparseLock(): void {
		try {
			const lockPath = path.join(this.config.dir, '.git', 'info', 'sparse-checkout.lock');
			if (!fs.existsSync(lockPath)) return;
			const stat = fs.statSync(lockPath);
			const ageMs = Date.now() - stat.mtimeMs;
			if (ageMs > 10_000) {
				fs.unlinkSync(lockPath);
				DebugLogger.log('GitCli', 'Removed stale sparse-checkout.lock', { ageMs });
			}
		} catch (e) {
			DebugLogger.warn('GitCli', 'Failed to clean sparse lock', { error: String(e) });
		}
	}

	async sparseCheckoutInit(coneMode = true): Promise<void> {
		// `sparseCheckoutSet` does all initialization implicitly. Calling
		// `git sparse-checkout init --cone` separately triggers a known
		// crash on Git for Windows 2.53.0. Just enable config here.
		await this.cli.run(['config', 'core.sparseCheckout', 'true']);
		if (coneMode) {
			await this.cli.run(['config', 'core.sparseCheckoutCone', 'true']);
		}
		DebugLogger.log('GitCli', 'Sparse checkout initialized (config only)', { coneMode });
	}

	async sparseCheckoutSet(paths: string[]): Promise<void> {
		this.cleanStaleSparseLock();

		// We bypass `git sparse-checkout set` entirely because Git for Windows
		// 2.53.0 crashes (ACCESS_VIOLATION + "invalid path '/'") on every
		// sparse-checkout subcommand that touches the working tree. We replicate
		// the behavior with plumbing commands:
		//   1. Enable sparse-checkout config
		//   2. Write the cone-mode pattern file directly
		//   3. Walk the index, set skip-worktree on excluded files, delete them
		//   4. Clear skip-worktree on included files, restore them if missing

		// 1. Config
		await this.cli.run(['config', 'core.sparseCheckout', 'true']);
		await this.cli.run(['config', 'core.sparseCheckoutCone', 'true']);

		// 2. Write the cone-mode pattern file (documentary; reads pick this up)
		const patterns = buildConePatterns(paths);
		const sparseFile = path.join(this.config.dir, '.git', 'info', 'sparse-checkout');
		const infoDir = path.dirname(sparseFile);
		if (!fs.existsSync(infoDir)) fs.mkdirSync(infoDir, { recursive: true });
		fs.writeFileSync(sparseFile, patterns.join('\n') + '\n', 'utf8');

		// 3+4. Apply the cone to the working tree by partitioning tracked files
		const cleanedPaths = paths
			.map(p => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, ''))
			.filter(p => p.length > 0);

		const allTracked = (await this.cli.run(['ls-files'])).split('\n')
			.map(l => l.trim())
			.filter(l => l.length > 0);

		const inside: string[] = [];
		const outside: string[] = [];
		for (const f of allTracked) {
			if (matchesCone(f, cleanedPaths)) inside.push(f);
			else outside.push(f);
		}

		DebugLogger.log('GitCli', 'Applying sparse partition', {
			total: allTracked.length,
			inside: inside.length,
			outside: outside.length,
		});

		// Set skip-worktree on excluded files (batched)
		await this.batchUpdateIndex('--skip-worktree', outside);
		// Clear skip-worktree on included files (so they're restored if previously hidden)
		await this.batchUpdateIndex('--no-skip-worktree', inside);

		// Delete excluded files from disk
		for (const f of outside) {
			const abs = path.join(this.config.dir, f);
			try {
				if (fs.existsSync(abs)) fs.unlinkSync(abs);
			} catch { /* ignore */ }
		}

		// Materialize included files that are missing from disk (e.g. previously excluded)
		const missingInside = inside.filter(f => {
			try { return !fs.existsSync(path.join(this.config.dir, f)); }
			catch { return false; }
		});
		if (missingInside.length > 0) {
			await this.batchCheckoutFiles(missingInside);
		}

		// Clean up empty directories left behind
		this.removeEmptyDirs(this.config.dir, cleanedPaths);

		// Cache the cleaned partition so subsequent statusMatrix() calls and
		// post-checkout re-apply paths see the current cone without re-parsing
		// .git/info/sparse-checkout.
		this.sparsePartition = cleanedPaths;

		DebugLogger.log('GitCli', 'Sparse checkout applied', { paths });
	}

	/** Run `git update-index <flag> -- <files>` in batches to respect command line limits. */
	private async batchUpdateIndex(flag: '--skip-worktree' | '--no-skip-worktree', files: string[]): Promise<void> {
		if (files.length === 0) return;
		const batchSize = 80;
		for (let i = 0; i < files.length; i += batchSize) {
			const batch = files.slice(i, i + batchSize);
			try {
				await this.cli.run(['update-index', flag, '--', ...batch]);
			} catch (e) {
				DebugLogger.warn('GitCli', `update-index ${flag} batch failed`, { error: String(e), batchStart: i });
			}
		}
	}

	/** Run `git checkout HEAD -- <files>` in batches. */
	private async batchCheckoutFiles(files: string[]): Promise<void> {
		if (files.length === 0) return;
		const batchSize = 80;
		for (let i = 0; i < files.length; i += batchSize) {
			const batch = files.slice(i, i + batchSize);
			try {
				await this.cli.run(['checkout', 'HEAD', '--', ...batch]);
			} catch (e) {
				DebugLogger.warn('GitCli', 'batch checkout failed', { error: String(e), batchStart: i });
			}
		}
	}

	/**
	 * Recursively remove empty directories under the repo root, except .git
	 * and any directory under a cone-included path (which is intentionally
	 * present even if currently empty).
	 */
	private removeEmptyDirs(root: string, includedPaths: string[]): void {
		const walk = (dir: string, relativePath: string): boolean => {
			// Don't recurse into .git
			if (relativePath === '.git' || relativePath.startsWith('.git/')) return false;

			let entries: fs.Dirent[] = [];
			try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return false; }

			let allChildrenRemoved = true;
			for (const entry of entries) {
				const childPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
				const childAbs = path.join(dir, entry.name);
				if (entry.isDirectory()) {
					if (walk(childAbs, childPath)) {
						// Child was removed; allChildrenRemoved stays true
					} else {
						allChildrenRemoved = false;
					}
				} else {
					allChildrenRemoved = false;
				}
			}

			// Don't remove the root itself
			if (relativePath === '') return false;

			// Don't remove directories that are inside or under any included cone path
			const isInsideIncluded = includedPaths.some(p =>
				relativePath === p || relativePath.startsWith(p + '/') || p.startsWith(relativePath + '/')
			);
			if (isInsideIncluded) return false;

			if (allChildrenRemoved) {
				try { fs.rmdirSync(dir); return true; } catch { return false; }
			}
			return false;
		};

		walk(root, '');
	}

	async sparseCheckoutAdd(paths: string[]): Promise<void> {
		this.cleanStaleSparseLock();
		await this.cli.run(['sparse-checkout', 'add', ...paths]);
	}

	async sparseCheckoutList(): Promise<string[]> {
		try {
			const output = await this.cli.run(['sparse-checkout', 'list']);
			return output.split('\n').filter(l => l.trim());
		} catch {
			return [];
		}
	}

	async sparseCheckoutDisable(): Promise<void> {
		this.cleanStaleSparseLock();
		await this.cli.run(['sparse-checkout', 'disable']);
		this.sparsePartition = [];
		DebugLogger.log('GitCli', 'Sparse checkout disabled');
	}

	async isSparseCheckout(): Promise<boolean> {
		try {
			const sparseFile = path.join(this.config.dir, '.git', 'info', 'sparse-checkout');
			return fs.existsSync(sparseFile);
		} catch {
			return false;
		}
	}

	// ---- Private helpers ----

	private parseLogOutput(output: string): GitCommit[] {
		const commits: GitCommit[] = [];
		const entries = output.split('---END---');

		for (const entry of entries) {
			const lines = entry.trim().split('\n');
			if (lines.length < 5) continue;

			commits.push({
				sha: lines[0].trim(),
				message: lines[1].trim(),
				authorName: lines[2].trim(),
				authorEmail: lines[3].trim(),
				timestamp: parseInt(lines[4].trim()) * 1000,
				parents: lines[5] ? lines[5].trim().split(' ').filter(s => s) : [],
			});
		}

		return commits;
	}

	private parseBlameOutput(output: string): Array<{
		startLine: number;
		endLine: number;
		commit: GitCommit;
	}> {
		const results: Array<{ startLine: number; endLine: number; commit: GitCommit }> = [];
		const commitCache = new Map<string, Partial<GitCommit>>();

		const lines = output.split('\n');
		let i = 0;
		let currentSha = '';
		let currentLine = 0;
		let numLines = 1;

		while (i < lines.length) {
			const line = lines[i];
			if (!line) { i++; continue; }

			// Header line: <sha> <orig-line> <final-line> [<num-lines>]
			const headerMatch = line.match(/^([0-9a-f]{40}) (\d+) (\d+)(?: (\d+))?$/);
			if (headerMatch) {
				currentSha = headerMatch[1];
				currentLine = parseInt(headerMatch[3]);
				numLines = headerMatch[4] ? parseInt(headerMatch[4]) : 1;

				if (!commitCache.has(currentSha)) {
					commitCache.set(currentSha, { sha: currentSha });
				}
				i++;
				continue;
			}

			// Commit metadata
			if (line.startsWith('author ')) {
				const c = commitCache.get(currentSha);
				if (c) c.authorName = line.substring(7);
			} else if (line.startsWith('author-mail ')) {
				const c = commitCache.get(currentSha);
				if (c) c.authorEmail = line.substring(12).replace(/[<>]/g, '');
			} else if (line.startsWith('author-time ')) {
				const c = commitCache.get(currentSha);
				if (c) c.timestamp = parseInt(line.substring(12)) * 1000;
			} else if (line.startsWith('summary ')) {
				const c = commitCache.get(currentSha);
				if (c) c.message = line.substring(8);
			} else if (line.startsWith('\t')) {
				// Content line — this marks the end of a blame entry
				const cached = commitCache.get(currentSha);
				if (cached) {
					const commit: GitCommit = {
						sha: cached.sha || currentSha,
						message: cached.message || '',
						authorName: cached.authorName || '',
						authorEmail: cached.authorEmail || '',
						timestamp: cached.timestamp || 0,
						parents: [],
					};

					// Merge with previous entry if same commit and adjacent
					const last = results[results.length - 1];
					if (last && last.commit.sha === commit.sha && last.endLine === currentLine - 1) {
						last.endLine = currentLine + numLines - 1;
					} else {
						results.push({
							startLine: currentLine,
							endLine: currentLine + numLines - 1,
							commit,
						});
					}
				}
			}

			i++;
		}

		return results;
	}
}
