import { GitFile, FileStatus } from '../types';

/**
 * Parse `git status --porcelain=v2` output into GitFile[].
 *
 * Porcelain v2 line formats:
 *   1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>              — ordinary change
 *   2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>  — rename/copy
 *   u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>    — unmerged
 *   ? <path>                                                     — untracked
 *   ! <path>                                                     — ignored
 *
 * XY codes: first char = index status, second char = worktree status.
 *   '.' = not modified, 'M' = modified, 'A' = added, 'D' = deleted,
 *   'R' = renamed, 'C' = copied, 'U' = unmerged, '?' = untracked, '!' = ignored
 */
export function parseStatusV2(output: string): GitFile[] {
	const files: GitFile[] = [];
	if (!output.trim()) return files;

	const lines = output.split('\n');

	for (const line of lines) {
		if (!line) continue;

		const type = line[0];

		if (type === '1') {
			const parsed = parseOrdinaryEntry(line);
			if (parsed) files.push(...parsed);
		} else if (type === '2') {
			const parsed = parseRenameEntry(line);
			if (parsed) files.push(...parsed);
		} else if (type === 'u') {
			const parsed = parseUnmergedEntry(line);
			if (parsed) files.push(parsed);
		} else if (type === '?') {
			files.push({
				path: line.substring(2),
				status: FileStatus.UNTRACKED,
				staged: false,
			});
		} else if (type === '!') {
			files.push({
				path: line.substring(2),
				status: FileStatus.IGNORED,
				staged: false,
			});
		}
	}

	return files;
}

function parseOrdinaryEntry(line: string): GitFile[] | null {
	// 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
	const parts = line.split(' ');
	if (parts.length < 9) return null;

	const xy = parts[1];
	const indexStatus = xy[0];
	const worktreeStatus = xy[1];
	// Path is everything after the 8th space
	const pathStart = nthIndex(line, ' ', 8);
	if (pathStart === -1) return null;
	const filePath = line.substring(pathStart + 1);

	const results: GitFile[] = [];

	if (indexStatus !== '.') {
		results.push({
			path: filePath,
			status: xyCharToStatus(indexStatus),
			staged: true,
		});
	}

	if (worktreeStatus !== '.') {
		results.push({
			path: filePath,
			status: xyCharToStatus(worktreeStatus),
			staged: false,
		});
	}

	return results.length > 0 ? results : null;
}

function parseRenameEntry(line: string): GitFile[] | null {
	// 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path>\t<origPath>
	const parts = line.split(' ');
	if (parts.length < 10) return null;

	const xy = parts[1];
	const indexStatus = xy[0];
	const worktreeStatus = xy[1];

	// The last token contains <path>\t<origPath>
	const pathStart = nthIndex(line, ' ', 9);
	if (pathStart === -1) return null;
	const pathPart = line.substring(pathStart + 1);
	const tabIdx = pathPart.indexOf('\t');
	if (tabIdx === -1) return null;

	const newPath = pathPart.substring(0, tabIdx);
	const oldPath = pathPart.substring(tabIdx + 1);

	const results: GitFile[] = [];

	if (indexStatus !== '.') {
		results.push({
			path: newPath,
			status: indexStatus === 'R' ? FileStatus.RENAMED : FileStatus.COPIED,
			staged: true,
			oldPath,
		});
	}

	if (worktreeStatus !== '.') {
		results.push({
			path: newPath,
			status: xyCharToStatus(worktreeStatus),
			staged: false,
			oldPath,
		});
	}

	return results.length > 0 ? results : null;
}

function parseUnmergedEntry(line: string): GitFile | null {
	// u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
	const pathStart = nthIndex(line, ' ', 10);
	if (pathStart === -1) return null;
	const filePath = line.substring(pathStart + 1);

	return {
		path: filePath,
		status: FileStatus.CONFLICTED,
		staged: false,
	};
}

function xyCharToStatus(c: string): FileStatus {
	switch (c) {
		case 'M': return FileStatus.MODIFIED;
		case 'A': return FileStatus.ADDED;
		case 'D': return FileStatus.DELETED;
		case 'R': return FileStatus.RENAMED;
		case 'C': return FileStatus.COPIED;
		case 'T': return FileStatus.MODIFIED; // type change
		case 'U': return FileStatus.CONFLICTED;
		default:  return FileStatus.MODIFIED;
	}
}

function nthIndex(str: string, char: string, n: number): number {
	let idx = -1;
	for (let i = 0; i < n; i++) {
		idx = str.indexOf(char, idx + 1);
		if (idx === -1) return -1;
	}
	return idx;
}
