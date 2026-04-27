/**
 * Utility functions for path operations
 */

/**
 * Normalize path separators to forward slashes
 */
export function normalizePath(path: string): string {
	return path.replace(/\\/g, '/');
}

/**
 * Remove trailing slashes from path
 */
export function removeTrailingSlash(path: string): string {
	return path.replace(/\/$/, '');
}

/**
 * Join path segments
 */
export function joinPath(...segments: string[]): string {
	return segments
		.map(s => s.replace(/^\/|\/$/g, ''))
		.filter(s => s.length > 0)
		.join('/');
}

/**
 * Get relative path from base to target
 */
export function getRelativePath(base: string, target: string): string {
	const baseParts = normalizePath(base).split('/').filter(p => p);
	const targetParts = normalizePath(target).split('/').filter(p => p);
	
	let commonLength = 0;
	for (let i = 0; i < Math.min(baseParts.length, targetParts.length); i++) {
		if (baseParts[i] === targetParts[i]) {
			commonLength++;
		} else {
			break;
		}
	}
	
	const upSteps = baseParts.length - commonLength;
	const remainingPath = targetParts.slice(commonLength);
	
	const relativeParts = new Array(upSteps).fill('..').concat(remainingPath);
	return relativeParts.join('/');
}

/**
 * Check if a path is within another path
 */
export function isPathWithin(childPath: string, parentPath: string): boolean {
	const normalizedChild = normalizePath(removeTrailingSlash(childPath));
	const normalizedParent = normalizePath(removeTrailingSlash(parentPath));
	
	if (normalizedChild === normalizedParent) {
		return true;
	}
	
	return normalizedChild.startsWith(normalizedParent + '/');
}

/**
 * Check if two paths overlap (one contains the other)
 */
export function pathsOverlap(path1: string, path2: string): boolean {
	return isPathWithin(path1, path2) || isPathWithin(path2, path1);
}

/**
 * Get the parent directory of a path
 */
export function getParentPath(path: string): string {
	const normalized = normalizePath(removeTrailingSlash(path));
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash === -1) {
		return '';
	}
	return normalized.substring(0, lastSlash);
}

/**
 * Get the filename from a path
 */
export function getFileName(path: string): string {
	const normalized = normalizePath(path);
	const lastSlash = normalized.lastIndexOf('/');
	if (lastSlash === -1) {
		return normalized;
	}
	return normalized.substring(lastSlash + 1);
}

/**
 * Ensure path starts with vault root marker
 */
export function ensureVaultRelative(path: string, vaultPath: string): string {
	const normalized = normalizePath(path);
	const normalizedVault = normalizePath(vaultPath);
	
	if (normalized.startsWith(normalizedVault)) {
		return normalized.substring(normalizedVault.length).replace(/^\//, '');
	}
	
	return normalized;
}
