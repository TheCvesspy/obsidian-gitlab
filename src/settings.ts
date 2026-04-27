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

		// Check for overlapping paths
		const paths = this.settings.repositories.map(repo => repo.localPath);
		for (let i = 0; i < paths.length; i++) {
			for (let j = i + 1; j < paths.length; j++) {
				if (this.pathsOverlap(paths[i], paths[j])) {
					errors.push(`Overlapping paths: ${paths[i]} and ${paths[j]}`);
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
