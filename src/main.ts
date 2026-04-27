import { App, Plugin, PluginSettingTab, Setting, Notice, Modal, TAbstractFile } from 'obsidian';
import { GitLabPluginSettings, DEFAULT_SETTINGS, SubTreeConfig, DEFAULT_COMMIT_TEMPLATES, CommitTemplate, FileStatus } from './types';
import { SettingsManager } from './settings';
import { RepositoryConfigModal } from './ui/repository-modal';
import { RepositoryManager } from './core/repository-manager';
import { GitLabView, VIEW_TYPE_GITLAB } from './ui/side-panel-view';
import { GitGraphView, VIEW_TYPE_GIT_GRAPH } from './ui/git-graph-view';
import { DiffView, VIEW_TYPE_DIFF } from './ui/diff-view';
import { FileHistoryView, VIEW_TYPE_FILE_HISTORY } from './ui/file-history-view';
import { ConflictResolutionView, VIEW_TYPE_CONFLICT } from './ui/conflict-resolution-view';
import { FileExplorerDecorator } from './ui/file-explorer-status';
import { DebugLogger } from './utils/debug-logger';
import { registerIcons } from './utils/icons';
import { QuickCommitModal } from './ui/quick-commit-modal';
import { QuickPushModal, QuickPullModal, QuickBranchModal } from './ui/quick-actions-modal';
import { GitLabClient } from './api/gitlab-client';

/**
 * Main plugin class for GitLab integration
 */
export default class GitLabPlugin extends Plugin {
	settings!: GitLabPluginSettings;
	settingsManager!: SettingsManager;
	repositoryManager!: RepositoryManager;
	fileExplorerDecorator!: FileExplorerDecorator;
	private statusBarEl: HTMLElement | null = null;
	private autoFetchIntervalId: ReturnType<typeof setInterval> | null = null;
	private autoCommitIntervalId: ReturnType<typeof setInterval> | null = null;

