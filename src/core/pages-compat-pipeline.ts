/**
 * GitLab Pages compatibility pipeline.
 *
 * Two-pass design:
 *
 *   Pass 1 — discovery + move. For every staged .md, scan for image
 *   links. Out-of-repo images are MOVED into the repo's assets folder
 *   via app.fileManager.renameFile, which simultaneously rewrites every
 *   reference to them in the entire vault (including notes that are not
 *   currently staged). After this pass, every image referenced from any
 *   staged note is already inside the repo.
 *
 *   Pass 2 — transform. Re-read each staged .md and run the pure
 *   transforms (image relativization, wiki link rewriting, callouts).
 *   The result is spliced into the Git index via IndexOverrideSnapshot.
 *
 * If any image fails to move (size limit, missing file, write error)
 * the pipeline aborts: every successful move from this run is rolled
 * back, and a PagesCompatTransformError is thrown for the UI layer to
 * surface to the user. The commit does not happen.
 */

import { App, TFile, normalizePath } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { SubTreeConfig } from '../types';
import type { IGitBackend, IndexOverrideSnapshot } from '../api/git-backend';
import {
	applyTransforms,
	collectImageLinkRefs,
	ImageResolver,
	WikiLinkResolver,
	TransformWarning,
} from '../utils/gitlab-pages-transform';
import { AssetMover, AssetTooLargeError, AssetMoveError } from './asset-mover';
import { JunctionManager } from './junction-manager';
import { DebugLogger } from '../utils/debug-logger';

interface PluginLike {
	app: App;
	junctionManager?: JunctionManager;
}

const DEFAULT_ASSETS_FOLDER = 'assets';
const DEFAULT_MAX_ASSET_BYTES = 10 * 1024 * 1024;

export interface TransformFailure {
	mdPath: string;
	linkName: string;
	reason: string;
}

export class PagesCompatTransformError extends Error {
	constructor(public readonly failures: TransformFailure[]) {
		super(
			`GitLab Pages compat pipeline failed: ${failures.length} image(s) could not be processed`,
		);
		this.name = 'PagesCompatTransformError';
	}
}

export class PagesCompatPipeline {
	private app: App;
	private repo: SubTreeConfig;
	private gitOps: IGitBackend;
	private repoVaultPath: string;
	private assetsFolder: string;
	private maxAssetBytes: number;
	private junctionMgr: JunctionManager | null;
	private hiddenCloneActive: boolean;

	constructor(plugin: PluginLike, repo: SubTreeConfig, gitOps: IGitBackend) {
		this.app = plugin.app;
		this.repo = repo;
		this.gitOps = gitOps;
		this.junctionMgr = plugin.junctionManager ?? null;
		this.hiddenCloneActive = !!this.junctionMgr?.isActiveFor(repo);
		this.repoVaultPath = normalizePath(repo.localPath).replace(/\/+$/, '');
		this.assetsFolder = (repo.gitlabPagesCompat?.assetsFolder || DEFAULT_ASSETS_FOLDER).replace(/\/+$/, '');
		this.maxAssetBytes = repo.gitlabPagesCompat?.maxAssetBytes ?? DEFAULT_MAX_ASSET_BYTES;
	}

