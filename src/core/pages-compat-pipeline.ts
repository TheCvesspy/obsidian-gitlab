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
import { SubTreeConfig } from '../types';
import { GitOperations, IndexOverrideSnapshot } from '../api/git-operations';
import {
	applyTransforms,
	collectImageLinkNames,
	ImageResolver,
	WikiLinkResolver,
	TransformWarning,
} from '../utils/gitlab-pages-transform';
import { AssetMover, AssetTooLargeError, AssetMoveError } from './asset-mover';
import { DebugLogger } from '../utils/debug-logger';

interface PluginLike {
	app: App;
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
	private gitOps: GitOperations;
	private repoVaultPath: string;
	private assetsFolder: string;
	private maxAssetBytes: number;

	constructor(plugin: PluginLike, repo: SubTreeConfig, gitOps: GitOperations) {
		this.app = plugin.app;
		this.repo = repo;
		this.gitOps = gitOps;
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
		const mover = new AssetMover(this.app, this.repoVaultPath, this.assetsFolder, this.maxAssetBytes);
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

					const linkNames = collectImageLinkNames(original);
					for (const linkName of linkNames) {
						const dest = this.app.metadataCache.getFirstLinkpathDest(linkName, vaultMdPath);
						if (!dest) {
							failures.push({ mdPath: vaultMdPath, linkName, reason: 'image not found in vault' });
							continue;
						}
						if (this.isInsideRepo(dest.path)) continue;

						try {
							await mover.moveIntoRepo(dest);
						} catch (e) {
							failures.push({
								mdPath: vaultMdPath,
								linkName,
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
		return this.repoVaultPath ? `${this.repoVaultPath}/${repoRelPath}` : repoRelPath;
	}

	private vaultToRepo(vaultPath: string): string {
		if (!this.repoVaultPath) return vaultPath;
		const prefix = this.repoVaultPath + '/';
		return vaultPath.startsWith(prefix) ? vaultPath.slice(prefix.length) : vaultPath;
	}

	private isInsideRepo(vaultPath: string): boolean {
		if (!this.repoVaultPath) return true;
		return vaultPath === this.repoVaultPath || vaultPath.startsWith(this.repoVaultPath + '/');
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
