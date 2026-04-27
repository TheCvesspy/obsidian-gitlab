/**
 * Validation utilities for repository configuration
 */

import { SubTreeConfig } from '../types';

/**
 * Validate GitLab repository URL
 */
export function validateRepositoryUrl(url: string): { valid: boolean; error?: string } {
	if (!url || url.trim().length === 0) {
		return { valid: false, error: 'Repository URL is required' };
	}
	
	// Check if it's a valid HTTPS URL
	try {
		const parsed = new URL(url);
		if (parsed.protocol !== 'https:') {
			return { valid: false, error: 'Repository URL must use HTTPS protocol' };
		}
		
		// Check if URL has a valid path (should have at least /group/project or /user/project)
		const pathParts = parsed.pathname.split('/').filter(p => p.length > 0);
		if (pathParts.length < 2) {
			return { valid: false, error: 'Repository URL should include project path (e.g., https://gitlab.com/user/project.git)' };
		}
		
		// Accept any HTTPS URL with proper path structure
		// Works for gitlab.com, self-hosted GitLab instances, and company GitLab servers
		return { valid: true };
	} catch (e) {
		return { valid: false, error: 'Invalid URL format' };
	}
}

/**
 * Validate GitLab personal access token format
 */
export function validateToken(token: string): { valid: boolean; error?: string } {
	if (!token || token.trim().length === 0) {
		return { valid: false, error: 'Access token is required' };
	}
	
	// GitLab personal access tokens start with 'glpat-' (newer) or can be other formats
	// We'll just check minimum length
	if (token.length < 20) {
		return { valid: false, error: 'Token appears to be too short' };
	}
	
	return { valid: true };
}

/**
 * Validate local path
 */
export function validateLocalPath(path: string): { valid: boolean; error?: string } {
	if (!path || path.trim().length === 0) {
		return { valid: false, error: 'Local path is required' };
	}
	
	// Check for invalid characters
	const invalidChars = /[<>"|?*\x00-\x1F]/;
	if (invalidChars.test(path)) {
		return { valid: false, error: 'Path contains invalid characters' };
	}
	
	// Check for absolute path (should be relative to vault)
	if (path.match(/^[A-Za-z]:[/\\]/) || path.startsWith('/')) {
		return { valid: false, error: 'Path should be relative to vault root' };
	}
	
	return { valid: true };
}

/**
 * Validate branch name
 */
export function validateBranchName(branch: string): { valid: boolean; error?: string } {
	if (!branch || branch.trim().length === 0) {
		return { valid: false, error: 'Branch name is required' };
	}
	
	// Git branch naming rules
	const invalidPattern = /[~^: \\?*\[]/;
	if (invalidPattern.test(branch)) {
		return { valid: false, error: 'Branch name contains invalid characters' };
	}
	
	if (branch.startsWith('.') || branch.endsWith('.')) {
		return { valid: false, error: 'Branch name cannot start or end with a dot' };
	}
	
	if (branch.includes('..')) {
		return { valid: false, error: 'Branch name cannot contain consecutive dots' };
	}
	
	if (branch.endsWith('.lock')) {
		return { valid: false, error: 'Branch name cannot end with .lock' };
	}
	
	return { valid: true };
}

/**
 * Validate complete repository configuration
 */
export function validateRepositoryConfig(config: Partial<SubTreeConfig>): { valid: boolean; errors: string[] } {
	const errors: string[] = [];
	
	if (!config.name || config.name.trim().length === 0) {
		errors.push('Repository name is required');
	}
	
	const urlValidation = validateRepositoryUrl(config.repositoryUrl || '');
	if (!urlValidation.valid) {
		errors.push(urlValidation.error!);
	}
	
	const tokenValidation = validateToken(config.token || '');
	if (!tokenValidation.valid) {
		errors.push(tokenValidation.error!);
	}
	
	const pathValidation = validateLocalPath(config.localPath || '');
	if (!pathValidation.valid) {
		errors.push(pathValidation.error!);
	}
	
	const branchValidation = validateBranchName(config.currentBranch || '');
	if (!branchValidation.valid) {
		errors.push(branchValidation.error!);
	}
	
	return {
		valid: errors.length === 0,
		errors
	};
}

/**
 * Generate a unique ID for a repository
 */
export function generateRepositoryId(name: string): string {
	const sanitized = name
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-|-$/g, '');
	
	const timestamp = Date.now().toString(36);
	return `${sanitized}-${timestamp}`;
}

/**
 * Extract repository name from GitLab URL
 */
export function extractRepoNameFromUrl(url: string): string {
	try {
		const parsed = new URL(url);
		const pathParts = parsed.pathname.split('/').filter(p => p);
		
		if (pathParts.length >= 2) {
			// Get the last part and remove .git if present
			const repoName = pathParts[pathParts.length - 1].replace(/\.git$/, '');
			return repoName;
		}
		
		return 'repository';
	} catch (e) {
		return 'repository';
	}
}