	async buildTransformedSnapshot(stagedPaths: string[]): Promise<IndexOverrideSnapshot> {
		const opts = {
			transformImages: this.repo.gitlabPagesCompat?.transformImages !== false,
			transformWikiLinks: this.repo.gitlabPagesCompat?.transformWikiLinks !== false,
			transformCallouts: this.repo.gitlabPagesCompat?.transformCallouts !== false,
		};

		const mdRepoRelPaths = stagedPaths.filter((p) => p.toLowerCase().endsWith('.md'));

		// Compute the vault path of the assets folder. In hidden-clone mode the
		// assets folder lives inside one of the sparse paths; its visible vault
		// location is the alias of that sparse path + the remaining sub-segments.
		// If the assets folder isn't covered by any alias, we fall back to the
		// hidden clone folder itself (Obsidian still indexes hidden vault folders,
		// but the user won't see the moved assets in the file explorer).
		const assetsFolderVault = this.computeAssetsFolderVault();

		const mover = new AssetMover(
			this.app,
			assetsFolderVault,
			this.assetsFolder,
			this.maxAssetBytes,
			this.hiddenCloneActive ? (vaultPath, repoRel) => this.hardLinkToClone(vaultPath, repoRel) : undefined,
		);
		const failures: TransformFailure[] = [];

		try {
			// ---- Pass 1: discovery + move ----
			if (opts.transformImages) {
				for (const repoRelPath of mdRepoRelPaths) {
					const vaultMdPath = this.repoToVault(repoRelPath);
					const mdFile = this.app.vault.getAbstractFileByPath(vaultMdPath);
					if (!(mdFile instanceof TFile)) continue;

					let original: string;
					try {
						original = await this.app.vault.read(mdFile);
					} catch (e) {
						DebugLogger.warn('PagesCompat', 'Failed to read md file (pass 1)', {
							path: vaultMdPath,
							error: String(e),
						});
						continue;
					}

					const linkRefs = collectImageLinkRefs(original);
					for (const ref of linkRefs) {
						const dest = this.resolveImageRef(ref, vaultMdPath);
						if (!dest) {
							// Wiki-style embeds with no dest are real authoring
							// errors — fail. Standard markdown image links can
							// legitimately point at paths Obsidian's link cache
							// doesn't index (correct-by-hand relative paths,
							// images outside the vault, etc.); pass 2 leaves
							// them alone, so pass 1 must too.
							if (ref.kind === 'embed') {
								failures.push({
									mdPath: vaultMdPath,
									linkName: ref.name,
									reason: 'image not found in vault',
								});
							} else {
								DebugLogger.log('PagesCompat', 'Skipping unresolvable md image link', {
									path: vaultMdPath,
									url: ref.name,
								});
							}
							continue;
						}
						if (this.isInsideRepo(dest.path)) continue;

						try {
							await mover.moveIntoRepo(dest);
						} catch (e) {
							failures.push({
								mdPath: vaultMdPath,
								linkName: ref.name,
								reason:
									e instanceof AssetTooLargeError
										? `too large (${e.size} bytes, limit ${e.limit})`
										: e instanceof AssetMoveError
										? `move failed: ${String(e.cause)}`
										: String(e),
							});
						}
					}
				}
			}

			if (failures.length) {
				await mover.rollback();
				throw new PagesCompatTransformError(failures);
			}

			// ---- Pass 2: transform ----
			const files = new Map<string, Uint8Array>();
			const allWarnings: TransformWarning[] = [];

			for (const repoRelPath of mdRepoRelPaths) {
				const vaultMdPath = this.repoToVault(repoRelPath);
				const mdFile = this.app.vault.getAbstractFileByPath(vaultMdPath);
				if (!(mdFile instanceof TFile)) continue;

				let current: string;
				try {
					current = await this.app.vault.read(mdFile);
				} catch (e) {
					DebugLogger.warn('PagesCompat', 'Failed to read md file (pass 2)', {
						path: vaultMdPath,
						error: String(e),
					});
					continue;
				}

				const imageResolver: ImageResolver = (linkName) =>
					this.resolveInRepoImage(linkName, repoRelPath);
				const wikiLinkResolver: WikiLinkResolver = (target) =>
					this.resolveWikiLink(target, repoRelPath);

				const result = applyTransforms(
					current,
					opts,
					{ image: imageResolver, wikiLink: wikiLinkResolver },
					vaultMdPath,
				);

				if (result.warnings.length) allWarnings.push(...result.warnings);
				if (result.content !== current) {
					files.set(repoRelPath, new TextEncoder().encode(result.content));
				}
			}

			if (allWarnings.length) {
				DebugLogger.warn('PagesCompat', 'Transform warnings', { warnings: allWarnings });
			}

			return {
				files,
				addedAssetPaths: mover.movedRepoRelPaths(),
			};
		} catch (e) {
			if (!(e instanceof PagesCompatTransformError)) {
				await mover.rollback();
			}
			throw e;
		}
	}

