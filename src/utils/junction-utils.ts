/**
 * Filesystem junction operations (Windows-only).
 *
 * Directory junctions are NTFS reparse points that act as transparent aliases:
 * reads, writes, and watches against a junction transparently target the real
 * directory. We use them to surface sparse-checkout paths at user-chosen vault
 * locations while keeping the actual git clone hidden.
 *
 * Why junctions over symlinks: junctions don't require admin privileges or
 * Developer Mode, work for any local NTFS folder, and Node.js treats them
 * identically to symlinks for lstat/readlink purposes.
 */

import { execFile } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export function isJunctionSupported(): boolean {
	return process.platform === 'win32';
}

/**
 * True iff `absPath` exists and is a junction (or symlink — they're treated
 * identically by Node on Windows).
 */
export function isJunction(absPath: string): boolean {
	try {
		const stat = fs.lstatSync(absPath);
		return stat.isSymbolicLink();
	} catch {
		return false;
	}
}

/**
 * Read a junction's target. Returns null if the path isn't a junction or
 * isn't readable. The returned path is what mklink stored — may be absolute
 * or relative depending on how it was created.
 */
export function readJunctionTarget(absPath: string): string | null {
	try {
		if (!isJunction(absPath)) return null;
		const target = fs.readlinkSync(absPath);
		// On Windows, junction targets are returned with a `\\?\` prefix.
		// Strip it for cleaner comparison.
		return target.replace(/^\\\\\?\\/, '');
	} catch {
		return null;
	}
}

/**
 * Compare two filesystem paths for equality after normalizing slashes and
 * stripping any `\\?\` long-path prefix. Case-insensitive on Windows.
 */
export function pathsEqual(a: string, b: string): boolean {
	const norm = (p: string) =>
		p.replace(/^\\\\\?\\/, '').replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
	return norm(a) === norm(b);
}

/**
 * Ensure a directory junction exists at `linkAbs` pointing at `targetAbs`.
 *
 * - No-op if the link already exists and points to `targetAbs`.
 * - Throws if `linkAbs` exists as a real folder (caller must resolve).
 * - Throws if `targetAbs` doesn't exist (caller should ensure sparse paths
 *   are checked out first).
 * - Recreates the link if it exists but points elsewhere.
 * - Creates parent directories of `linkAbs` as needed.
 *
 * Uses `cmd /c mklink /J` because that's the only no-privilege way to create
 * a directory junction on Windows. PowerShell's New-Item -ItemType Junction
 * requires admin in some configurations.
 */
export async function ensureJunction(linkAbs: string, targetAbs: string): Promise<void> {
	if (!isJunctionSupported()) {
		throw new Error('Directory junctions are only supported on Windows');
	}
	if (!fs.existsSync(targetAbs)) {
		throw new Error(`Junction target does not exist: ${targetAbs}`);
	}
	const targetStat = fs.statSync(targetAbs);
	if (!targetStat.isDirectory()) {
		throw new Error(`Junction target is not a directory: ${targetAbs}`);
	}

	// Inspect existing link/folder at linkAbs
	let existingLstat: fs.Stats | null = null;
	try { existingLstat = fs.lstatSync(linkAbs); } catch { /* doesn't exist */ }

	if (existingLstat) {
		if (existingLstat.isSymbolicLink()) {
			// Already a link — check target
			const existingTarget = readJunctionTarget(linkAbs);
			if (existingTarget && pathsEqual(existingTarget, targetAbs)) {
				return; // already correct
			}
			// Wrong target — remove and recreate
			await removeJunction(linkAbs);
		} else if (existingLstat.isDirectory()) {
			// Real folder collision — refuse
			throw new Error(
				`Cannot create junction at "${linkAbs}": a real folder exists there. ` +
				`Remove or rename it first.`,
			);
		} else {
			throw new Error(`Cannot create junction at "${linkAbs}": path exists and is not a folder.`);
		}
	}

	// Create parent directories if needed
	const parent = path.dirname(linkAbs);
	if (!fs.existsSync(parent)) {
		fs.mkdirSync(parent, { recursive: true });
	}

	// Run: cmd /c mklink /J "<link>" "<target>"
	await new Promise<void>((resolve, reject) => {
		execFile(
			'cmd.exe',
			['/c', 'mklink', '/J', linkAbs, targetAbs],
			{ windowsHide: true, timeout: 15_000 },
			(error, stdout, stderr) => {
				if (error) {
					const msg = String(stderr || stdout || error.message || error);
					reject(new Error(`mklink failed: ${msg.trim()}`));
				} else {
					resolve();
				}
			},
		);
	});
}

/**
 * Remove a junction. Critically, this deletes the LINK, not the target
 * folder. fs.rmSync handles junctions correctly: it follows the reparse
 * point's "remove the link" semantics rather than recursing into the target.
 *
 * Throws if `linkAbs` is a real folder (caller must decide).
 */
export async function removeJunction(linkAbs: string): Promise<void> {
	if (!fs.existsSync(linkAbs) && !isJunction(linkAbs)) return; // already gone

	const lstat = fs.lstatSync(linkAbs);
	if (lstat.isDirectory() && !lstat.isSymbolicLink()) {
		throw new Error(`Refusing to remove "${linkAbs}": it is a real folder, not a junction.`);
	}

	// fs.rmSync with maxRetries handles transient lock issues on Windows.
	fs.rmSync(linkAbs, { recursive: false, force: true, maxRetries: 3, retryDelay: 100 });
}

export interface MirrorResult {
	linkedCount: number;
	removedCount: number;
	dirsCreated: number;
}

