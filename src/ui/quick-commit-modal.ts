/**
 * Quick Commit Modal
 * Standalone modal for committing without opening the sidebar
 */

import { Modal, App, Notice } from 'obsidian';
import GitLabPlugin from '../main';
import { RepositoryState, FileStatus, GitFile } from '../types';
import { PagesCompatPipeline, PagesCompatTransformError } from '../core/pages-compat-pipeline';

export class QuickCommitModal extends Modal {
	private plugin: GitLabPlugin;
	private selectedRepoId: string | null = null;
	private commitMessage = '';
	private jiraTicket = '';
	private selectedTemplateId = '';
	private fileListContainer: HTMLElement | null = null;
	private amendMode = false;

	constructor(app: App, plugin: GitLabPlugin) {
		super(app);
		this.plugin = plugin;
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.addClass('gitlab-quick-commit-modal');
		contentEl.createEl('h2', { text: '⚡ Quick Commit' });

		const repos = this.plugin.repositoryManager?.getAllRepositories() || [];
		const enabledRepos = repos.filter(r => r.config.enabled);

		if (enabledRepos.length === 0) {
			contentEl.createEl('p', { text: 'No repositories configured.', cls: 'setting-item-description' });
			return;
		}

		if (enabledRepos.every(r => !r.initializationComplete)) {
			new Notice('GitLab repositories are still initializing — try again in a moment.');
			this.close();
			return;
		}

		// Auto-select if single repo
		if (enabledRepos.length === 1) {
			this.selectedRepoId = enabledRepos[0].config.id;
		}

		// Repo selector (if multiple)
		if (enabledRepos.length > 1) {
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
			if (this.selectedRepoId) repoSelect.value = this.selectedRepoId;
			repoSelect.addEventListener('change', async () => {
				this.selectedRepoId = repoSelect.value || null;
				await this.refreshFileList();
			});
		}

		// File list container
		this.fileListContainer = contentEl.createDiv({ cls: 'gitlab-qc-files-container' });

		// JIRA ticket
		const jiraRow = contentEl.createDiv({ cls: 'gitlab-qc-row' });
		jiraRow.createEl('label', { text: 'JIRA Ticket', cls: 'gitlab-qc-label' });
		const jiraInput = jiraRow.createEl('input', {
			type: 'text',
			cls: 'gitlab-qc-input',
			placeholder: 'e.g. PROJ-123 (optional)',
		});
		jiraInput.addEventListener('input', () => {
			this.jiraTicket = jiraInput.value;
		});

		// Template selector
		if (this.plugin.settings.commitTemplates.length > 0) {
			const tplRow = contentEl.createDiv({ cls: 'gitlab-qc-row' });
			tplRow.createEl('label', { text: 'Template', cls: 'gitlab-qc-label' });
			const tplSelect = tplRow.createEl('select', { cls: 'gitlab-qc-select' });
			tplSelect.createEl('option', { text: '— None —', value: '' });
			for (const tpl of this.plugin.settings.commitTemplates) {
				tplSelect.createEl('option', { text: tpl.name, value: tpl.id });
			}
			tplSelect.addEventListener('change', () => {
				this.selectedTemplateId = tplSelect.value;
				const tpl = this.plugin.settings.commitTemplates.find(t => t.id === tplSelect.value);
				if (tpl) {
					const state = this.getSelectedState();
					let msg = tpl.template;
					msg = msg.replace(/\{jira\}/g, this.jiraTicket || '');
					msg = msg.replace(/\{branch\}/g, state?.currentBranch || '');
					msg = msg.replace(/\{date\}/g, new Date().toLocaleDateString());
					msg = msg.replace(/\{author\}/g, this.plugin.settings.defaultAuthorName || '');
					this.commitMessage = msg;
					textarea.value = msg;
				}
			});
		}

		// Commit message
		const msgRow = contentEl.createDiv({ cls: 'gitlab-qc-row' });
		msgRow.createEl('label', { text: 'Commit Message', cls: 'gitlab-qc-label' });
		const textarea = msgRow.createEl('textarea', {
			cls: 'gitlab-qc-textarea',
			placeholder: 'Enter commit message...',
		});
		textarea.rows = 4;
		textarea.addEventListener('input', () => {
			this.commitMessage = textarea.value;
		});

		// Buttons (created before amend checkbox so they can be referenced)
		const buttonRow = contentEl.createDiv({ cls: 'gitlab-qc-buttons' });

		const commitBtn = buttonRow.createEl('button', {
			text: '✓ Commit',
			cls: 'gitlab-qc-btn gitlab-qc-btn-primary',
		});
		commitBtn.addEventListener('click', async () => {
			await this.doCommit(false);
		});

		const commitPushBtn = buttonRow.createEl('button', {
			text: '✓ Commit & Push',
			cls: 'gitlab-qc-btn gitlab-qc-btn-accent',
		});
		commitPushBtn.addEventListener('click', async () => {
			await this.doCommit(true);
		});

		// Amend checkbox (inserted before buttons visually)
		const amendRow = contentEl.createDiv({ cls: 'gitlab-qc-row' });
		contentEl.insertBefore(amendRow, buttonRow);
		const amendCheckbox = amendRow.createEl('input', { type: 'checkbox' });
		amendCheckbox.id = 'gitlab-qc-amend';
		const amendLabel = amendRow.createEl('label', { text: 'Amend last commit' });
		amendLabel.setAttribute('for', 'gitlab-qc-amend');
		amendCheckbox.addEventListener('change', async () => {
			this.amendMode = amendCheckbox.checked;
			if (this.amendMode && this.selectedRepoId) {
				const gitOps = this.plugin.repositoryManager?.getGitOps(this.selectedRepoId);
				if (gitOps) {
					try {
						const state = this.getSelectedState();
						const commits = await gitOps.log(state?.currentBranch, 1);
						if (commits.length > 0) {
							this.commitMessage = commits[0].message;
							textarea.value = this.commitMessage;
						}
					} catch { /* ignore */ }
				}
				commitBtn.textContent = '✓ Amend';
				commitPushBtn.textContent = '✓ Amend & Push';
			} else {
				commitBtn.textContent = '✓ Commit';
				commitPushBtn.textContent = '✓ Commit & Push';
			}
		});

		// Render file list for selected repo
		await this.refreshFileList();
	}