	/**
	 * Pass-1 image resolution. For wiki-style embeds we go straight through
	 * Obsidian's metadata cache. For standard markdown image links we first
	 * try a relative-path resolution against the source md's vault directory
	 * (Obsidian's cache only indexes by basename / vault-relative path, so a
	 * link like `assets/foo.png` written by hand won't resolve via the cache
	 * but is a perfectly valid relative pointer to a vault file).
	 */
	private resolveImageRef(
		ref: { name: string; kind: 'embed' | 'md' },
		vaultMdPath: string,
	): TFile | null {
		const cacheHit = this.app.metadataCache.getFirstLinkpathDest(ref.name, vaultMdPath);
		if (cacheHit) return cacheHit;
		if (ref.kind !== 'md') return null;

		// Try resolving the url as a path relative to the md file's vault dir.
		const mdDir = vaultMdPath.includes('/') ? vaultMdPath.slice(0, vaultMdPath.lastIndexOf('/')) : '';
		const joined = mdDir ? `${mdDir}/${ref.name}` : ref.name;
		const normalized = normalizePath(joined);
		const af = this.app.vault.getAbstractFileByPath(normalized);
		return af instanceof TFile ? af : null;
	}

	// ---------- resolvers (pass 2: every image is now in-repo) ----------

	private resolveInRepoImage(linkName: string, sourceRepoRelPath: string): string | null {
		const vaultMdPath = this.repoToVault(sourceRepoRelPath);
		const dest = this.app.metadataCache.getFirstLinkpathDest(linkName, vaultMdPath);
		if (!dest) return null;
		if (!this.isInsideRepo(dest.path)) return null; // shouldn't happen after pass 1
		return relativeFromMd(sourceRepoRelPath, this.vaultToRepo(dest.path));
	}

	private resolveWikiLink(target: string, sourceRepoRelPath: string): string | null {
		const vaultMdPath = this.repoToVault(sourceRepoRelPath);
		const dest = this.app.metadataCache.getFirstLinkpathDest(target, vaultMdPath);
		if (!dest) return null;
		if (!this.isInsideRepo(dest.path)) return null;
		return relativeFromMd(sourceRepoRelPath, this.vaultToRepo(dest.path));
	}

	// ---------- path helpers ----------

	private repoToVault(repoRelPath: string): string {
		if (this.hiddenCloneActive && this.junctionMgr) {
			const translated = this.junctionMgr.repoRelativeToVaultPath(this.repo, repoRelPath);
			if (translated) return translated;
			// Fallback: path is inside the clone but outside every alias.
			// Use the hidden clone folder directly (Obsidian still indexes it).
			const cloneVaultRel = this.junctionMgr.getCloneVaultPath(this.repo);
			return `${cloneVaultRel}/${repoRelPath}`;
		}
		return this.repoVaultPath ? `${this.repoVaultPath}/${repoRelPath}` : repoRelPath;
	}

	private vaultToRepo(vaultPath: string): string {
		if (this.hiddenCloneActive && this.junctionMgr) {
			const translated = this.junctionMgr.vaultPathToRepoRelative(this.repo, vaultPath);
			if (translated !== null) return translated;
			// Fallback: maybe the path is under the hidden clone folder
			const cloneVaultRel = this.junctionMgr.getCloneVaultPath(this.repo);
			const prefix = cloneVaultRel + '/';
			if (vaultPath.startsWith(prefix)) return vaultPath.slice(prefix.length);
			return vaultPath;
		}
		if (!this.repoVaultPath) return vaultPath;
		const prefix = this.repoVaultPath + '/';
		return vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
	}