/**
 * Mirror `sourceRoot` into `linkRoot` using NTFS hard links — file-by-file.
 *
 * Why this exists: Obsidian doesn't index directory junctions/reparse points,
 * so the otherwise-elegant junction approach is invisible to its file
 * explorer and quick switcher. Hard-linking each file individually makes the
 * vault see "real" files. Edits through the mirror update the same inode
 * as the clone, so git sees changes transparently — no extra sync needed
 * for in-place edits.
 *
 * Semantics:
 * - `linkRoot` is created as a real directory (replacing any pre-existing
 *   junction at that path).
 * - Every regular file under `sourceRoot` gets a hard link at the matching
 *   path in `linkRoot`. Subdirectories are real dirs (NTFS only hard-links
 *   files, never directories).
 * - Files in `linkRoot` that don't exist in `sourceRoot` are deleted as
 *   stale mirror artifacts.
 * - Files that already exist as the correct hard link (same inode) are left
 *   alone — re-mirroring is cheap.
 *
 * Constraints:
 * - Both paths MUST be on the same NTFS volume (we satisfy this — both
 *   live under the vault directory).
 * - Does NOT mirror back: files created directly under `linkRoot` outside
 *   this function will appear stale and get removed on the next mirror call.
 *   Callers that want bidirectional sync must promote new files into the
 *   source first.
 */
export function ensureMirror(linkRoot: string, sourceRoot: string): MirrorResult {
	const result: MirrorResult = { linkedCount: 0, removedCount: 0, dirsCreated: 0 };

	if (!fs.existsSync(sourceRoot)) {
		throw new Error(`Mirror source does not exist: ${sourceRoot}`);
	}
	const sourceStat = fs.statSync(sourceRoot);
	if (!sourceStat.isDirectory()) {
		throw new Error(`Mirror source is not a directory: ${sourceRoot}`);
	}

	// If linkRoot is currently a junction from a previous version, remove it
	// (synchronously) so we can create a real directory in its place.
	if (isJunction(linkRoot)) {
		fs.rmSync(linkRoot, { recursive: false, force: true, maxRetries: 3, retryDelay: 100 });
	}

	if (!fs.existsSync(linkRoot)) {
		fs.mkdirSync(linkRoot, { recursive: true });
		result.dirsCreated++;
	}

	const expectedFiles = new Set<string>(); // absolute paths under linkRoot

	const walk = (relativePath: string) => {
		const srcDir = relativePath ? path.join(sourceRoot, relativePath) : sourceRoot;
		const linkDir = relativePath ? path.join(linkRoot, relativePath) : linkRoot;

		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(srcDir, { withFileTypes: true }); } catch { return; }

		if (!fs.existsSync(linkDir)) {
			fs.mkdirSync(linkDir, { recursive: true });
			result.dirsCreated++;
		}

		for (const entry of entries) {
			const childRel = relativePath ? `${relativePath}${path.sep}${entry.name}` : entry.name;
			const srcChild = path.join(sourceRoot, childRel);
			const linkChild = path.join(linkRoot, childRel);

			if (entry.isDirectory()) {
				walk(childRel);
			} else if (entry.isFile()) {
				expectedFiles.add(linkChild);

				let needsLink = true;
				if (fs.existsSync(linkChild)) {
					try {
						const linkStat = fs.statSync(linkChild);
						const srcStat = fs.statSync(srcChild);
						// Same inode + device = already the same file (hard-linked correctly)
						if (linkStat.ino === srcStat.ino && linkStat.dev === srcStat.dev && linkStat.ino !== 0) {
							needsLink = false;
						} else {
							// Different content — remove and re-link
							fs.unlinkSync(linkChild);
						}
					} catch {
						try { fs.unlinkSync(linkChild); } catch { /* ignore */ }
					}
				}

				if (needsLink) {
					try {
						fs.linkSync(srcChild, linkChild);
						result.linkedCount++;
					} catch (e) {
						// Swallow — caller may want to log but we don't want one bad file
						// to abort the whole mirror operation.
					}
				}
			}
			// Skip junctions/symlinks/special files
		}
	};

	walk('');

	// Sweep stale entries — anything in linkRoot not in expectedFiles
	const sweep = (dir: string) => {
		let entries: fs.Dirent[];
		try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
		for (const entry of entries) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				sweep(full);
				// Remove empty directory afterwards
				try {
					if (fs.readdirSync(full).length === 0) {
						fs.rmdirSync(full);
					}
				} catch { /* ignore */ }
			} else if (entry.isFile()) {
				if (!expectedFiles.has(full)) {
					try {
						fs.unlinkSync(full);
						result.removedCount++;
					} catch { /* ignore */ }
				}
			}
		}
	};
	sweep(linkRoot);

	return result;
}

/**
 * Tear down a mirror by deleting the entire mirror directory tree.
 * This removes the hard links but does NOT delete the source files (their
 * inode still has a reference from the source path).
 */
export function removeMirror(linkRoot: string): void {
	if (!fs.existsSync(linkRoot)) return;
	const stat = fs.lstatSync(linkRoot);
	if (stat.isSymbolicLink()) {
		// Legacy junction — remove the link only
		fs.rmSync(linkRoot, { recursive: false, force: true, maxRetries: 3, retryDelay: 100 });
		return;
	}
	if (!stat.isDirectory()) {
		throw new Error(`Refusing to remove "${linkRoot}": not a directory.`);
	}
	// Real directory — recursive delete is OK because contents are hard links
	// to files in the source; removing them won't remove the source files.
	fs.rmSync(linkRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}
