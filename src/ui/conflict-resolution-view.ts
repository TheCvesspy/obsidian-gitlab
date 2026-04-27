/**
 * Conflict Resolution View - Three-pane merge conflict resolver
 */

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import type GitLabPlugin from '../main';
import { MergeConflict } from '../types';
import { parseConflictMarkers, ConflictSection } from '../utils/diff';
import * as fs from 'fs';
import * as path from 'path';

export const VIEW_TYPE_CONFLICT = 'gitlab-conflict';

interface ConflictFile {
	path: string;
	fullPath: string;
	sections: ConflictSection[];
	resolved: boolean;
	resolvedContent?: string;
}

export class ConflictResolutionView extends ItemView {
	private plugin: GitLabPlugin;
	private repoId: string = '';
	private repoDir: string = '';
	private conflictFiles: ConflictFile[] = [];
	private selectedFileIndex: number = 0;

	constructor(leaf: WorkspaceLeaf, plugin: GitLabPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_CONFLICT;
	}

	getDisplayText(): string {
		return 'Resolve Conflicts';
	}

	getIcon(): string {
		return 'git-merge';
	}

	async setState(state: { repoId: string; conflictPaths: string[]; repoDir: string }, result: any): Promise<void> {
		this.repoId = state.repoId || '';
		this.repoDir = state.repoDir || '';

		if (state.conflictPaths?.length) {
			this.conflictFiles = [];
			for (const filePath of state.conflictPaths) {
				const fullPath = path.join(this.repoDir, filePath);
				try {
					const content = fs.readFileSync(fullPath, 'utf8');
					const sections = parseConflictMarkers(content);
					this.conflictFiles.push({
						path: filePath,
						fullPath,
						sections,
						resolved: sections.length === 0,
					});
				} catch {
					console.error(`Failed to read conflict file: ${filePath}`);
				}
			}
		}

		this.render();
		return super.setState(state, result);
	}

	getState(): any {
		return { repoId: this.repoId };
	}

	async onOpen(): Promise<void> {
		this.render();
	}

	private render(): void {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('gitlab-conflict-container');

		// Header
		const header = container.createDiv({ cls: 'gitlab-conflict-header' });
		header.createEl('h3', { text: '⚠️ Merge Conflicts' });

		const resolvedCount = this.conflictFiles.filter(f => f.resolved).length;
		header.createEl('span', {
			text: `${resolvedCount}/${this.conflictFiles.length} files resolved`,
			cls: 'gitlab-conflict-progress',
		});

		if (this.conflictFiles.length === 0) {
			container.createDiv({
				cls: 'gitlab-conflict-empty',
				text: 'No conflict files loaded.',
			});
			return;
		}

		// File tabs
		const fileTabs = container.createDiv({ cls: 'gitlab-conflict-file-tabs' });
		this.conflictFiles.forEach((file, index) => {
			const tab = fileTabs.createEl('button', {
				cls: `gitlab-conflict-file-tab ${index === this.selectedFileIndex ? 'active' : ''} ${file.resolved ? 'resolved' : ''}`,
				text: `${file.resolved ? '✅' : '❌'} ${file.path.split('/').pop()}`,
			});
			tab.title = file.path;
			tab.addEventListener('click', () => {
				this.selectedFileIndex = index;
				this.render();
			});
		});

		// Selected file conflicts
		const file = this.conflictFiles[this.selectedFileIndex];
		if (!file) return;

		if (file.resolved) {
			const resolvedMsg = container.createDiv({ cls: 'gitlab-conflict-resolved-msg' });
			resolvedMsg.createEl('p', { text: '✅ This file has been resolved.' });
			const unresolveBtn = resolvedMsg.createEl('button', {
				text: 'Undo Resolution',
				cls: 'gitlab-conflict-btn',
			});
			unresolveBtn.addEventListener('click', () => {
				file.resolved = false;
				file.resolvedContent = undefined;
				this.render();
			});
		} else {
			this.renderConflictSections(container, file);
		}

		// Bottom bar
		const bottomBar = container.createDiv({ cls: 'gitlab-conflict-bottom-bar' });

		if (resolvedCount === this.conflictFiles.length && this.conflictFiles.length > 0) {
			const applyBtn = bottomBar.createEl('button', {
				text: '✅ Apply All Resolutions & Stage',
				cls: 'gitlab-conflict-apply-btn',
			});
			applyBtn.addEventListener('click', () => this.applyAllResolutions());
		} else {
			bottomBar.createEl('span', {
				text: `Resolve all ${this.conflictFiles.length - resolvedCount} remaining file(s) to continue.`,
				cls: 'gitlab-conflict-hint',
			});
		}
	}

