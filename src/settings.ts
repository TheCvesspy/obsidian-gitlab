import { Plugin } from 'obsidian';
import { GitLabPluginSettings, DEFAULT_SETTINGS } from './types';

/**
 * Manages plugin settings storage and retrieval
 */
export class SettingsManager {
	private plugin: Plugin;
	private settings: GitLabPluginSettings;

	constructor(plugin: Plugin) {
		this.plugin = plugin;
		this.settings = { ...DEFAULT_SETTINGS };
	}

	/**
	 * Load settings from Obsidian data storage
	 */
	async loadSettings(): Promise<void> {
		const data = await this.plugin.loadData();
		this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
	}

	/**
	 * Save settings to Obsidian data storage
	 */
	async saveSettings(): Promise<void> {
		await this.plugin.saveData(this.settings);
	}

	/**
	 * Get current settings
	 */
	getSettings(): GitLabPluginSettings {
		return this.settings;
	}

	/**
	 * Update settings
	 */
	updateSettings(newSettings: Partial<GitLabPluginSettings>): void {
		this.settings = Object.assign(this.settings, newSettings);
	}

	/**
	 * Export settings to JSON string
	 */
	exportSettings(): string {
		// Create a copy without sensitive tokens
		const exportData = {
			...this.settings,
			repositories: this.settings.repositories.map(repo => ({
				...repo,
				token: '***REDACTED***' // Don't export tokens
			}))
		};
		return JSON.stringify(exportData, null, 2);
	}

	/**
	 * Import settings from JSON string
	 * @param jsonString JSON string containing settings
	 * @param mergeTokens Whether to preserve existing tokens for matching repositories
	 */
	async importSettings(jsonString: string, mergeTokens = true): Promise<void> {
		try {
			const importedData = JSON.parse(jsonString);
			
			// If merging tokens, preserve tokens from existing repositories
			if (mergeTokens && importedData.repositories) {
				const existingRepos = new Map(
					this.settings.repositories.map(repo => [repo.id, repo.token])
				);
				
				importedData.repositories.forEach((repo: any) => {
					if (repo.token === '***REDACTED***' && existingRepos.has(repo.id)) {
						repo.token = existingRepos.get(repo.id);
					}
				});
			}
			
			this.settings = Object.assign({}, DEFAULT_SETTINGS, importedData);
			await this.saveSettings();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			throw new Error(`Failed to import settings: ${message}`);
		}
	}

	/**
	 * Validate settings
	 */
	validateSettings(): { valid: boolean; errors: string[] } {
		const errors: string[] = [];

		// Check for duplicate repository IDs
		const ids = new Set<string>();
		this.settings.repositories.forEach(repo => {
			if (ids.has(repo.id)) {
				errors.push(`Duplicate repository ID: ${repo.id}`);
			}
			ids.add(repo.id);
		});

		// Collect every vault-relative path each repo claims (localPath for legacy
		// repos, cloneFolder + aliases for hidden-clone repos).
		const claimedPaths: Array<{ repoId: string; path: string; kind: string }> = [];
		for (const repo of this.settings.repositories) {
			if (repo.hiddenClone?.enabled) {
				if (repo.hiddenClone.cloneFolder) {
					claimedPaths.push({ repoId: repo.id, path: repo.hiddenClone.cloneFolder, kind: 'cloneFolder' });
				}
				for (const aliasPath of Object.values(repo.hiddenClone.aliases || {})) {
					if (aliasPath) claimedPaths.push({ repoId: repo.id, path: aliasPath, kind: 'alias' });
				}
				// Reject if this repo's cloneFolder overlaps any of its own aliases —
				// that would create a recursive mess.
				if (repo.hiddenClone.cloneFolder) {
					for (const aliasPath of Object.values(repo.hiddenClone.aliases || {})) {
						if (aliasPath && this.pathsOverlap(repo.hiddenClone.cloneFolder, aliasPath)) {
							errors.push(`Repository ${repo.id}: cloneFolder "${repo.hiddenClone.cloneFolder}" overlaps alias "${aliasPath}"`);
						}
					}
				}
			} else {
				if (repo.localPath) {
					claimedPaths.push({ repoId: repo.id, path: repo.localPath, kind: 'localPath' });
				}
			}
		}

		// Cross-repo overlap check
		for (let i = 0; i < claimedPaths.length; i++) {
			for (let j = i + 1; j < claimedPaths.length; j++) {
				const a = claimedPaths[i];
				const b = claimedPaths[j];
				if (a.repoId === b.repoId && a.kind !== b.kind) continue; // intra-repo handled above
				if (this.pathsOverlap(a.path, b.path)) {
					errors.push(`Overlapping paths: "${a.path}" (${a.repoId}.${a.kind}) and "${b.path}" (${b.repoId}.${b.kind})`);
				}
			}
		}

		// Validate repository configurations
		this.settings.repositories.forEach(repo => {
			if (!repo.name) {
				errors.push(`Repository ${repo.id} missing name`);
			}
			if (!repo.localPath) {
				errors.push(`Repository ${repo.id} missing local path`);
			}
			if (!repo.repositoryUrl) {
				errors.push(`Repository ${repo.id} missing repository URL`);
			}
			if (!repo.token) {
				errors.push(`Repository ${repo.id} missing access token`);
			}
		});

		return {
			valid: errors.length === 0,
			errors
		};
	}

	/**
	 * Check if two paths overlap (one is a subdirectory of the other)
	 */
	private pathsOverlap(path1: string, path2: string): boolean {
		const normalize = (p: string) => p.replace(/\\/g, '/').replace(/\/$/, '');
		const p1 = normalize(path1);
		const p2 = normalize(path2);
		
		return p1.startsWith(p2 + '/') || p2.startsWith(p1 + '/') || p1 === p2;
	}
}
