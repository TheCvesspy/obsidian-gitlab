/**
 * AssetMover — moves out-of-repo image files into the repo's assets
 * folder using Obsidian's native APIs, so that every reference in the
 * vault is rewritten automatically (via app.fileManager.renameFile).
 *
 * Mobile-safe: uses only Obsidian APIs (no Node fs).
 */

import { App, TFile, normalizePath } from 'obsidian';
import { DebugLogger } from '../utils/debug-logger';

export class AssetTooLargeError extends Error {
	constructor(public readonly vaultPath: string, public readonly size: number, public readonly limit: number) {
		super(`Asset too large: ${vaultPath} is ${size} bytes (limit ${limit})`);
		this.name = 'AssetTooLargeError';
	}
}

export class AssetMoveError extends Error {
	constructor(public readonly vaultPath: string, public readonly cause: unknown) {
		super(`Failed to move asset ${vaultPath}: ${String(cause)}`);
		this.name = 'AssetMoveError';
	}
}

interface MoveRecord {
	from: string;
	to: string;
}

export class AssetMover {
	private app: App;
	private assetsFolderRel: string;
	private assetsFolderVault: string;
	private maxBytes: number;
	private onAfterMove?: (vaultPath: string, repoRelPath: string) => Promise<void>;

	/** Cache so the same source file is only moved once per run. */
	private cache = new Map<string, string>(); // source vault path -> new vault path
	private moves: MoveRecord[] = [];
	private folderEnsured = false;

	/**
	 * @param assetsFolderVault Pre-computed vault-relative path of the assets folder.
	 *   In normal mode: `<repo localPath>/<assetsFolderRel>`. In hidden-clone mode:
	 *   the alias path that maps to the assets folder (caller resolves this).
	 * @param assetsFolderRel  Repo-root-relative path of the assets folder (for
	 *   producing repo-relative paths in `movedRepoRelPaths()`).
	 * @param onAfterMove Optional hook fired after each successful move with
	 *   (newVaultPath, repoRelPath). Used by the hidden-clone pipeline to
	 *   hard-link the new file to its clone counterpart.
	 */
	constructor(
		app: App,
		assetsFolderVault: string,
		assetsFolderRel: string,
		maxBytes: number,
		onAfterMove?: (vaultPath: string, repoRelPath: string) => Promise<void>,
	) {
		this.app = app;
		this.assetsFolderRel = assetsFolderRel.replace(/^\/+|\/+$/g, '') || 'assets';
		this.assetsFolderVault = assetsFolderVault.replace(/\/+$/, '');
		this.maxBytes = maxBytes;
		this.onAfterMove = onAfterMove;
	}

	/**
	 * Move an out-of-repo image into the repo's assets folder. Caller is
	 * responsible for ensuring `sourceFile` is actually outside the repo.
	 */
	async moveIntoRepo(sourceFile: TFile): Promise<{ newVaultPath: string; movedFromVaultPath: string }> {
		const fromPath = sourceFile.path;

		const cached = this.cache.get(fromPath);
		if (cached) {
			return { newVaultPath: cached, movedFromVaultPath: fromPath };
		}

		// Size guard — cheap, no bytes loaded.
		const size = sourceFile.stat?.size ?? 0;
		if (size > this.maxBytes) {
			throw new AssetTooLargeError(fromPath, size, this.maxBytes);
		}

		await this.ensureAssetsFolder();

		const targetPath = await this.pickTargetPath(sourceFile);

		try {
			await this.app.fileManager.renameFile(sourceFile, targetPath);
		} catch (e) {
			throw new AssetMoveError(fromPath, e);
		}
		this.moves.push({ from: fromPath, to: targetPath });
		this.cache.set(fromPath, targetPath);

		// Post-move hook (used by hidden-clone mode to hard-link the new file
		// from the alias path into the clone so git sees it).
		if (this.onAfterMove) {
			const repoRel = this.targetToRepoRel(targetPath);
			try {
				await this.onAfterMove(targetPath, repoRel);
			} catch (e) {
				DebugLogger.warn('AssetMover', 'onAfterMove hook failed', { targetPath, error: String(e) });
			}
		}

		return { newVaultPath: targetPath, movedFromVaultPath: fromPath };
	}