	async onload() {
		console.log('Loading GitLab Plugin');

		// Register custom icons
		registerIcons();

		// Initialize settings manager
		this.settingsManager = new SettingsManager(this);
		await this.settingsManager.loadSettings();
		this.settings = this.settingsManager.getSettings();

		// Initialize repository manager — fast phase only. Heavy per-repo
		// work (addRemote, fetch, statusMatrix, fs.watch) is deferred to
		// onLayoutReady below so Obsidian's startup is not blocked on git.
		this.repositoryManager = new RepositoryManager(this.app);
		this.repositoryManager.setSettings(this.settings);
		this.repositoryManager.setFileChangeListener(this.onFsWatchChange);
		await this.repositoryManager.initialize(this.settings.repositories);

		// Restore GitLab Pages compat snapshots into each GitOperations instance
		// so the very first statusMatrix call after reload already suppresses
		// transformed-but-unedited files.
		const snapshots = this.settings.pagesCompatSnapshots;
		if (snapshots) {
			for (const repo of this.settings.repositories) {
				const snap = snapshots[repo.id];
				if (snap) {
					this.repositoryManager.getGitOps(repo.id)?.setPagesCompatSnapshot(snap);
				}
			}
		}

		// Initialize file explorer status decorator — construct now, start
		// inside the deferred block below after finalization populates state.
		this.fileExplorerDecorator = new FileExplorerDecorator(this.app, this.repositoryManager);

		// Initialize status bar
		this.statusBarEl = this.addStatusBarItem();
		this.statusBarEl.setText('GitLab: initializing…');

		// Deferred initialization: runs after Obsidian's workspace is ready so
		// it never blocks plugin onload. Must complete before performStartupSync
		// because startup sync needs `addRemote` to have run.
		this.app.workspace.onLayoutReady(async () => {
			try {
				await this.repositoryManager.finalizeInitialization();

				if (this.settings.showStatusIndicators) {
					this.fileExplorerDecorator.start();
				}
				this.updateStatusBar();

				// Re-render any side panel leaves that opened during fast-init
				// so they pick up the now-populated branches/files.
				for (const leaf of this.app.workspace.getLeavesOfType(VIEW_TYPE_GITLAB)) {
					const view = leaf.view as GitLabView;
					if (view && typeof view.render === 'function') {
						Promise.resolve(view.render()).catch((e) => console.debug('Post-init re-render failed:', e));
					}
				}

				if (this.settings.syncOnStartup) {
					await this.performStartupSync();
				}
			} catch (e) {
				console.error('Deferred GitLab init failed:', e);
			}
		});

		// Listen for vault changes to auto-detect git changes, refresh decorations,
		// and re-render the side panel. Each handler passes the affected path(s)
		// so we can refresh only the owning repo instead of all of them.
		this.registerEvent(this.app.vault.on('modify', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.vault.on('create', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.vault.on('delete', (file) => this.onVaultChange(file)));
		this.registerEvent(this.app.vault.on('rename', (file, oldPath) => this.onVaultChange(file, oldPath)));

		// Register the side panel view
		this.registerView(
			VIEW_TYPE_GITLAB,
			(leaf) => new GitLabView(leaf, this)
		);

		// Register the git graph view
		this.registerView(
			VIEW_TYPE_GIT_GRAPH,
			(leaf) => new GitGraphView(leaf, this)
		);

		// Register the diff view
		this.registerView(
			VIEW_TYPE_DIFF,
			(leaf) => new DiffView(leaf, this)
		);

		// Register the file history view
		this.registerView(
			VIEW_TYPE_FILE_HISTORY,
			(leaf) => new FileHistoryView(leaf, this)
		);

		// Register the conflict resolution view
		this.registerView(
			VIEW_TYPE_CONFLICT,
			(leaf) => new ConflictResolutionView(leaf, this)
		);

		// Add settings tab
		this.addSettingTab(new GitLabSettingTab(this.app, this));

		// Add ribbon icon
		this.addRibbonIcon('gitlab-logo', 'GitLab', () => {
			this.activateView();
		});

		// Add commands
		this.addCommand({
			id: 'open-gitlab-panel',
			name: 'Open GitLab Panel',
			callback: () => {
				this.activateView();
			}
		});

		this.addCommand({
			id: 'open-git-graph',
			name: 'Open Git Graph',
			callback: () => {
				this.openGitGraph();
			}
		});

		this.addCommand({
			id: 'view-debug-logs',
			name: 'View Debug Logs',
			callback: () => {
				new DebugLogsModal(this.app).open();
			}
		});

		this.addCommand({
			id: 'export-debug-logs',
			name: 'Export Debug Logs',
			callback: () => {
				DebugLogger.downloadLogs();
				new Notice('Debug logs exported');
			}
		});

		this.addCommand({
			id: 'clear-debug-logs',
			name: 'Clear Debug Logs',
			callback: () => {
				DebugLogger.clearHistory();
				new Notice('Debug logs cleared');
			}
		});

		this.addCommand({
			id: 'view-file-diff',
			name: 'View File Diff (Active File)',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No active file');
					return;
				}
				await this.openFileDiff(activeFile.path);
			}
		});

		this.addCommand({
			id: 'view-file-history',
			name: 'View File History (Active File)',
			callback: async () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No active file');
					return;
				}
				await this.openFileHistory(activeFile.path);
			}
		});

		this.addCommand({
			id: 'open-user-guide',
			name: 'Open User Guide',
			callback: async () => {
				try {
					const pluginDir = (this.app as any).vault.configDir + '/plugins/obsidian-gitlab';
					const guideContent = await this.app.vault.adapter.read(pluginDir + '/GUIDE.md');
					const leaf = this.app.workspace.getLeaf('tab');
					await leaf.openFile(
						// Create a virtual markdown view
						null as any
					);
					// Fallback: open as a modal with the guide content
					new GuideModal(this.app, guideContent).open();
				} catch {
					// Try reading from the plugin's own directory
					try {
						const basePath = (this.manifest as any).dir || '';
						const adapter = this.app.vault.adapter;
						const guidePath = basePath ? `${basePath}/GUIDE.md` : 'GUIDE.md';
						const content = await adapter.read(guidePath);
						new GuideModal(this.app, content).open();
					} catch {
						new Notice('User guide not found. Check that GUIDE.md is in the plugin folder.');
					}
				}
			}
		});

		// Quick action commands
		this.addCommand({
			id: 'quick-commit',
			name: 'Quick Commit',
			callback: () => {
				new QuickCommitModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'quick-push',
			name: 'Quick Push',
			callback: () => {
				new QuickPushModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'quick-pull',
			name: 'Quick Pull',
			callback: () => {
				new QuickPullModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'quick-switch-branch',
			name: 'Quick Switch Branch',
			callback: () => {
				new QuickBranchModal(this.app, this).open();
			}
		});

		this.addCommand({
			id: 'open-in-gitlab',
			name: 'Open Active File in GitLab',
			callback: () => {
				const activeFile = this.app.workspace.getActiveFile();
				if (!activeFile) {
					new Notice('No active file');
					return;
				}
				const { foundRepoId, relativePath } = this.findRepoForFile(activeFile.path);
				if (!foundRepoId || !relativePath) {
					new Notice('This file is not in a tracked repository.');
					return;
				}
				const repo = this.settings.repositories.find(r => r.id === foundRepoId);
				if (!repo) return;
				const url = GitLabClient.buildWebUrl(repo.repositoryUrl, repo.currentBranch, relativePath);
				if (url) {
					window.open(url, '_blank');
				} else {
					new Notice('Could not construct GitLab URL');
				}
			}
		});

		// Start auto-fetch if configured
		this.startAutoFetch();

		// Start auto-commit if configured
		this.startAutoCommit();

		console.log('GitLab Plugin loaded successfully');
	}

	async onunload() {
		console.log('Unloading GitLab Plugin');
		this.stopAutoFetch();
		this.stopAutoCommit();
		this.repositoryManager?.stopAllWatchers();
		this.fileExplorerDecorator.stop();
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_GITLAB);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_GIT_GRAPH);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_DIFF);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_FILE_HISTORY);
		this.app.workspace.detachLeavesOfType(VIEW_TYPE_CONFLICT);
	}

	/**
	 * Open Git Graph in a new tab
	 */
	async openGitGraph(repoId?: string): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_GIT_GRAPH,
			active: true,
		});
		this.app.workspace.revealLeaf(leaf);

		if (repoId) {
			const view = leaf.view as GitGraphView;
			if (view.setRepository) {
				await view.setRepository(repoId);
			}
		}
	}

	/**
	 * Open diff view for a file
	 */
	async openFileDiff(vaultPath: string, repoId?: string): Promise<void> {
		// Find which repo this file belongs to
		const { foundRepoId, relativePath } = this.findRepoForFile(vaultPath, repoId);
		if (!foundRepoId || !relativePath) {
			new Notice('This file is not in a tracked repository.');
			return;
		}

		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_DIFF,
			state: { filePath: relativePath, repoId: foundRepoId },
		});
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Open file history view
	 */
	async openFileHistory(vaultPath: string, repoId?: string): Promise<void> {
		const { foundRepoId, relativePath } = this.findRepoForFile(vaultPath, repoId);
		if (!foundRepoId || !relativePath) {
			new Notice('This file is not in a tracked repository.');
			return;
		}

		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_FILE_HISTORY,
			state: { filePath: relativePath, repoId: foundRepoId },
		});
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Open conflict resolution view
	 */
	async openConflictResolution(repoId: string, conflictPaths: string[]): Promise<void> {
		const repoConfig = this.settings.repositories.find(r => r.id === repoId);
		if (!repoConfig) return;

		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_CONFLICT,
			state: {
				repoId,
				conflictPaths,
				repoDir: repoConfig.localPath,
			},
		});
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Find which repository a vault file belongs to and its relative path
	 */
	private findRepoForFile(vaultPath: string, repoId?: string): { foundRepoId: string | null; relativePath: string | null } {
		const vaultBasePath = (this.app.vault.adapter as any).basePath || '';

		for (const repo of this.settings.repositories) {
			if (repoId && repo.id !== repoId) continue;

			const repoLocalPath = repo.localPath;
			const fullFilePath = require('path').join(vaultBasePath, vaultPath);
			
			if (fullFilePath.startsWith(repoLocalPath)) {
				const relativePath = fullFilePath.substring(repoLocalPath.length + 1).replace(/\\/g, '/');
				return { foundRepoId: repo.id, relativePath };
			}
		}

		return { foundRepoId: null, relativePath: null };
	}

	/**
	 * Handle vault file changes — auto-detect git changes for the owning
	 * repo and re-render any open side panel. Debounced 1s to coalesce
	 * bursts (paste, bulk rename, autoformat-on-save).
	 *
	 * Only runs a lightweight statusMatrix refresh — no network fetch, no
	 * branch enumeration. The manual refresh button and the auto-fetch
	 * interval keep doing the full refresh path.
	 */
	private vaultChangeTimer: ReturnType<typeof setTimeout> | null = null;
	private pendingChangedRepos: Set<string> = new Set();
	private onVaultChange(file?: TAbstractFile | null, oldPath?: string): void {
		const paths: string[] = [];
		if (file) paths.push(file.path);
		if (oldPath) paths.push(oldPath);

		for (const p of paths) {
			const repoId = this.repositoryManager.getRepositoryIdForPath(p);
			if (repoId) this.pendingChangedRepos.add(repoId);
		}

		this.scheduleRepoFlush();
	}

	/**
	 * Invoked by RepositoryManager's fs.watch when a filesystem change is
	 * observed inside a repo (including non-Obsidian-native file types that
	 * vault.on() never fires for). Shares the same debounce + flush pipeline
	 * as vault events so we never double-refresh.
	 */
	private onFsWatchChange = (repoId: string): void => {
		this.pendingChangedRepos.add(repoId);
		this.scheduleRepoFlush();
	};

	private scheduleRepoFlush(): void {
		if (this.vaultChangeTimer) clearTimeout(this.vaultChangeTimer);
		this.vaultChangeTimer = setTimeout(() => this.flushRepoChanges(), 1000);
	}

	private async flushRepoChanges(): Promise<void> {
		const repoIds = Array.from(this.pendingChangedRepos);
		this.pendingChangedRepos.clear();
		if (repoIds.length === 0) return;

		// If nothing is listening to the state, skip entirely.
		const panelLeaves = this.app.workspace.getLeavesOfType(VIEW_TYPE_GITLAB);
		const hasPanel = panelLeaves.length > 0;
		if (!hasPanel && !this.settings.showStatusIndicators) return;

		for (const repoId of repoIds) {
			try {
				await this.repositoryManager.refreshFilesOnly(repoId);
			} catch { /* ignore */ }
		}

		this.fileExplorerDecorator.refresh();
		this.updateStatusBar();

		for (const leaf of panelLeaves) {
			const view = leaf.view as GitLabView | undefined;
			view?.render().catch(() => { /* guarded internally */ });
		}
	}

	/**
	 * Start auto-fetch interval based on settings
	 */
	startAutoFetch(): void {
		this.stopAutoFetch();
		const intervalMinutes = this.settings.autoFetchInterval;
		if (intervalMinutes <= 0) return;

		const intervalMs = intervalMinutes * 60 * 1000;
		this.autoFetchIntervalId = setInterval(async () => {
			const repos = this.repositoryManager.getAllRepositories();
			for (const state of repos) {
				if (state.operationInProgress) continue;
				const gitOps = this.repositoryManager.getGitOps(state.config.id);
				if (!gitOps) continue;
				try {
					await gitOps.fetch('origin', state.config.token);
					await this.repositoryManager.refreshRepository(state.config.id);
				} catch (error) {
					console.warn(`Auto-fetch failed for ${state.config.name}:`, error);
				}
			}
		}, intervalMs);
	}

	/**
	 * Stop auto-fetch interval
	 */
	stopAutoFetch(): void {
		if (this.autoFetchIntervalId !== null) {
			clearInterval(this.autoFetchIntervalId);
			this.autoFetchIntervalId = null;
		}
	}

	/**
	 * Update the status bar with current repository state
	 */
	/**
	 * Record workdir blob OIDs for files that were just rewritten by the
	 * GitLab Pages transform pipeline. Persists to settings and pushes
	 * the merged map to the live GitOperations instance so subsequent
	 * status checks can suppress the "always modified" state.
	 */
	async recordPagesCompatSnapshot(repoId: string, oids: Record<string, string>): Promise<void> {
		if (!this.settings.pagesCompatSnapshots) {
			this.settings.pagesCompatSnapshots = {};
		}
		const existing = this.settings.pagesCompatSnapshots[repoId] || {};
		const merged = { ...existing, ...oids };
		this.settings.pagesCompatSnapshots[repoId] = merged;
		await this.settingsManager.saveSettings();
		this.repositoryManager.getGitOps(repoId)?.setPagesCompatSnapshot(merged);
	}

	updateStatusBar(): void {
		if (!this.statusBarEl) return;

		const repos = this.repositoryManager.getAllRepositories();
		if (repos.length === 0) {
			this.statusBarEl.setText('GitLab: No repos');
			return;
		}

		// Show the first repo (or the one with most activity)
		const state = repos[0];
		const branch = state.currentBranch || '?';
		const parts: string[] = [`\u2387 ${branch}`];

		if (state.syncStatus.ahead > 0) {
			parts.push(`\u2191${state.syncStatus.ahead}`);
		}
		if (state.syncStatus.behind > 0) {
			parts.push(`\u2193${state.syncStatus.behind}`);
		}

		const changedFiles = state.files.length;
		if (changedFiles > 0) {
			parts.push(`\u25CF ${changedFiles}`);
		}

		this.statusBarEl.setText(parts.join(' | '));
	}

	/**
	 * Perform sync on startup (fetch or pull all enabled repos)
	 */
	private async performStartupSync(): Promise<void> {
		const repos = this.repositoryManager.getAllRepositories();
		let syncedCount = 0;

		for (const state of repos) {
			const gitOps = this.repositoryManager.getGitOps(state.config.id);
			if (!gitOps) continue;

			try {
				if (this.settings.syncOnStartupMode === 'pull' && state.currentBranch) {
					await gitOps.pull('origin', state.currentBranch, state.config.token);
				} else {
					await gitOps.fetch('origin', state.config.token);
				}
				await this.repositoryManager.refreshRepository(state.config.id);
				syncedCount++;
			} catch (error) {
				console.warn(`Startup sync failed for ${state.config.name}:`, error);
			}
		}

		if (syncedCount > 0) {
			const mode = this.settings.syncOnStartupMode === 'pull' ? 'Pulled' : 'Fetched';
			new Notice(`${mode} ${syncedCount} repository${syncedCount > 1 ? 'ies' : ''} on startup`);
			this.updateStatusBar();
		}
	}

	/**
	 * Start auto-commit interval based on settings
	 */
	startAutoCommit(): void {
		this.stopAutoCommit();
		if (!this.settings.autoCommitEnabled || this.settings.autoCommitInterval <= 0) return;

		const intervalMs = this.settings.autoCommitInterval * 60 * 1000;
		this.autoCommitIntervalId = setInterval(async () => {
			const repos = this.repositoryManager.getAllRepositories();
			for (const state of repos) {
				if (state.operationInProgress) continue;
				const gitOps = this.repositoryManager.getGitOps(state.config.id);
				if (!gitOps) continue;

				try {
					this.repositoryManager.setOperationInProgress(state.config.id, true);

					// Refresh to get latest file status
					await this.repositoryManager.refreshRepository(state.config.id);
					const refreshedState = this.repositoryManager.getRepository(state.config.id);
					if (!refreshedState) {
						this.repositoryManager.setOperationInProgress(state.config.id, false);
						continue;
					}

					// Check if there are any changes to commit
					const changedFiles = refreshedState.files.filter(f => f.status !== FileStatus.UNMODIFIED);
					if (changedFiles.length === 0) {
						this.repositoryManager.setOperationInProgress(state.config.id, false);
						continue;
					}

					// Stage all changed files
					const filePaths = changedFiles.map(f => f.path);
					await gitOps.add(filePaths);

					// Build commit message from template
					let message = this.settings.autoCommitMessage || 'auto: vault backup';
					message = message.replace(/\{date\}/g, new Date().toLocaleString());
					message = message.replace(/\{branch\}/g, refreshedState.currentBranch || '');
					message = message.replace(/\{author\}/g, this.settings.defaultAuthorName || '');

					await gitOps.commit(message);
					DebugLogger.log('AutoCommit', `Auto-committed ${filePaths.length} file(s) in ${state.config.name}`);

					// Auto-push if configured
					if (this.settings.autoPushAfterCommit && refreshedState.currentBranch) {
						await gitOps.push('origin', refreshedState.currentBranch, state.config.token);
						DebugLogger.log('AutoCommit', `Auto-pushed ${state.config.name}`);
					}

					await this.repositoryManager.refreshRepository(state.config.id);
					this.repositoryManager.setOperationInProgress(state.config.id, false);
					this.updateStatusBar();
				} catch (error) {
					console.warn(`Auto-commit failed for ${state.config.name}:`, error);
					this.repositoryManager.setOperationInProgress(state.config.id, false);
				}
			}
		}, intervalMs);
	}

	/**
	 * Stop auto-commit interval
	 */
	stopAutoCommit(): void {
		if (this.autoCommitIntervalId !== null) {
			clearInterval(this.autoCommitIntervalId);
			this.autoCommitIntervalId = null;
		}
	}

	async activateView() {
		const { workspace } = this.app;

		let leaf = workspace.getLeavesOfType(VIEW_TYPE_GITLAB)[0];

		if (!leaf) {
			const rightLeaf = workspace.getRightLeaf(false);
			if (rightLeaf) {
				await rightLeaf.setViewState({
					type: VIEW_TYPE_GITLAB,
					active: true,
				});
				leaf = rightLeaf;
			}
		}

		if (leaf) {
			workspace.revealLeaf(leaf);
		}
	}
}

