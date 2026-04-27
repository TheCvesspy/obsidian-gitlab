/**
 * Merge Request Creation Modal
 */

import { Modal, App, Notice, Setting } from 'obsidian';
import { GitLabClient } from '../api/gitlab-client';
import type GitLabPlugin from '../main';

export class MergeRequestModal extends Modal {
	private plugin: GitLabPlugin;
	private repoId: string;
	private sourceBranch: string;
	private targetBranch: string = 'main';
	private title: string = '';
	private description: string = '';
	private jiraTicket: string = '';
	private availableBranches: string[] = [];
	private loading: boolean = false;

	constructor(app: App, plugin: GitLabPlugin, repoId: string, currentBranch: string, jiraTicket?: string) {
		super(app);
		this.plugin = plugin;
		this.repoId = repoId;
		this.sourceBranch = currentBranch;
		this.title = `Merge ${currentBranch} into main`;
		this.jiraTicket = jiraTicket || '';

		if (this.jiraTicket) {
			this.title = `${this.jiraTicket}: Merge ${currentBranch} into main`;
		}
	}

	async onOpen(): Promise<void> {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gitlab-mr-modal');

		contentEl.createEl('h2', { text: '🔀 Create Merge Request' });

		// Load available branches from GitLab API
		await this.loadBranches();

		// Source branch
		new Setting(contentEl)
			.setName('Source branch')
			.setDesc('Branch to merge from')
			.addText(text => {
				text.setValue(this.sourceBranch);
				text.setDisabled(true);
			});

		// Target branch
		new Setting(contentEl)
			.setName('Target branch')
			.setDesc('Branch to merge into')
			.addDropdown(dropdown => {
				if (this.availableBranches.length > 0) {
					for (const branch of this.availableBranches) {
						dropdown.addOption(branch, branch);
					}
				} else {
					dropdown.addOption('main', 'main');
					dropdown.addOption('master', 'master');
					dropdown.addOption('develop', 'develop');
				}
				dropdown.setValue(this.targetBranch);
				dropdown.onChange(value => {
					this.targetBranch = value;
				});
			});

		// Title
		new Setting(contentEl)
			.setName('Title')
			.addText(text => {
				text.setPlaceholder('Merge request title');
				text.setValue(this.title);
				text.inputEl.style.width = '100%';
				text.onChange(value => {
					this.title = value;
				});
			});

		// JIRA ticket
		new Setting(contentEl)
			.setName('JIRA Ticket')
			.setDesc('Optional — will be prepended to description')
			.addText(text => {
				text.setPlaceholder('e.g. PROJ-123');
				text.setValue(this.jiraTicket);
				text.onChange(value => {
					this.jiraTicket = value;
				});
			});

		// Description
		const descSetting = new Setting(contentEl)
			.setName('Description')
			.setDesc('Markdown supported');
		const descTextarea = descSetting.controlEl.createEl('textarea', {
			cls: 'gitlab-mr-description',
			placeholder: 'Describe the changes...',
		});
		descTextarea.value = this.description;
		descTextarea.rows = 6;
		descTextarea.addEventListener('input', () => {
			this.description = descTextarea.value;
		});

		// Action buttons
		const buttonRow = contentEl.createDiv({ cls: 'gitlab-mr-buttons' });

		const cancelBtn = buttonRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const createBtn = buttonRow.createEl('button', {
			text: 'Create Merge Request',
			cls: 'mod-cta',
		});
		createBtn.addEventListener('click', () => this.handleCreate(createBtn));
	}

	private async loadBranches(): Promise<void> {
		const repoConfig = this.plugin.settings.repositories.find(r => r.id === this.repoId);
		if (!repoConfig) return;

		try {
			const host = GitLabClient.extractHost(repoConfig.repositoryUrl);
			const projectPath = GitLabClient.extractProjectPath(repoConfig.repositoryUrl);
			if (!host || !projectPath) return;

			const client = new GitLabClient({
				host,
				token: repoConfig.token,
				disableSslVerification: repoConfig.disableSslVerification,
			});

			const project = await client.getProject(projectPath);
			const branches = await client.getBranches(project.id);
			this.availableBranches = branches.map(b => b.name);

			// Set default target to the project's default branch
			this.targetBranch = project.default_branch || 'main';
		} catch (error) {
			console.warn('Failed to load branches from GitLab API:', error);
		}
	}

	private async handleCreate(button: HTMLButtonElement): Promise<void> {
		if (!this.title.trim()) {
			new Notice('Please enter a merge request title.');
			return;
		}

		if (this.sourceBranch === this.targetBranch) {
			new Notice('Source and target branches must be different.');
			return;
		}

		button.disabled = true;
		button.textContent = 'Creating...';

		const repoConfig = this.plugin.settings.repositories.find(r => r.id === this.repoId);
		if (!repoConfig) {
			new Notice('Repository configuration not found.');
			return;
		}

		try {
			const host = GitLabClient.extractHost(repoConfig.repositoryUrl);
			const projectPath = GitLabClient.extractProjectPath(repoConfig.repositoryUrl);

			if (!host || !projectPath) {
				new Notice('Failed to extract GitLab host/project from repository URL.');
				return;
			}

			const client = new GitLabClient({
				host,
				token: repoConfig.token,
				disableSslVerification: repoConfig.disableSslVerification,
			});

			const projectId = await client.getProjectId(projectPath);

			// Build description
			let fullDescription = this.description;
			if (this.jiraTicket.trim()) {
				fullDescription = `JIRA: ${this.jiraTicket.trim()}\n\n${fullDescription}`;
			}

			const result = await client.createMergeRequest(projectId, {
				sourceBranch: this.sourceBranch,
				targetBranch: this.targetBranch,
				title: this.title,
				description: fullDescription,
			});

			new Notice(`✅ Merge Request !${result.iid} created successfully!`);

			// Try to open the MR URL in the browser
			if (result.webUrl) {
				window.open(result.webUrl, '_blank');
			}

			this.close();
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			new Notice(`❌ Failed to create MR: ${msg}`);
			button.disabled = false;
			button.textContent = 'Create Merge Request';
		}
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
