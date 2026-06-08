/**
 * JunctionManager — owns the lifecycle of vault junctions for hidden-clone
 * repos, and translates paths between vault-relative (what Obsidian sees)
 * and repo-relative (what Git operates on).
 *
 * All path-bearing UI (file-explorer status badges, findRepoForFile, the
 * move/upload modals, etc.) should go through this manager rather than
 * doing prefix matching on `localPath` themselves.
 */

import { App, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { SubTreeConfig } from '../types';
import {
	ensureJunction,
	ensureMirror,
	isJunction,
	isJunctionSupported,
	readJunctionTarget,
	removeJunction,
	removeMirror,
	pathsEqual,
	MirrorResult,
} from '../utils/junction-utils';
import { normalizePath } from '../utils/path-utils';
import { DebugLogger } from '../utils/debug-logger';

export type ReconcileResult = 'created' | 'ok' | 'repaired' | 'conflict' | 'error' | 'target-missing';

const DEFAULT_HIDDEN_CLONE_ROOT = '.gitlab-clones';

export class JunctionManager {
	constructor(private app: App) {}

	private vaultBasePath(): string {
		return (this.app.vault.adapter as any).basePath as string;
	}

	private toAbs(vaultRelPath: string): string {
		return path.join(this.vaultBasePath(), vaultRelPath);
	}

	/** True iff hiddenClone is enabled and the runtime supports it. */
	isActiveFor(config: SubTreeConfig): boolean {
		if (!config.hiddenClone?.enabled) return false;
		if (!isJunctionSupported()) return false;
		return !!config.hiddenClone.cloneFolder;
	}

	/** Compute the default clone folder for a repo id (.gitlab-clones/<id>). */
	defaultCloneFolder(repoId: string): string {
		return `${DEFAULT_HIDDEN_CLONE_ROOT}/${repoId}`;
	}

	/** Vault-relative clone path, respecting hiddenClone mode. */
	getCloneVaultPath(config: SubTreeConfig): string {
		if (this.isActiveFor(config) && config.hiddenClone) {
			return config.hiddenClone.cloneFolder;
		}
		return config.localPath;
	}

	/** Absolute clone path. */
	getCloneAbsPath(config: SubTreeConfig): string {
		return this.toAbs(this.getCloneVaultPath(config));
	}

	/**
	 * Default alias for a sparse path when the user hasn't set one. Uses
	 * `<localPath>/<basename(sparsePath)>` as a sensible starting point.
	 */
	defaultAliasFor(config: SubTreeConfig, sparsePath: string): string {
		const base = (config.localPath || '').replace(/[\\/]+$/, '');
		const leaf = sparsePath.split('/').filter(Boolean).pop() || sparsePath;
		return base ? `${base}/${leaf}` : leaf;
	}

	/**
	 * Auto-populate aliases for any sparse path that doesn't yet have one.
	 * Never overwrites a user-set value. Removes orphaned aliases (where
	 * the sparse path no longer exists). Returns true if config was changed.
	 */
	seedAliases(config: SubTreeConfig): boolean {
		if (!config.hiddenClone) return false;
		const sparsePaths = config.sparseCheckout?.paths || [];
		let changed = false;

		// Add missing
		for (const sp of sparsePaths) {
			if (!config.hiddenClone.aliases[sp]) {
				config.hiddenClone.aliases[sp] = this.defaultAliasFor(config, sp);
				changed = true;
			}
		}

		// Prune orphans
		const sparseSet = new Set(sparsePaths);
		for (const key of Object.keys(config.hiddenClone.aliases)) {
			if (!sparseSet.has(key)) {
				delete config.hiddenClone.aliases[key];
				changed = true;
			}
		}

		return changed;
	}

	/**
	 * Walk every alias entry. For each:
	 *   - If the link already exists and points to the right target → 'ok'
	 *   - If it's a broken or wrong-target junction → remove + recreate → 'repaired'
	 *   - If a real folder exists at the destination → 'conflict' (user must resolve)
	 *   - If nothing exists → create new junction → 'created'
	 *   - If sparse target doesn't exist in clone → 'target-missing'
	 * Idempotent — safe to call on every plugin load.
	 */
	async reconcile(config: SubTreeConfig): Promise<Map<string, ReconcileResult>> {
		const results = new Map<string, ReconcileResult>();
		if (!this.isActiveFor(config) || !config.hiddenClone) return results;

		const cloneAbs = this.getCloneAbsPath(config);
		const aliases = config.hiddenClone.aliases;

		for (const [sparsePath, aliasVaultPath] of Object.entries(aliases)) {
			const linkAbs = this.toAbs(aliasVaultPath);
			const targetAbs = path.join(cloneAbs, sparsePath.replace(/\//g, path.sep));

			try {
				if (!this.targetExists(targetAbs)) {
					results.set(aliasVaultPath, 'target-missing');
					DebugLogger.warn('Junctions', 'Mirror source missing — sparse may not have applied yet', {
						sparsePath, targetAbs,
					});
					new Notice(
						`Mirror "${aliasVaultPath}" skipped: source folder "${sparsePath}" not found in clone. Is sparse checkout applied?`,
						10_000,
					);
					continue;
				}

				// Hard-link mirror approach: create a real directory in the vault
				// containing hard links to every file in the sparse source folder.
				// Obsidian doesn't follow junctions, but it indexes hard-linked
				// files normally (they look like regular files to the OS).
				const wasJunction = isJunction(linkAbs);
				const linkRootExisted = fs.existsSync(linkAbs);

				const mirrorResult: MirrorResult = ensureMirror(linkAbs, targetAbs);

				let status: ReconcileResult;
				if (!linkRootExisted || wasJunction) {
					status = 'created';
				} else if (mirrorResult.linkedCount > 0 || mirrorResult.removedCount > 0) {
					status = 'repaired';
				} else {
					status = 'ok';
				}
				results.set(aliasVaultPath, status);
				DebugLogger.log('Junctions', `Mirror ${status}`, {
					sparsePath, alias: aliasVaultPath,
					linked: mirrorResult.linkedCount,
					removed: mirrorResult.removedCount,
					dirsCreated: mirrorResult.dirsCreated,
				});
			} catch (e) {
				const msg = e instanceof Error ? e.message : String(e);
				results.set(aliasVaultPath, 'error');
				DebugLogger.error('Junctions', 'Mirror reconcile failed', { aliasVaultPath, error: msg });
				new Notice(`Mirror "${aliasVaultPath}" failed: ${msg}`, 10_000);
			}
		}

		return results;
	}

	private targetExists(absPath: string): boolean {
		try {
			return fs.existsSync(absPath) && fs.statSync(absPath).isDirectory();
		} catch {
			return false;
		}
	}

	/**
	 * Remove every mirror (or legacy junction) for this repo. Does not
	 * touch the clone — hard links share inodes with source files, so
	 * removing the mirror only deletes the *additional* directory entries,
	 * not the underlying file content.
	 */
	async removeAll(config: SubTreeConfig): Promise<void> {
		if (!config.hiddenClone) return;
		for (const aliasVaultPath of Object.values(config.hiddenClone.aliases)) {
			const linkAbs = this.toAbs(aliasVaultPath);
			try {
				removeMirror(linkAbs);
				DebugLogger.log('Junctions', 'mirror removed', { alias: aliasVaultPath });
			} catch (e) {
				DebugLogger.warn('Junctions', 'remove failed', { aliasVaultPath, error: String(e) });
			}
		}
	}

	/**
	 * Translate a vault-relative path under a junction into the equivalent
	 * repo-relative path inside the clone.
	 *
	 *   alias: docs/cs/analysis -> Dokumentace/PnB - analysis
	 *   "Dokumentace/PnB - analysis/foo.md" -> "docs/cs/analysis/foo.md"
	 *
	 * Returns null when the path is not under any alias for this repo.
	 */
	vaultPathToRepoRelative(config: SubTreeConfig, vaultRelPath: string): string | null {
		if (!this.isActiveFor(config) || !config.hiddenClone) return null;
		const normalized = normalizePath(vaultRelPath).replace(/^\/+/, '');

		// Sort aliases by length desc so longer (more specific) ones match first
		const entries = Object.entries(config.hiddenClone.aliases)
			.map(([sp, alias]) => [sp, normalizePath(alias).replace(/^\/+|\/+$/g, '')] as [string, string])
			.sort((a, b) => b[1].length - a[1].length);

		for (const [sparsePath, aliasVault] of entries) {
			if (normalized === aliasVault) return sparsePath;
			if (normalized.startsWith(aliasVault + '/')) {
				const tail = normalized.substring(aliasVault.length + 1);
				return `${sparsePath}/${tail}`;
			}
		}
		return null;
	}

	/**
	 * Inverse: translate a repo-relative path (under one of the sparse
	 * paths) into the vault-relative path Obsidian would render.
	 *
	 *   alias: docs/cs/analysis -> Dokumentace/PnB - analysis
	 *   "docs/cs/analysis/foo.md" -> "Dokumentace/PnB - analysis/foo.md"
	 *
	 * Returns null if the path isn't covered by any alias.
	 */
	repoRelativeToVaultPath(config: SubTreeConfig, repoRelPath: string): string | null {
		if (!this.isActiveFor(config) || !config.hiddenClone) return null;
		const normalized = repoRelPath.replace(/\\/g, '/').replace(/^\/+/, '');

		// Sort sparse paths by length desc so longer ones match first
		const entries = Object.entries(config.hiddenClone.aliases)
			.sort((a, b) => b[0].length - a[0].length);

		for (const [sparsePath, aliasVault] of entries) {
			const aliasNorm = normalizePath(aliasVault).replace(/^\/+|\/+$/g, '');
			if (normalized === sparsePath) return aliasNorm;
			if (normalized.startsWith(sparsePath + '/')) {
				const tail = normalized.substring(sparsePath.length + 1);
				return `${aliasNorm}/${tail}`;
			}
		}
		return null;
	}

	/**
	 * Every vault-relative path that this repo claims (its junction roots).
	 * Used by ownership checks like findRepoForFile.
	 */
	listVaultRoots(config: SubTreeConfig): string[] {
		if (!this.isActiveFor(config) || !config.hiddenClone) {
			return [config.localPath];
		}
		return Object.values(config.hiddenClone.aliases).map(p =>
			normalizePath(p).replace(/^\/+|\/+$/g, ''),
		);
	}
}