	/**
	 * Convert a vault path inside the assets folder back to a repo-root-relative
	 * path. Replaces the vault-prefix with the repo-relative assets folder.
	 */
	private targetToRepoRel(vaultPath: string): string {
		const vaultPrefix = this.assetsFolderVault + '/';
		if (vaultPath.startsWith(vaultPrefix)) {
			const remainder = vaultPath.slice(vaultPrefix.length);
			return this.assetsFolderRel ? `${this.assetsFolderRel}/${remainder}` : remainder;
		}
		return vaultPath;
	}

	/**
	 * Pick a target vault path for the source file. Prefers the original
	 * basename. If a different file already exists at that path, falls
	 * back to a content-hash-suffixed variant. Byte-identical existing
	 * files at the target are NOT treated as dedupe candidates here:
	 * Obsidian's API does not let us safely repoint links from one file
	 * to another, so we instead create a hashed sibling — the cost is one
	 * extra duplicate file in the repo, the benefit is no broken links.
	 */
	private async pickTargetPath(sourceFile: TFile): Promise<string> {
		const name = sourceFile.name;
		const initial = normalizePath(`${this.assetsFolderVault}/${name}`);
		const existing = this.app.vault.getAbstractFileByPath(initial);
		if (!existing) return initial;

		// Need a unique hashed name.
		const bytes = await this.app.vault.adapter.readBinary(sourceFile.path);
		const hash = await shortContentHash(bytes);
		const dot = name.lastIndexOf('.');
		const hashed = dot > 0 ? `${name.slice(0, dot)}.${hash}${name.slice(dot)}` : `${name}.${hash}`;

		let unique = normalizePath(`${this.assetsFolderVault}/${hashed}`);
		let counter = 1;
		while (this.app.vault.getAbstractFileByPath(unique)) {
			const dot2 = hashed.lastIndexOf('.');
			const numbered =
				dot2 > 0
					? `${hashed.slice(0, dot2)}-${counter}${hashed.slice(dot2)}`
					: `${hashed}-${counter}`;
			unique = normalizePath(`${this.assetsFolderVault}/${numbered}`);
			counter++;
		}
		return unique;
	}

	private async ensureAssetsFolder(): Promise<void> {
		if (this.folderEnsured) return;
		const existing = this.app.vault.getAbstractFileByPath(this.assetsFolderVault);
		if (!existing) {
			try {
				await this.app.vault.createFolder(this.assetsFolderVault);
			} catch (e) {
				const msg = String(e);
				if (!/exist/i.test(msg)) {
					throw e;
				}
			}
		}
		this.folderEnsured = true;
	}

	/**
	 * Best-effort rollback: undo every successful move in LIFO order.
	 * Used when the pipeline aborts after partial progress.
	 */
	async rollback(): Promise<void> {
		while (this.moves.length) {
			const m = this.moves.pop()!;
			const file = this.app.vault.getAbstractFileByPath(m.to);
			if (file instanceof TFile) {
				try {
					await this.app.fileManager.renameFile(file, m.from);
				} catch (e) {
					DebugLogger.warn('AssetMover', 'Rollback rename failed', {
						from: m.to,
						to: m.from,
						error: String(e),
					});
				}
			}
		}
		this.cache.clear();
	}

	/** Repo-relative POSIX paths of every successful move this run. */
	movedRepoRelPaths(): string[] {
		return this.moves.map((m) => this.targetToRepoRel(m.to));
	}
}

async function shortContentHash(bytes: ArrayBuffer): Promise<string> {
	try {
		const digest = await crypto.subtle.digest('SHA-256', bytes);
		const arr = new Uint8Array(digest);
		let hex = '';
		for (let i = 0; i < 4; i++) {
			hex += arr[i].toString(16).padStart(2, '0');
		}
		return hex;
	} catch {
		const view = new Uint8Array(bytes);
		let h = 0x811c9dc5;
		for (let i = 0; i < view.length; i++) {
			h ^= view[i];
			h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
		}
		return h.toString(16).padStart(8, '0').slice(0, 8);
	}
}