/**
 * Settings tab for the plugin
 */
class GitLabSettingTab extends PluginSettingTab {
	plugin: GitLabPlugin;

	constructor(app: App, plugin: GitLabPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl('h2', { text: 'GitLab Integration Settings' });

		// Global settings
		containerEl.createEl('h3', { text: 'Global Settings' });

		new Setting(containerEl)
			.setName('Default Author Name')
			.setDesc('Name to use for commits')
			.addText(text => text
				.setPlaceholder('Your Name')
				.setValue(this.plugin.settings.defaultAuthorName)
				.onChange(async (value) => {
					this.plugin.settings.defaultAuthorName = value;
					await this.plugin.settingsManager.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Default Author Email')
			.setDesc('Email to use for commits')
			.addText(text => text
				.setPlaceholder('your.email@example.com')
				.setValue(this.plugin.settings.defaultAuthorEmail)
				.onChange(async (value) => {
					this.plugin.settings.defaultAuthorEmail = value;
					await this.plugin.settingsManager.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Show Status Indicators')
			.setDesc('Display Git status badges in file explorer')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.showStatusIndicators)
				.onChange(async (value) => {
					this.plugin.settings.showStatusIndicators = value;
					await this.plugin.settingsManager.saveSettings();
					this.plugin.fileExplorerDecorator.setEnabled(value);
					if (value) {
						this.plugin.fileExplorerDecorator.start();
					} else {
						this.plugin.fileExplorerDecorator.stop();
					}
				}));

		new Setting(containerEl)
			.setName('Auto-Fetch Interval')
			.setDesc('Automatically fetch from remote at this interval (in minutes, 0 = disabled)')
			.addText(text => text
				.setPlaceholder('0')
				.setValue(String(this.plugin.settings.autoFetchInterval))
				.onChange(async (value) => {
					const num = parseInt(value) || 0;
					this.plugin.settings.autoFetchInterval = Math.max(0, num);
					await this.plugin.settingsManager.saveSettings();
					this.plugin.startAutoFetch();
				}));

		// Sync on Startup
		containerEl.createEl('h3', { text: 'Sync on Startup' });

		new Setting(containerEl)
			.setName('Sync on Startup')
			.setDesc('Automatically fetch or pull when Obsidian opens')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.syncOnStartup)
				.onChange(async (value) => {
					this.plugin.settings.syncOnStartup = value;
					await this.plugin.settingsManager.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Sync Mode')
			.setDesc('Whether to fetch (check for changes) or pull (download changes) on startup')
			.addDropdown(dropdown => dropdown
				.addOption('fetch', 'Fetch only')
				.addOption('pull', 'Pull (fetch + merge)')
				.setValue(this.plugin.settings.syncOnStartupMode)
				.onChange(async (value: string) => {
					this.plugin.settings.syncOnStartupMode = value as 'fetch' | 'pull';
					await this.plugin.settingsManager.saveSettings();
				}));

		// Auto-Commit / Auto-Push
		containerEl.createEl('h3', { text: 'Auto-Commit / Auto-Push' });

		new Setting(containerEl)
			.setName('Enable Auto-Commit')
			.setDesc('Automatically commit changes at a regular interval')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoCommitEnabled)
				.onChange(async (value) => {
					this.plugin.settings.autoCommitEnabled = value;
					await this.plugin.settingsManager.saveSettings();
					this.plugin.startAutoCommit();
				}));

		new Setting(containerEl)
			.setName('Auto-Commit Interval')
			.setDesc('Interval in minutes between auto-commits')
			.addText(text => text
				.setPlaceholder('5')
				.setValue(String(this.plugin.settings.autoCommitInterval))
				.onChange(async (value) => {
					const num = parseInt(value) || 5;
					this.plugin.settings.autoCommitInterval = Math.max(1, num);
					await this.plugin.settingsManager.saveSettings();
					this.plugin.startAutoCommit();
				}));

		new Setting(containerEl)
			.setName('Auto-Commit Message')
			.setDesc('Commit message template. Variables: {date}, {branch}, {author}')
			.addText(text => text
				.setPlaceholder('auto: vault backup {date}')
				.setValue(this.plugin.settings.autoCommitMessage)
				.onChange(async (value) => {
					this.plugin.settings.autoCommitMessage = value;
					await this.plugin.settingsManager.saveSettings();
				}));

		new Setting(containerEl)
			.setName('Auto-Push After Commit')
			.setDesc('Automatically push to remote after each auto-commit')
			.addToggle(toggle => toggle
				.setValue(this.plugin.settings.autoPushAfterCommit)
				.onChange(async (value) => {
					this.plugin.settings.autoPushAfterCommit = value;
					await this.plugin.settingsManager.saveSettings();
				}));

		// Repository mappings
		containerEl.createEl('h3', { text: 'Repository Mappings' });

		if (this.plugin.settings.repositories.length === 0) {
			containerEl.createEl('p', { 
				text: 'No repository mappings configured yet.',
				cls: 'setting-item-description'
			});
		}

		// List existing repositories
		this.plugin.settings.repositories.forEach((repo, index) => {
			new Setting(containerEl)
				.setName(repo.name || `Repository ${index + 1}`)
				.setDesc(`${repo.localPath} → ${repo.repositoryUrl}`)
				.addButton(button => button
					.setButtonText('Edit')
					.onClick(() => {
						const modal = new RepositoryConfigModal(
							this.app,
							{ ...repo },
							async (updatedConfig) => {
								const repoIndex = this.plugin.settings.repositories.findIndex(r => r.id === repo.id);
								if (repoIndex !== -1) {
									this.plugin.settings.repositories[repoIndex] = updatedConfig;
									await this.plugin.settingsManager.saveSettings();
									await this.plugin.repositoryManager.initialize(this.plugin.settings.repositories);
									await this.plugin.repositoryManager.finalizeInitialization();
									new Notice(`Updated repository: ${updatedConfig.name}`);
									this.display();
								}
							}
						);
						modal.open();
					}))
				.addButton(button => button
					.setButtonText('Remove')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.repositories.splice(index, 1);
						await this.plugin.settingsManager.saveSettings();
						await this.plugin.repositoryManager.initialize(this.plugin.settings.repositories);
						await this.plugin.repositoryManager.finalizeInitialization();
						this.display(); // Refresh display
					}));
		});

		// Add new repository button
		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add Repository Mapping')
				.setCta()
				.onClick(() => {
					const modal = new RepositoryConfigModal(
						this.app,
						null,
						async (newConfig) => {
							// Check for duplicate IDs (shouldn't happen but just in case)
							const exists = this.plugin.settings.repositories.some(r => r.id === newConfig.id);
							if (exists) {
								new Notice('A repository with this ID already exists');
								return;
							}
							
							this.plugin.settings.repositories.push(newConfig);
							await this.plugin.settingsManager.saveSettings();
							await this.plugin.repositoryManager.initialize(this.plugin.settings.repositories);
							await this.plugin.repositoryManager.finalizeInitialization();
							new Notice(`Added repository: ${newConfig.name}`);
							this.display();
						}
					);
					modal.open();
				}));

		// Commit Templates
		containerEl.createEl('h3', { text: 'Commit Templates' });
		containerEl.createEl('p', {
			text: 'Templates can use variables: {jira}, {branch}, {date}, {author}',
			cls: 'setting-item-description',
		});

		// Ensure commitTemplates array exists
		if (!this.plugin.settings.commitTemplates) {
			this.plugin.settings.commitTemplates = [...DEFAULT_COMMIT_TEMPLATES];
		}

		this.plugin.settings.commitTemplates.forEach((tpl, index) => {
			new Setting(containerEl)
				.setName(tpl.name)
				.setDesc(tpl.template)
				.addButton(button => button
					.setButtonText('Edit')
					.onClick(() => {
						const name = prompt('Template name:', tpl.name);
						if (name === null) return;
						const template = prompt('Template string:', tpl.template);
						if (template === null) return;
						tpl.name = name;
						tpl.template = template;
						this.plugin.settingsManager.saveSettings();
						this.display();
					}))
				.addButton(button => button
					.setButtonText('Remove')
					.setWarning()
					.onClick(async () => {
						this.plugin.settings.commitTemplates.splice(index, 1);
						await this.plugin.settingsManager.saveSettings();
						this.display();
					}));
		});

		new Setting(containerEl)
			.addButton(button => button
				.setButtonText('Add Template')
				.onClick(async () => {
					const name = prompt('Template name:');
					if (!name) return;
					const template = prompt('Template string (use {jira}, {branch}, {date}, {author}):');
					if (!template) return;
					this.plugin.settings.commitTemplates.push({
						id: `custom-${Date.now()}`,
						name,
						template,
					});
					await this.plugin.settingsManager.saveSettings();
					this.display();
				}))
			.addButton(button => button
				.setButtonText('Reset to Defaults')
				.onClick(async () => {
					this.plugin.settings.commitTemplates = [...DEFAULT_COMMIT_TEMPLATES];
					await this.plugin.settingsManager.saveSettings();
					this.display();
					new Notice('Templates reset to defaults');
				}));

		// Import/Export configuration
		containerEl.createEl('h3', { text: 'Configuration Import/Export' });

		new Setting(containerEl)
			.setName('Export Configuration')
			.setDesc('Export repository mappings to JSON file')
			.addButton(button => button
				.setButtonText('Export')
				.onClick(async () => {
					try {
						const exported = this.plugin.settingsManager.exportSettings();
						const blob = new Blob([exported], { type: 'application/json' });
						const url = URL.createObjectURL(blob);
						const a = document.createElement('a');
						a.href = url;
						a.download = 'gitlab-plugin-config.json';
						a.click();
						URL.revokeObjectURL(url);
						new Notice('Configuration exported successfully');
					} catch (error) {
						const message = error instanceof Error ? error.message : String(error);
						new Notice(`Export failed: ${message}`);
					}
				}));

		new Setting(containerEl)
			.setName('Import Configuration')
			.setDesc('Import repository mappings from JSON file')
			.addButton(button => button
				.setButtonText('Import')
				.onClick(() => {
					const input = document.createElement('input');
					input.type = 'file';
					input.accept = 'application/json';
					input.onchange = async (e: Event) => {
						const file = (e.target as HTMLInputElement).files?.[0];
						if (!file) return;
						
						try {
							const text = await file.text();
							await this.plugin.settingsManager.importSettings(text, true);
							new Notice('Configuration imported successfully');
							this.display();
						} catch (error) {
							const message = error instanceof Error ? error.message : String(error);
							new Notice(`Import failed: ${message}`);
						}
					};
					input.click();
				}));
	}
}