	private getSelectedState(): RepositoryState | undefined {
		if (!this.selectedRepoId) return undefined;
		return this.plugin.repositoryManager?.getRepository(this.selectedRepoId);
	}

	private async refreshFileList(): Promise<void> {
		if (!this.fileListContainer) return;
		this.fileListContainer.empty();

		if (!this.selectedRepoId) {
			this.fileListContainer.createEl('p', {
				text: 'Select a repository to see changes.',
				cls: 'setting-item-description',
			});
			return;
		}

		// Refresh state from disk
		await this.plugin.repositoryManager?.refreshRepository(this.selectedRepoId);
		const state = this.getSelectedState();
		if (!state) return;

		const changedFiles = state.files.filter(f => f.status !== FileStatus.UNMODIFIED);

		if (changedFiles.length === 0) {
			this.fileListContainer.createEl('p', {
				text: 'No changes to commit.',
				cls: 'setting-item-description',
			});
			return;
		}

		const header = this.fileListContainer.createDiv({ cls: 'gitlab-qc-files-header' });
		header.createEl('span', { text: `Changed Files (${changedFiles.length})`, cls: 'gitlab-qc-files-title' });

		// Select all / deselect all
		const selectAllBtn = header.createEl('button', {
			text: 'Select All',
			cls: 'gitlab-qc-btn-small',
		});
		selectAllBtn.addEventListener('click', async () => {
			await this.stageAll(state, changedFiles, true);
		});

		const deselectAllBtn = header.createEl('button', {
			text: 'Deselect All',
			cls: 'gitlab-qc-btn-small',
		});
		deselectAllBtn.addEventListener('click', async () => {
			await this.stageAll(state, changedFiles, false);
		});

		const fileList = this.fileListContainer.createDiv({ cls: 'gitlab-qc-file-list' });

		for (const file of changedFiles) {
			const fileItem = fileList.createDiv({ cls: 'gitlab-qc-file-item' });
			const checkbox = fileItem.createEl('input', { type: 'checkbox' });
			checkbox.checked = file.staged;
			checkbox.addEventListener('change', async () => {
				await this.toggleStage(state, file, checkbox.checked);
			});

			fileItem.createEl('span', { text: file.path, cls: 'gitlab-qc-file-path' });

			const badge = fileItem.createEl('span', {
				text: this.getStatusBadge(file.status),
				cls: `gitlab-status-badge gitlab-status-${file.status}`,
			});
		}
	}

