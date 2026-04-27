/**
 * Move Files Modal
 *
 * Moves one or more files within a repository to a destination folder,
 * optionally renaming in the single-file case. Handles two file classes:
 *
 *  - Obsidian-native files (.md, canvas, images Obsidian recognises):
 *    uses app.fileManager.renameFile() so internal [[wiki links]] and
 *    ![[embeds]] get rewritten silently.
 *  - Non-native files (.vtt, .eml, binaries, anything Obsidian hides):
 *    uses fs.promises.rename directly — Obsidian has no bookkeeping for
 *    these, so a plain FS rename is correct.
 *
 * Post-move refresh is handled by the fs.watch installed per-repo; no
 * explicit refresh is called here.
 */

import { Modal, App, Notice, Setting, FuzzySuggestModal, TFile, TFolder } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import GitLabPlugin from '../main';
import { RepositoryState } from '../types';

interface FolderNode {
	name: string;
	relativePath: string;
	children: FolderNode[];
}

export class MoveFilesModal extends Modal {
	private plugin: GitLabPlugin;
	private repoState: RepositoryState;
	private selected: string[] = [];
	private destPath: string = '';
	private newName: string = '';
	private overwrite: boolean = false;
	private expanded = new Set<string>(['']);
	private tree: FolderNode | null = null;

	private selectedListEl: HTMLElement | null = null;
	private treeContainer: HTMLElement | null = null;
	private destLabelEl: HTMLElement | null = null;
	private renameRowEl: HTMLElement | null = null;
	private renameInputEl: HTMLInputElement | null = null;

