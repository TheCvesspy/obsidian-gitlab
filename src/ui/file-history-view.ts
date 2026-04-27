/**
 * File History & Change Author View - Shows commit history and change authors for a specific file
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import type GitLabPlugin from '../main';
import { GitCommit } from '../types';
import { VIEW_TYPE_DIFF } from './diff-view';

export const VIEW_TYPE_FILE_HISTORY = 'gitlab-file-history';

interface BlameEntry {
	startLine: number;
	endLine: number;
	commit: GitCommit;
}

export class FileHistoryView extends ItemView {
	private plugin: GitLabPlugin;
	private filePath: string = '';
	private repoId: string = '';
	private history: GitCommit[] = [];
	private blameEntries: BlameEntry[] = [];
	private selectedCommit: GitCommit | null = null;
	private selectedContent: string = '';
	private showBlame: boolean = false;
	private loading: boolean = false;

	constructor(leaf: WorkspaceLeaf, plugin: GitLabPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_FILE_HISTORY;
	}

	getDisplayText(): string {
		return this.filePath ? `History: ${this.filePath.split('/').pop()}` : 'File History';
	}

	getIcon(): string {
		return 'history';
	}

	async setState(state: { filePath: string; repoId: string }, result: any): Promise<void> {
		this.filePath = state.filePath || '';
		this.repoId = state.repoId || '';
		await this.loadHistory();
		this.render();
		return super.setState(state, result);
	}

	getState(): any {
		return { filePath: this.filePath, repoId: this.repoId };
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private getGitOps() {
		return this.plugin.repositoryManager?.getGitOps(this.repoId);
	}

	private async loadHistory(): Promise<void> {
		const gitOps = this.getGitOps();
		if (!gitOps || !this.filePath) return;

		this.loading = true;
		this.render();

		try {
			this.history = await gitOps.getFileHistory(this.filePath);

			if (this.history.length > 0) {
				this.selectedCommit = this.history[0];
				this.selectedContent = await gitOps.getFileAtCommit(this.filePath, this.selectedCommit.sha) || '';
			}
		} catch (error) {
			console.error('Failed to load file history:', error);
		}

		this.loading = false;
	}

	private async loadBlame(): Promise<void> {
		const gitOps = this.getGitOps();
		if (!gitOps || !this.filePath) return;

		try {
			this.blameEntries = await gitOps.getFileBlame(this.filePath);
		} catch (error) {
			console.error('Failed to load blame:', error);
		}
	}

	private render(): void {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gitlab-history-container');

		// Header
		const header = container.createDiv({ cls: 'gitlab-history-header' });
		header.createEl('span', { text: '📜 ', cls: 'gitlab-history-icon' });
		header.createEl('span', {
			text: this.filePath || 'No file selected',
			cls: 'gitlab-history-filepath',
		});

		if (this.loading) {
			container.createDiv({ cls: 'gitlab-history-loading', text: 'Loading history...' });
			return;
		}

		if (this.history.length === 0) {
			container.createDiv({ cls: 'gitlab-history-empty', text: 'No history found for this file.' });
			return;
		}

		// Toolbar
		const toolbar = container.createDiv({ cls: 'gitlab-history-toolbar' });
		const blameToggle = toolbar.createEl('button', {
			cls: `gitlab-history-btn ${this.showBlame ? 'active' : ''}`,
			text: this.showBlame ? '👤 Authors On' : '👤 Authors Off',
		});
		blameToggle.title = 'Toggle change author annotations';
		blameToggle.addEventListener('click', async () => {
			this.showBlame = !this.showBlame;
			if (this.showBlame && this.blameEntries.length === 0) {
				await this.loadBlame();
			}
			this.render();
		});

		// Main layout: commits list (left) + content (right)
		const mainLayout = container.createDiv({ cls: 'gitlab-history-layout' });

		// Left panel: commit list
		const commitListPanel = mainLayout.createDiv({ cls: 'gitlab-history-commits-panel' });
		commitListPanel.createEl('h4', { text: `Commits (${this.history.length})` });

		const commitList = commitListPanel.createDiv({ cls: 'gitlab-history-commits-list' });
		for (const commit of this.history) {
			const isSelected = this.selectedCommit?.sha === commit.sha;
			const commitEl = commitList.createDiv({
				cls: `gitlab-history-commit-item ${isSelected ? 'selected' : ''}`,
			});

			const commitHeader = commitEl.createDiv({ cls: 'gitlab-history-commit-header' });

			// Author initials avatar
			const initials = commit.authorName
				.split(' ')
				.map(n => n[0])
				.join('')
				.substring(0, 2)
				.toUpperCase();
			commitHeader.createEl('span', { text: initials, cls: 'gitlab-history-avatar' });

			const commitInfo = commitHeader.createDiv({ cls: 'gitlab-history-commit-info' });
			commitInfo.createEl('span', {
				text: commit.message.split('\n')[0].substring(0, 60),
				cls: 'gitlab-history-commit-msg',
			});

			const commitMeta = commitInfo.createDiv({ cls: 'gitlab-history-commit-meta' });
			commitMeta.createEl('span', { text: commit.authorName, cls: 'gitlab-history-author' });
			commitMeta.createEl('span', { text: ' · ' });
			commitMeta.createEl('span', {
				text: this.formatDate(commit.timestamp),
				cls: 'gitlab-history-date',
			});
			commitMeta.createEl('span', { text: ' · ' });
			commitMeta.createEl('span', {
				text: commit.sha.substring(0, 7),
				cls: 'gitlab-history-sha',
			});

			commitEl.addEventListener('click', async () => {
				this.selectedCommit = commit;
				const gitOps = this.getGitOps();
				if (gitOps) {
					this.selectedContent = await gitOps.getFileAtCommit(this.filePath, commit.sha) || '';
				}
				this.render();
			});

			// Compare with current button
			const compareBtn = commitEl.createEl('button', {
				cls: 'gitlab-history-compare-btn',
				text: '↔ Compare',
			});
			compareBtn.title = 'Compare with working copy';
			compareBtn.addEventListener('click', async (e) => {
				e.stopPropagation();
				await this.openDiffWithCurrent(commit);
			});
		}

		// Right panel: file content
		const contentPanel = mainLayout.createDiv({ cls: 'gitlab-history-content-panel' });
		const contentHeader = contentPanel.createDiv({ cls: 'gitlab-history-content-header' });
		if (this.selectedCommit) {
			contentHeader.createEl('span', {
				text: `Version at ${this.selectedCommit.sha.substring(0, 7)} — ${this.formatDate(this.selectedCommit.timestamp)}`,
			});
		}

		const contentBody = contentPanel.createDiv({ cls: 'gitlab-history-content-body' });

		if (this.selectedContent) {
			const lines = this.selectedContent.split('\n');
			const table = contentBody.createEl('table', { cls: 'gitlab-history-content-table' });

			for (let i = 0; i < lines.length; i++) {
				const row = table.createEl('tr');
				const lineNum = i + 1;

				// Blame gutter
				if (this.showBlame) {
					const blameEntry = this.blameEntries.find(
						b => lineNum >= b.startLine && lineNum <= b.endLine
					);
					const blameCell = row.createEl('td', { cls: 'gitlab-history-blame-cell' });
					if (blameEntry && lineNum === blameEntry.startLine) {
						const blameInfo = blameCell.createDiv({ cls: 'gitlab-history-blame-info' });
						blameInfo.createEl('span', {
							text: blameEntry.commit.authorName.substring(0, 12),
							cls: 'gitlab-history-blame-author',
						});
						blameInfo.createEl('span', {
							text: this.formatDateShort(blameEntry.commit.timestamp),
							cls: 'gitlab-history-blame-date',
						});
					}
				}

				// Line number
				row.createEl('td', {
					cls: 'gitlab-history-line-num',
					text: lineNum.toString(),
				});

				// Content
				row.createEl('td', {
					cls: 'gitlab-history-line-content',
					text: lines[i],
				});
			}
		} else {
			contentBody.createEl('p', { text: 'Select a commit to view the file at that point.', cls: 'gitlab-history-placeholder' });
		}
	}

	private async openDiffWithCurrent(commit: GitCommit): Promise<void> {
		const gitOps = this.getGitOps();
		if (!gitOps) return;

		const oldContent = await gitOps.getFileAtCommit(this.filePath, commit.sha) || '';
		const newContent = await gitOps.getWorkingCopyContent(this.filePath) || '';

		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: VIEW_TYPE_DIFF,
			state: {
				filePath: this.filePath,
				repoId: this.repoId,
				oldContent,
				newContent,
				oldLabel: `${commit.sha.substring(0, 7)}`,
				newLabel: 'Working Copy',
			},
		});
	}

	private formatDate(timestamp: number): string {
		const date = new Date(timestamp);
		const now = new Date();
		const diffMs = now.getTime() - date.getTime();
		const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));

		if (diffDays === 0) return 'today';
		if (diffDays === 1) return 'yesterday';
		if (diffDays < 30) return `${diffDays} days ago`;
		return date.toLocaleDateString();
	}

	private formatDateShort(timestamp: number): string {
		const date = new Date(timestamp);
		return `${date.getMonth() + 1}/${date.getDate()}`;
	}
}
