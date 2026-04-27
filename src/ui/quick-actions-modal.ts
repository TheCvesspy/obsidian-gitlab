/**
 * Quick Action Modals
 * Lightweight modals for push, pull, and branch switching
 */

import { Modal, App, Notice } from 'obsidian';
import GitLabPlugin from '../main';
import { RepositoryState } from '../types';

/**
 * Base class for quick action modals that need repo selection
 */
abstract class QuickRepoActionModal extends Modal {
	protected plugin: GitLabPlugin;

	constructor(app: App, plugin: GitLabPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen(): Promise<void> {
		const repos = this.plugin.repositoryManager?.getAllRepositories() || [];
		const enabledRepos = repos.filter(r => r.config.enabled);

		if (enabledRepos.length === 0) {
			this.contentEl.createEl('p', { text: 'No repositories configured.' });
			return;
		}

		if (enabledRepos.every(r => !r.initializationComplete)) {
			new Notice('GitLab repositories are still initializing — try again in a moment.');
			this.close();
			return;
		}

		if (enabledRepos.length === 1) {
			await this.executeAction(enabledRepos[0]);
			return;
		}

		// Multiple repos — show selector
		this.contentEl.addClass('gitlab-quick-action-modal');
		this.contentEl.createEl('h2', { text: this.getTitle() });

		const list = this.contentEl.createDiv({ cls: 'gitlab-qa-repo-list' });
		for (const repo of enabledRepos) {
			const item = list.createDiv({ cls: 'gitlab-qa-repo-item' });
			item.createEl('span', {
				text: `${repo.config.name}`,
				cls: 'gitlab-qa-repo-name',
			});
			item.createEl('span', {
				text: `(${repo.currentBranch})`,
				cls: 'gitlab-qa-repo-branch',
			});
			item.addEventListener('click', async () => {
				await this.executeAction(repo);
			});
		}
	}

	abstract getTitle(): string;
	abstract executeAction(state: RepositoryState): Promise<void>;

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Quick Push Modal
 */
export class QuickPushModal extends QuickRepoActionModal {
	getTitle(): string {
		return '⬆ Quick Push';
	}

	async executeAction(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
		const token = currentConfig?.token || state.config.token;

		try {
			const isNewBranch = state.syncStatus.remoteBranchMissing === true;
			new Notice(isNewBranch ? `Publishing branch '${state.currentBranch}'...` : `Pushing ${state.config.name}...`);
			await gitOps.push('origin', state.currentBranch, token);
			new Notice(isNewBranch ? `Branch '${state.currentBranch}' published!` : 'Push completed!');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.close();
		} catch (error: any) {
			const msg = error?.message || 'Unknown error';
			new Notice(`Push failed: ${msg}`, 8000);
			this.close();
		}
	}
}

/**
 * Quick Pull Modal
 */
export class QuickPullModal extends QuickRepoActionModal {
	getTitle(): string {
		return '⬇ Quick Pull';
	}

	async executeAction(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		// Warn about uncommitted changes
		if (state.syncStatus.hasUncommittedChanges) {
			const proceed = await this.confirmWithChanges(state);
			if (!proceed) return;
		}

		const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
		const token = currentConfig?.token || state.config.token;

		try {
			new Notice(`Pulling ${state.config.name}...`);
			await gitOps.pull('origin', state.currentBranch, token);
			new Notice('Pull completed!');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.close();
		} catch (error: any) {
			const msg = error?.message || 'Unknown error';
			new Notice(`Pull failed: ${msg}`, 8000);
			this.close();
		}
	}

	private confirmWithChanges(state: RepositoryState): Promise<boolean> {
		return new Promise((resolve) => {
			this.contentEl.empty();
			this.contentEl.addClass('gitlab-quick-action-modal');
			this.contentEl.createEl('h2', { text: '⚠ Uncommitted Changes' });
			this.contentEl.createEl('p', {
				text: `Repository "${state.config.name}" has uncommitted changes. Pulling may cause conflicts.`,
			});

			const buttons = this.contentEl.createDiv({ cls: 'gitlab-qc-buttons' });
			const cancelBtn = buttons.createEl('button', { text: 'Cancel', cls: 'gitlab-qc-btn' });
			cancelBtn.addEventListener('click', () => {
				this.close();
				resolve(false);
			});

			const proceedBtn = buttons.createEl('button', { text: 'Pull Anyway', cls: 'gitlab-qc-btn gitlab-qc-btn-accent' });
			proceedBtn.addEventListener('click', () => resolve(true));
		});
	}
}

/**
 * Quick Branch Switch Modal
 */
export class QuickBranchModal extends Modal {
	private plugin: GitLabPlugin;

	constructor(app: App, plugin: GitLabPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass('gitlab-quick-action-modal');
		contentEl.createEl('h2', { text: '🔀 Switch Branch' });

		const repos = this.plugin.repositoryManager?.getAllRepositories() || [];
		const enabledRepos = repos.filter(r => r.config.enabled);

		if (enabledRepos.length === 0) {
			contentEl.createEl('p', { text: 'No repositories configured.' });
			return;
		}

		// If single repo, show branches directly
		if (enabledRepos.length === 1) {
			await this.renderBranchSelector(contentEl, enabledRepos[0]);
			return;
		}

		// Multiple repos — show repo selector first
		const repoRow = contentEl.createDiv({ cls: 'gitlab-qc-row' });
		repoRow.createEl('label', { text: 'Repository', cls: 'gitlab-qc-label' });
		const repoSelect = repoRow.createEl('select', { cls: 'gitlab-qc-select' });
		repoSelect.createEl('option', { text: '— Select repository —', value: '' });
		for (const repo of enabledRepos) {
			repoSelect.createEl('option', {
				text: `${repo.config.name} (${repo.currentBranch})`,
				value: repo.config.id,
			});
		}

		const branchContainer = contentEl.createDiv();

		repoSelect.addEventListener('change', async () => {
			branchContainer.empty();
			const state = enabledRepos.find(r => r.config.id === repoSelect.value);
			if (state) {
				await this.renderBranchSelector(branchContainer, state);
			}
		});
	}

	private async renderBranchSelector(container: HTMLElement, state: RepositoryState): Promise<void> {
		const infoEl = container.createDiv({ cls: 'gitlab-qc-row' });
		infoEl.createEl('span', {
			text: `Current: ${state.currentBranch}`,
			cls: 'gitlab-qa-current-branch',
		});

		// Branch list
		const branchList = container.createDiv({ cls: 'gitlab-qa-branch-list' });

		const otherBranches = state.branches.filter(b => b.name !== state.currentBranch);

		for (const branch of otherBranches) {
			const isOrphaned = branch.remoteExists === false;
			const branchItem = branchList.createDiv({ cls: 'gitlab-qa-branch-item' });

			const nameSpan = branchItem.createEl('span', {
				text: isOrphaned ? `⚠️ ${branch.name} (remote deleted)` : branch.name,
			});
			if (isOrphaned) {
				nameSpan.addClass('gitlab-branch-orphaned');
			}

			branchItem.addEventListener('click', async () => {
				await this.switchBranch(state, branch.name);
			});

			// Delete button for orphaned branches
			if (isOrphaned) {
				const deleteBtn = branchItem.createEl('button', {
					text: '🗑️',
					cls: 'gitlab-branch-delete-btn',
				});
				deleteBtn.title = 'Delete this orphaned branch';
				deleteBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					await this.deleteOrphanedBranch(state, branch.name, branchItem);
				});
			}
		}

		if (otherBranches.length === 0) {
			branchList.createEl('p', {
				text: 'No other branches available.',
				cls: 'setting-item-description',
			});
		}
	}

	private async deleteOrphanedBranch(state: RepositoryState, branchName: string, itemEl: HTMLElement): Promise<void> {
		const proceed = confirm(`Delete orphaned branch "${branchName}"?\nThis branch no longer exists on the remote.`);
		if (!proceed) return;

		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			await gitOps.deleteBranch(branchName);
			new Notice(`Deleted branch '${branchName}'`);
			itemEl.remove();
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
		} catch (error: any) {
			new Notice(`Failed to delete branch: ${error?.message || 'Unknown error'}`, 8000);
		}
	}

	private async switchBranch(state: RepositoryState, branchName: string): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		// Warn about uncommitted changes
		if (state.syncStatus.hasUncommittedChanges) {
			new Notice('⚠ You have uncommitted changes. Consider stashing them first.', 5000);
		}

		try {
			new Notice(`Switching to ${branchName}...`);
			await gitOps.checkout(branchName);
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			new Notice(`Switched to branch '${branchName}'`);
			this.close();
		} catch (error: any) {
			const msg = error?.message || 'Unknown error';
			new Notice(`Failed to switch branch: ${msg}`, 8000);
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