	private async stageAll(state: RepositoryState, files: GitFile[], stage: boolean): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			for (const file of files) {
				if (stage) {
					if (file.status === FileStatus.DELETED) {
						await gitOps.remove([file.path]);
					} else {
						await gitOps.add([file.path]);
					}
				} else {
					await gitOps.reset([file.path]);
				}
			}
			await this.refreshFileList();
		} catch (error) {
			new Notice(`Failed to ${stage ? 'stage' : 'unstage'} files`);
		}
	}

	private async toggleStage(state: RepositoryState, file: GitFile, stage: boolean): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			if (stage) {
				if (file.status === FileStatus.DELETED) {
					await gitOps.remove([file.path]);
				} else {
					await gitOps.add([file.path]);
				}
			} else {
				await gitOps.reset([file.path]);
			}
			await this.refreshFileList();
		} catch (error) {
			new Notice(`Failed to ${stage ? 'stage' : 'unstage'} file`);
		}
	}

	private async doCommit(andPush: boolean): Promise<void> {
		if (!this.selectedRepoId) {
			new Notice('Please select a repository');
			return;
		}

		if (!this.commitMessage.trim()) {
			new Notice('Please enter a commit message');
			return;
		}

		const state = this.getSelectedState();
		if (!state) return;

		const hasStagedFiles = state.files.some(f => f.staged);
		if (!hasStagedFiles) {
			new Notice('No files staged for commit');
			return;
		}

		const gitOps = this.plugin.repositoryManager?.getGitOps(this.selectedRepoId);
		if (!gitOps) return;

		try {
			const author = {
				name: this.plugin.settings.defaultAuthorName || 'Obsidian User',
				email: this.plugin.settings.defaultAuthorEmail || 'user@obsidian.md',
			};

			let finalMessage = this.commitMessage;
			if (this.jiraTicket.trim()) {
				finalMessage = `Changes for JIRA: ${this.jiraTicket.trim()}\n${this.commitMessage}`;
			}

			const hook = state.config.gitlabPagesCompat?.enabled
				? (paths: string[]) =>
						new PagesCompatPipeline(this.plugin, state.config, gitOps).buildTransformedSnapshot(paths)
				: undefined;
			const commitResult = this.amendMode
				? await gitOps.amendCommit(finalMessage, author, hook)
				: await gitOps.commit(finalMessage, author, hook);
			new Notice(this.amendMode ? 'Commit amended successfully' : 'Changes committed successfully');
			if (commitResult.transformedWorkdirOids) {
				await this.plugin.recordPagesCompatSnapshot(this.selectedRepoId, commitResult.transformedWorkdirOids);
			}

			if (andPush) {
				const currentConfig = this.plugin.settings.repositories.find(r => r.id === this.selectedRepoId);
				const token = currentConfig?.token || state.config.token;
				await gitOps.push('origin', state.currentBranch, token);
				new Notice('Changes pushed successfully');
			}

			await this.plugin.repositoryManager?.refreshRepository(this.selectedRepoId);
			this.close();
		} catch (error: any) {
			if (error instanceof PagesCompatTransformError) {
				const head = error.failures.slice(0, 5).map(f => `• ${f.linkName} in ${f.mdPath}: ${f.reason}`).join('\n');
				const more = error.failures.length > 5 ? `\n…and ${error.failures.length - 5} more` : '';
				new Notice(`GitLab Pages transform aborted — commit not made:\n${head}${more}`, 12000);
			} else {
				const msg = error?.message || 'Unknown error';
				new Notice(`Failed: ${msg}`, 8000);
			}
		}
	}

	private getStatusBadge(status: FileStatus): string {
		switch (status) {
			case FileStatus.MODIFIED: return 'M';
			case FileStatus.ADDED: return 'A';
			case FileStatus.DELETED: return 'D';
			case FileStatus.RENAMED: return 'R';
			case FileStatus.UNTRACKED: return '?';
			default: return '•';
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