	private renderConflictSections(container: HTMLElement, file: ConflictFile): void {
		// Read current file content
		let fileContent: string;
		try {
			fileContent = fs.readFileSync(file.fullPath, 'utf8');
		} catch {
			container.createEl('p', { text: 'Failed to read file.' });
			return;
		}

		const lines = fileContent.split('\n');

		for (let sIdx = 0; sIdx < file.sections.length; sIdx++) {
			const section = file.sections[sIdx];
			const sectionEl = container.createDiv({ cls: 'gitlab-conflict-section' });

			sectionEl.createEl('h4', {
				text: `Conflict ${sIdx + 1} of ${file.sections.length}`,
				cls: 'gitlab-conflict-section-title',
			});

			// Three-pane layout
			const panes = sectionEl.createDiv({ cls: 'gitlab-conflict-panes' });

			// Ours pane
			const oursPane = panes.createDiv({ cls: 'gitlab-conflict-pane gitlab-conflict-ours' });
			oursPane.createEl('div', {
				text: `Ours (${section.oursLabel || 'current'})`,
				cls: 'gitlab-conflict-pane-header',
			});
			const oursContent = oursPane.createEl('pre', { cls: 'gitlab-conflict-pane-content' });
			oursContent.createEl('code', { text: section.ours });

			// Theirs pane
			const theirsPane = panes.createDiv({ cls: 'gitlab-conflict-pane gitlab-conflict-theirs' });
			theirsPane.createEl('div', {
				text: `Theirs (${section.theirsLabel || 'incoming'})`,
				cls: 'gitlab-conflict-pane-header',
			});
			const theirsContent = theirsPane.createEl('pre', { cls: 'gitlab-conflict-pane-content' });
			theirsContent.createEl('code', { text: section.theirs });

			// Action buttons
			const actions = sectionEl.createDiv({ cls: 'gitlab-conflict-actions' });

			const acceptOurs = actions.createEl('button', {
				text: '← Accept Ours',
				cls: 'gitlab-conflict-btn gitlab-conflict-btn-ours',
			});
			acceptOurs.addEventListener('click', () => {
				this.resolveSection(file, sIdx, section.ours);
			});

			const acceptTheirs = actions.createEl('button', {
				text: 'Accept Theirs →',
				cls: 'gitlab-conflict-btn gitlab-conflict-btn-theirs',
			});
			acceptTheirs.addEventListener('click', () => {
				this.resolveSection(file, sIdx, section.theirs);
			});

			const acceptBoth = actions.createEl('button', {
				text: 'Accept Both',
				cls: 'gitlab-conflict-btn gitlab-conflict-btn-both',
			});
			acceptBoth.addEventListener('click', () => {
				this.resolveSection(file, sIdx, section.ours + '\n' + section.theirs);
			});
		}
	}

	private resolveSection(file: ConflictFile, sectionIndex: number, resolution: string): void {
		try {
			let content = fs.readFileSync(file.fullPath, 'utf8');
			const section = file.sections[sectionIndex];

			// Build the full conflict marker block to replace
			const lines = content.split('\n');
			const conflictBlock = lines.slice(section.startLine, section.endLine + 1).join('\n');
			content = content.replace(conflictBlock, resolution);

			// Write resolved content
			fs.writeFileSync(file.fullPath, content, 'utf8');

			// Re-parse to check for remaining conflicts
			const remainingSections = parseConflictMarkers(content);
			file.sections = remainingSections;
			file.resolved = remainingSections.length === 0;
			if (file.resolved) {
				file.resolvedContent = content;
			}

			this.render();
			new Notice(`Conflict ${sectionIndex + 1} resolved in ${file.path.split('/').pop()}`);
		} catch (error) {
			new Notice(`Failed to resolve conflict: ${error}`);
		}
	}

	private async applyAllResolutions(): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(this.repoId);
		if (!gitOps) {
			new Notice('Failed to get Git operations');
			return;
		}

		try {
			// Stage all resolved files
			const paths = this.conflictFiles.map(f => f.path);
			await gitOps.add(paths);

			new Notice(`✅ ${paths.length} conflict file(s) staged. Ready to commit.`);

			// Refresh the side panel
			await this.plugin.repositoryManager?.refreshRepository(this.repoId);

			// Close this view
			this.leaf.detach();
		} catch (error) {
			new Notice(`Failed to stage resolved files: ${error}`);
		}
	}
}
