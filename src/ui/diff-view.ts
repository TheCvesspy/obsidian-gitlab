/**
 * Diff View - Shows file differences in an Obsidian tab
 */

import { ItemView, WorkspaceLeaf } from 'obsidian';
import { computeDiff, DiffResult, DiffHunk } from '../utils/diff';
import type GitLabPlugin from '../main';

export const VIEW_TYPE_DIFF = 'gitlab-diff';

export class DiffView extends ItemView {
	private plugin: GitLabPlugin;
	private filePath: string = '';
	private repoId: string = '';
	private diffResult: DiffResult | null = null;
	private oldLabel: string = 'HEAD';
	private newLabel: string = 'Working Copy';

	constructor(leaf: WorkspaceLeaf, plugin: GitLabPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_DIFF;
	}

	getDisplayText(): string {
		return this.filePath ? `Diff: ${this.filePath.split('/').pop()}` : 'Diff View';
	}

	getIcon(): string {
		return 'git-compare';
	}

	async setState(state: { filePath: string; repoId: string; oldContent?: string; newContent?: string; oldLabel?: string; newLabel?: string }, result: any): Promise<void> {
		this.filePath = state.filePath || '';
		this.repoId = state.repoId || '';
		this.oldLabel = state.oldLabel || 'HEAD';
		this.newLabel = state.newLabel || 'Working Copy';

		if (state.oldContent !== undefined && state.newContent !== undefined) {
			this.diffResult = computeDiff(state.oldContent, state.newContent);
		} else {
			await this.loadDiff();
		}

		this.render();
		return super.setState(state, result);
	}

	getState(): any {
		return { filePath: this.filePath, repoId: this.repoId };
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private async loadDiff(): Promise<void> {
		if (!this.filePath || !this.repoId) return;

		const repoConfig = this.plugin.settings.repositories.find(r => r.id === this.repoId);
		if (!repoConfig) return;

		const gitOps = this.plugin.repositoryManager?.getGitOps(this.repoId);
		if (!gitOps) return;

		const oldContent = await gitOps.getFileAtCommit(this.filePath) || '';
		const newContent = await gitOps.getWorkingCopyContent(this.filePath) || '';
		this.diffResult = computeDiff(oldContent, newContent);
	}

	private render(): void {
		const container = this.containerEl.children[1];
		container.empty();
		container.addClass('gitlab-diff-container');

		// Header
		const header = container.createDiv({ cls: 'gitlab-diff-header' });
		header.createEl('span', { text: '📄 ', cls: 'gitlab-diff-icon' });
		header.createEl('span', { text: this.filePath || 'No file selected', cls: 'gitlab-diff-filepath' });

		if (this.diffResult) {
			const stats = header.createDiv({ cls: 'gitlab-diff-stats' });
			if (this.diffResult.additions > 0) {
				stats.createEl('span', {
					text: `+${this.diffResult.additions}`,
					cls: 'gitlab-diff-stat-add',
				});
			}
			if (this.diffResult.deletions > 0) {
				stats.createEl('span', {
					text: `-${this.diffResult.deletions}`,
					cls: 'gitlab-diff-stat-remove',
				});
			}
		}

		if (!this.diffResult || this.diffResult.hunks.length === 0) {
			const empty = container.createDiv({ cls: 'gitlab-diff-empty' });
			empty.createEl('p', { text: this.diffResult ? 'No changes detected.' : 'Loading diff...' });
			return;
		}

		// Labels bar
		const labelsBar = container.createDiv({ cls: 'gitlab-diff-labels' });
		labelsBar.createEl('span', { text: this.oldLabel, cls: 'gitlab-diff-label-old' });
		labelsBar.createEl('span', { text: '→' });
		labelsBar.createEl('span', { text: this.newLabel, cls: 'gitlab-diff-label-new' });

		// Render hunks
		const diffBody = container.createDiv({ cls: 'gitlab-diff-body' });

		for (const hunk of this.diffResult.hunks) {
			this.renderHunk(diffBody, hunk);
		}
	}

	private renderHunk(container: HTMLElement, hunk: DiffHunk): void {
		const hunkEl = container.createDiv({ cls: 'gitlab-diff-hunk' });

		// Hunk header
		const hunkHeader = hunkEl.createDiv({ cls: 'gitlab-diff-hunk-header' });
		hunkHeader.createEl('span', {
			text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
		});

		// Hunk lines
		const table = hunkEl.createEl('table', { cls: 'gitlab-diff-table' });

		for (const line of hunk.lines) {
			const row = table.createEl('tr', {
				cls: `gitlab-diff-line gitlab-diff-line-${line.type}`,
			});

			// Old line number
			row.createEl('td', {
				cls: 'gitlab-diff-linenum gitlab-diff-linenum-old',
				text: line.oldLineNumber?.toString() || '',
			});

			// New line number
			row.createEl('td', {
				cls: 'gitlab-diff-linenum gitlab-diff-linenum-new',
				text: line.newLineNumber?.toString() || '',
			});

			// Marker
			const marker = line.type === 'add' ? '+' : line.type === 'remove' ? '-' : ' ';
			row.createEl('td', {
				cls: 'gitlab-diff-marker',
				text: marker,
			});

			// Content
			row.createEl('td', {
				cls: 'gitlab-diff-content',
				text: line.content,
			});
		}
	}
}