	private isInsideRepo(vaultPath: string): boolean {
		if (this.hiddenCloneActive && this.junctionMgr) {
			if (this.junctionMgr.vaultPathToRepoRelative(this.repo, vaultPath) !== null) return true;
			const cloneVaultRel = this.junctionMgr.getCloneVaultPath(this.repo);
			return vaultPath === cloneVaultRel || vaultPath.startsWith(cloneVaultRel + '/');
		}
		if (!this.repoVaultPath) return true;
		return vaultPath === this.repoVaultPath || vaultPath.startsWith(this.repoVaultPath + '/');
	}

	/**
	 * Compute the vault-relative path of the assets folder. In hidden-clone
	 * mode, this is the alias path + any sub-path remainder; falls back to
	 * the hidden clone folder if the assets folder isn't covered by an alias.
	 */
	private computeAssetsFolderVault(): string {
		if (this.hiddenCloneActive && this.junctionMgr) {
			const translated = this.junctionMgr.repoRelativeToVaultPath(this.repo, this.assetsFolder);
			if (translated) return translated;
			const cloneVaultRel = this.junctionMgr.getCloneVaultPath(this.repo);
			return `${cloneVaultRel}/${this.assetsFolder}`;
		}
		return this.repoVaultPath
			? `${this.repoVaultPath}/${this.assetsFolder}`
			: this.assetsFolder;
	}

	/**
	 * In hidden-clone mode, after the AssetMover renames an image into a vault
	 * folder, the file is at the alias path but NOT yet in the clone — git
	 * won't see it. We hard-link it from the alias path to the corresponding
	 * clone path so the inode is shared and git status picks it up. No-op if
	 * the clone-side path already exists (e.g. file was already in the cone).
	 */
	private async hardLinkToClone(vaultPath: string, repoRelPath: string): Promise<void> {
		if (!this.junctionMgr) return;
		try {
			const basePath = (this.app.vault.adapter as any).basePath as string;
			const aliasAbs = path.join(basePath, vaultPath);
			const cloneAbs = path.join(this.junctionMgr.getCloneAbsPath(this.repo), repoRelPath);

			if (!fs.existsSync(aliasAbs)) {
				DebugLogger.warn('PagesCompat', 'hardLinkToClone: alias path missing', { aliasAbs });
				return;
			}
			if (fs.existsSync(cloneAbs)) {
				// Verify it's already the same inode (no-op) or fail loudly
				try {
					const a = fs.statSync(aliasAbs);
					const c = fs.statSync(cloneAbs);
					if (a.ino === c.ino && a.dev === c.dev) return;
				} catch { /* fall through */ }
				DebugLogger.warn('PagesCompat', 'hardLinkToClone: clone path exists but inode differs', { cloneAbs });
				return;
			}
			// Ensure parent directory exists
			const cloneParent = path.dirname(cloneAbs);
			if (!fs.existsSync(cloneParent)) {
				fs.mkdirSync(cloneParent, { recursive: true });
			}
			fs.linkSync(aliasAbs, cloneAbs);
			DebugLogger.log('PagesCompat', 'Hard-linked asset to clone', { aliasAbs, cloneAbs });
		} catch (e) {
			DebugLogger.warn('PagesCompat', 'hardLinkToClone failed', { error: String(e) });
		}
	}
}

function relativeFromMd(sourceRepoRel: string, targetRepoRel: string): string {
	const sourceParts = sourceRepoRel.split('/').slice(0, -1);
	const targetParts = targetRepoRel.split('/');
	let common = 0;
	while (
		common < sourceParts.length &&
		common < targetParts.length - 1 &&
		sourceParts[common] === targetParts[common]
	) {
		common++;
	}
	const ups = sourceParts.length - common;
	const rel = [...Array(ups).fill('..'), ...targetParts.slice(common)].join('/');
	return rel || targetParts[targetParts.length - 1];
}