/**
 * Modal for viewing debug logs
 */
class DebugLogsModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { text: 'GitLab Plugin Debug Logs' });

		// Add buttons
		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.style.marginBottom = '10px';
		buttonContainer.style.display = 'flex';
		buttonContainer.style.gap = '10px';

		const refreshButton = buttonContainer.createEl('button', { text: '↻ Refresh' });
		refreshButton.addEventListener('click', () => {
			this.renderLogs();
		});

		const exportButton = buttonContainer.createEl('button', { text: '⬇ Export' });
		exportButton.addEventListener('click', () => {
			DebugLogger.downloadLogs();
			new Notice('Logs exported');
		});

		const clearButton = buttonContainer.createEl('button', { text: '🗑 Clear' });
		clearButton.addEventListener('click', () => {
			DebugLogger.clearHistory();
			new Notice('Logs cleared');
			this.renderLogs();
		});

		// Logs container
		this.renderLogs();
	}

	renderLogs() {
		// Remove existing logs container if any
		const existingContainer = this.contentEl.querySelector('.debug-logs-container');
		if (existingContainer) {
			existingContainer.remove();
		}

		const logsContainer = this.contentEl.createDiv({ cls: 'debug-logs-container' });
		logsContainer.style.maxHeight = '500px';
		logsContainer.style.overflow = 'auto';
		logsContainer.style.border = '1px solid var(--background-modifier-border)';
		logsContainer.style.padding = '10px';
		logsContainer.style.backgroundColor = 'var(--background-secondary)';
		logsContainer.style.fontFamily = 'var(--font-monospace)';
		logsContainer.style.fontSize = '0.85em';
		logsContainer.style.whiteSpace = 'pre-wrap';
		logsContainer.style.wordBreak = 'break-word';

		const logs = DebugLogger.getHistory();
		if (logs.length === 0) {
			logsContainer.createEl('p', {
				text: 'No logs yet. Logs will appear here when you perform Git operations.',
				cls: 'setting-item-description',
			});
		} else {
			logsContainer.setText(logs.join('\n'));
			// Auto-scroll to bottom
			logsContainer.scrollTop = logsContainer.scrollHeight;
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}

/**
 * Modal for displaying the user guide
 */
class GuideModal extends Modal {
	private content: string;

	constructor(app: App, content: string) {
		super(app);
		this.content = content;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.addClass('gitlab-guide-modal');
		contentEl.style.maxHeight = '80vh';
		contentEl.style.overflow = 'auto';

		// Render markdown content as pre-formatted text with basic formatting
		const container = contentEl.createDiv({ cls: 'gitlab-guide-content' });

		// Simple markdown rendering
		const lines = this.content.split('\n');
		let inCodeBlock = false;
		let codeContent = '';

		for (const line of lines) {
			if (line.startsWith('```')) {
				if (inCodeBlock) {
					const code = container.createEl('pre');
					code.createEl('code', { text: codeContent.trim() });
					codeContent = '';
					inCodeBlock = false;
				} else {
					inCodeBlock = true;
				}
				continue;
			}

			if (inCodeBlock) {
				codeContent += line + '\n';
				continue;
			}

			if (line.startsWith('# ')) {
				container.createEl('h1', { text: line.substring(2) });
			} else if (line.startsWith('## ')) {
				container.createEl('h2', { text: line.substring(3) });
			} else if (line.startsWith('### ')) {
				container.createEl('h3', { text: line.substring(4) });
			} else if (line.startsWith('#### ')) {
				container.createEl('h4', { text: line.substring(5) });
			} else if (line.startsWith('- ') || line.startsWith('* ')) {
				container.createEl('li', { text: line.substring(2) });
			} else if (line.startsWith('| ')) {
				// Table row - render as monospace
				container.createEl('div', { text: line, cls: 'gitlab-guide-table-row' });
			} else if (line.trim() === '') {
				container.createEl('br');
			} else {
				container.createEl('p', { text: line });
			}
		}
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