	constructor(app: App, plugin: GitLabPlugin, repoState: RepositoryState, preselected: string[]) {
		super(app);
		this.plugin = plugin;
		this.repoState = repoState;
		this.selected = Array.from(new Set(preselected));
		this.updateDefaultName();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gitlab-move-modal');

		contentEl.createEl('h2', { text: 'Move files' });
		contentEl.createEl('p', {
			text: `Repository: ${this.repoState.config.name}. Destinations outside the repo are not allowed.`,
			cls: 'setting-item-description',
		});

		// Selected files
		contentEl.createEl('h4', { text: 'Files to move' });
		this.selectedListEl = contentEl.createDiv({ cls: 'gitlab-move-selected-list' });
		this.renderSelectedList();

		const addBtnRow = contentEl.createDiv({ cls: 'gitlab-move-addrow' });
		const addMoreBtn = addBtnRow.createEl('button', { text: '+ Add more…' });
		addMoreBtn.addEventListener('click', () => this.openAddMorePicker());

		// Destination
		contentEl.createEl('h4', { text: 'Destination folder' });
		this.destLabelEl = contentEl.createDiv({ cls: 'gitlab-move-dest-label' });
		this.updateDestLabel();
		this.treeContainer = contentEl.createDiv({ cls: 'gitlab-upload-tree' });
		this.tree = this.buildTree();
		this.renderTree();

		// Rename (single-file mode only)
		this.renameRowEl = contentEl.createDiv({ cls: 'gitlab-move-rename-row' });
		const renameSetting = new Setting(this.renameRowEl)
			.setName('New filename')
			.setDesc('Rename the file as part of the move. Leave unchanged to keep the name.');
		const renameInput = renameSetting.controlEl.createEl('input', {
			type: 'text',
			cls: 'gitlab-move-rename-input',
		}) as HTMLInputElement;
		renameInput.value = this.newName;
		renameInput.addEventListener('input', () => (this.newName = renameInput.value));
		this.renameInputEl = renameInput;
		this.updateRenameVisibility();

		// Overwrite toggle
		new Setting(contentEl)
			.setName('Overwrite existing files')
			.setDesc('If unchecked, destinations that already exist are skipped.')
			.addToggle((t) => t.setValue(false).onChange((v) => (this.overwrite = v)));

		// Buttons
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		btnRow.createEl('button', { text: 'Cancel' }).addEventListener('click', () => this.close());
		btnRow.createEl('button', { text: 'Move', cls: 'mod-cta' }).addEventListener('click', () => this.doMove());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	// ---------- rendering helpers ----------

	private renderSelectedList(): void {
		if (!this.selectedListEl) return;
		this.selectedListEl.empty();

		if (this.selected.length === 0) {
			this.selectedListEl.createEl('p', {
				text: 'No files selected. Click “+ Add more…” to pick files from the repository.',
				cls: 'setting-item-description',
			});
			return;
		}

		for (const p of this.selected) {
			const row = this.selectedListEl.createDiv({ cls: 'gitlab-move-selected-row' });
			row.createEl('span', { text: p, cls: 'gitlab-move-selected-path' });
			const remove = row.createEl('button', { text: '✕', cls: 'gitlab-move-remove-btn' });
			remove.title = 'Remove from selection';
			remove.addEventListener('click', () => {
				this.selected = this.selected.filter((x) => x !== p);
				this.updateDefaultName();
				if (this.renameInputEl) this.renameInputEl.value = this.newName;
				this.renderSelectedList();
				this.updateRenameVisibility();
			});
		}
	}

	private updateDefaultName(): void {
		if (this.selected.length === 1) {
			this.newName = path.basename(this.selected[0]);
		} else {
			this.newName = '';
		}
	}

	private updateRenameVisibility(): void {
		if (!this.renameRowEl) return;
		if (this.selected.length === 1) {
			this.renameRowEl.style.display = '';
		} else {
			this.renameRowEl.style.display = 'none';
		}
	}

	private updateDestLabel(): void {
		if (!this.destLabelEl) return;
		const display = this.destPath === '' ? '<repo root>' : this.destPath;
		this.destLabelEl.setText(`Target: ${display}`);
	}

	private renderTree(): void {
		if (!this.treeContainer || !this.tree) return;
		this.treeContainer.empty();
		this.renderNode(this.tree, this.treeContainer, 0);
	}

	private renderNode(node: FolderNode, parent: HTMLElement, depth: number): void {
		const row = parent.createDiv({ cls: 'gitlab-upload-tree-row' });
		row.style.paddingLeft = `${depth * 16}px`;
		if (this.destPath === node.relativePath) row.addClass('is-selected');

		const hasChildren = node.children.length > 0;
		const isExpanded = this.expanded.has(node.relativePath);

		const chevron = row.createEl('span', {
			text: hasChildren ? (isExpanded ? '▼' : '▶') : ' ',
			cls: 'gitlab-upload-tree-chevron',
		});
		if (hasChildren) {
			chevron.addEventListener('click', (e) => {
				e.stopPropagation();
				if (isExpanded) this.expanded.delete(node.relativePath);
				else this.expanded.add(node.relativePath);
				this.renderTree();
			});
		}

		row.createEl('span', {
			text: node.name,
			cls: 'gitlab-upload-tree-label',
		});

		row.addEventListener('click', () => {
			this.destPath = node.relativePath;
			this.updateDestLabel();
			this.renderTree();
		});

		if (isExpanded) {
			for (const child of node.children) {
				this.renderNode(child, parent, depth + 1);
			}
		}
	}

	// ---------- source data ----------

	private getRepoFullPath(): string {
		const basePath = (this.app.vault.adapter as any).basePath as string;
		return path.join(basePath, this.repoState.config.localPath);
	}

	private buildTree(): FolderNode {
		return this.walkDir(this.getRepoFullPath(), '');
	}

	private walkDir(absPath: string, relPath: string): FolderNode {
		const name = relPath === '' ? this.repoState.config.name || '/' : path.basename(absPath);
		const children: FolderNode[] = [];
		try {
			const entries = fs.readdirSync(absPath, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				if (entry.name === '.git' || entry.name === 'node_modules') continue;
				const childAbs = path.join(absPath, entry.name);
				const childRel = relPath ? `${relPath}/${entry.name}` : entry.name;
				children.push(this.walkDir(childAbs, childRel));
			}
			children.sort((a, b) => a.name.localeCompare(b.name));
		} catch {
			/* unreadable — skip */
		}
		return { name, relativePath: relPath, children };
	}

	private openAddMorePicker(): void {
		const gitOps = this.plugin.repositoryManager?.getGitOps(this.repoState.config.id);
		if (!gitOps) {
			new Notice('Repository not available');
			return;
		}
		gitOps
			.listAllFiles()
			.then((entries) => {
				const already = new Set(this.selected);
				const candidates = entries
					.filter((e) => !e.isDirectory)
					.map((e) => e.path)
					.filter((p) => !already.has(p));
				if (candidates.length === 0) {
					new Notice('No more files to add.');
					return;
				}
				new RepoFileSuggestModal(this.app, candidates, (picked) => {
					this.selected.push(picked);
					this.updateDefaultName();
					if (this.renameInputEl) this.renameInputEl.value = this.newName;
					this.renderSelectedList();
					this.updateRenameVisibility();
				}).open();
			})
			.catch((err) => {
				console.error('Failed to list repo files:', err);
				new Notice('Failed to list repository files');
			});
	}

	// ---------- execute ----------

	private async doMove(): Promise<void> {
		if (this.selected.length === 0) {
			new Notice('No files selected.');
			return;
		}

		const vaultBase = (this.app.vault.adapter as any).basePath as string;
		const repoLocal = this.repoState.config.localPath;
		const absRepoDir = path.join(vaultBase, repoLocal);
		const absDestDir = path.join(absRepoDir, this.destPath);

		try {
			fs.mkdirSync(absDestDir, { recursive: true });
		} catch (err) {
			console.error('Could not create destination folder:', err);
			new Notice('Could not create destination folder.');
			return;
		}

		let moved = 0;
		let skipped = 0;
		let failed = 0;

		for (const src of this.selected) {
			const finalName = this.selected.length === 1 && this.newName.trim()
				? this.newName.trim()
				: path.basename(src);

			const destRepoRel = this.destPath ? `${this.destPath}/${finalName}` : finalName;

			// No-op: same path
			if (destRepoRel === src) {
				skipped++;
				continue;
			}

			const absSrc = path.join(absRepoDir, src);
			const absDest = path.join(absRepoDir, destRepoRel);

			try {
				if (!fs.existsSync(absSrc)) {
					failed++;
					console.warn(`Move source missing: ${absSrc}`);
					continue;
				}
				if (fs.existsSync(absDest) && !this.overwrite) {
					skipped++;
					continue;
				}

				const vaultRelSrc = this.toVaultRel(repoLocal, src);
				const vaultRelDest = this.toVaultRel(repoLocal, destRepoRel);
				const tfile = this.app.vault.getAbstractFileByPath(vaultRelSrc);

				if (tfile instanceof TFile || tfile instanceof TFolder) {
					if (fs.existsSync(absDest) && this.overwrite) {
						// fileManager.renameFile refuses to overwrite; remove target first.
						await fs.promises.unlink(absDest);
					}
					await this.app.fileManager.renameFile(tfile, vaultRelDest);
				} else {
					if (fs.existsSync(absDest) && this.overwrite) {
						await fs.promises.unlink(absDest);
					}
					await fs.promises.rename(absSrc, absDest);
				}
				moved++;
			} catch (err) {
				console.error(`Failed to move ${src} → ${destRepoRel}:`, err);
				failed++;
			}
		}

		const parts: string[] = [`Moved ${moved}`];
		if (skipped) parts.push(`skipped ${skipped}`);
		if (failed) parts.push(`${failed} failed`);
		new Notice(parts.join(', '));

		this.close();
	}

	private toVaultRel(repoLocal: string, repoRel: string): string {
		const joined = repoLocal ? `${repoLocal}/${repoRel}` : repoRel;
		return joined.replace(/\\/g, '/');
	}
}

/**
 * Fuzzy-pick a single repo-relative path from a provided list.
 */
class RepoFileSuggestModal extends FuzzySuggestModal<string> {
	private candidates: string[];
	private onPick: (picked: string) => void;

	constructor(app: App, candidates: string[], onPick: (picked: string) => void) {
		super(app);
		this.candidates = candidates;
		this.onPick = onPick;
		this.setPlaceholder('Search repository files…');
	}

	getItems(): string[] {
		return this.candidates;
	}

	getItemText(item: string): string {
		return item;
	}

	onChooseItem(item: string): void {
		this.onPick(item);
	}
}
