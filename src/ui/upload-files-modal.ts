/**
 * Upload Files Modal
 *
 * Lets the user copy arbitrary files from their disk into a configured
 * repository, with a tree picker for the destination folder. Intended
 * mainly for non-Obsidian-native file types (.vtt, .eml, .html, binaries)
 * that Obsidian's file explorer refuses to show, so the user can still
 * manage them from inside Obsidian.
 *
 * After the copy, the RepositoryManager's fs.watch picks up the new files
 * and the side panel auto-refreshes — no explicit refresh call here.
 */

import { Modal, App, Notice, Setting } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import GitLabPlugin from '../main';
import { RepositoryState } from '../types';

interface FolderNode {
	name: string;
	relativePath: string;
	children: FolderNode[];
}

export class UploadFilesModal extends Modal {
	private plugin: GitLabPlugin;
	private repoState: RepositoryState;
	private selectedFiles: File[] = [];
	private selectedPath: string = '';
	private overwrite: boolean = false;
	private expanded = new Set<string>(['']);
	private tree: FolderNode | null = null;
	private treeContainer: HTMLElement | null = null;
	private fileCountEl: HTMLElement | null = null;
	private destLabelEl: HTMLElement | null = null;

	constructor(app: App, plugin: GitLabPlugin, repoState: RepositoryState) {
		super(app);
		this.plugin = plugin;
		this.repoState = repoState;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.addClass('gitlab-upload-modal');

		contentEl.createEl('h2', { text: 'Add files to repository' });
		contentEl.createEl('p', {
			text: `Copy files from disk into “${this.repoState.config.name}”. Works with any file type, including ones Obsidian's file explorer hides.`,
			cls: 'setting-item-description',
		});

		// File picker
		const fileSetting = new Setting(contentEl)
			.setName('Files')
			.setDesc('Select one or more files');
		const fileInput = fileSetting.controlEl.createEl('input', {
			type: 'file',
		}) as HTMLInputElement;
		fileInput.multiple = true;
		fileInput.addEventListener('change', () => {
			this.selectedFiles = Array.from(fileInput.files || []);
			this.updateFileCount();
		});

		this.fileCountEl = contentEl.createDiv({ cls: 'gitlab-upload-filecount' });
		this.updateFileCount();

		// Destination tree
		contentEl.createEl('h4', { text: 'Destination folder' });
		this.destLabelEl = contentEl.createDiv({ cls: 'gitlab-upload-dest-label' });
		this.updateDestLabel();
		this.treeContainer = contentEl.createDiv({ cls: 'gitlab-upload-tree' });
		this.tree = this.buildTree();
		this.renderTree();

		// Overwrite toggle
		new Setting(contentEl)
			.setName('Overwrite existing files')
			.setDesc('If unchecked, files that already exist at the destination are skipped.')
			.addToggle((t) => t.setValue(false).onChange((v) => (this.overwrite = v)));

		// Buttons
		const btnRow = contentEl.createDiv({ cls: 'modal-button-container' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());
		const addBtn = btnRow.createEl('button', { text: 'Add files', cls: 'mod-cta' });
		addBtn.addEventListener('click', () => this.doUpload());
	}

	onClose(): void {
		this.contentEl.empty();
	}

	private updateFileCount(): void {
		if (!this.fileCountEl) return;
		const n = this.selectedFiles.length;
		this.fileCountEl.setText(n === 0 ? 'No files selected.' : `${n} file${n === 1 ? '' : 's'} selected.`);
	}

	private updateDestLabel(): void {
		if (!this.destLabelEl) return;
		const display = this.selectedPath === '' ? '<repo root>' : this.selectedPath;
		this.destLabelEl.setText(`Target: ${display}`);
	}

	private getRepoFullPath(): string {
		const cfg = this.repoState.config;
		const basePath = (this.app.vault.adapter as any).basePath as string;
		const rel = cfg.hiddenClone?.enabled && cfg.hiddenClone.cloneFolder
			? cfg.hiddenClone.cloneFolder
			: cfg.localPath;
		return path.join(basePath, rel);
	}

	private buildTree(): FolderNode {
		const rootAbs = this.getRepoFullPath();
		return this.walkDir(rootAbs, '');
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
			/* unreadable dir — skip */
		}
		return { name, relativePath: relPath, children };
	}

	private renderTree(): void {
		if (!this.treeContainer || !this.tree) return;
		this.treeContainer.empty();
		this.renderNode(this.tree, this.treeContainer, 0);
	}

	private renderNode(node: FolderNode, parent: HTMLElement, depth: number): void {
		const row = parent.createDiv({ cls: 'gitlab-upload-tree-row' });
		row.style.paddingLeft = `${depth * 16}px`;
		if (this.selectedPath === node.relativePath) row.addClass('is-selected');

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
			this.selectedPath = node.relativePath;
			this.updateDestLabel();
			this.renderTree();
		});

		if (isExpanded) {
			for (const child of node.children) {
				this.renderNode(child, parent, depth + 1);
			}
		}
	}

	private async doUpload(): Promise<void> {
		if (this.selectedFiles.length === 0) {
			new Notice('No files selected.');
			return;
		}

		const destDir = path.join(this.getRepoFullPath(), this.selectedPath);
		let copied = 0;
		let skipped = 0;
		let failed = 0;

		try {
			fs.mkdirSync(destDir, { recursive: true });
		} catch (err) {
			console.error('Could not create destination folder:', err);
			new Notice('Could not create destination folder.');
			return;
		}

		for (const file of this.selectedFiles) {
			// Electron's File objects expose `.path` — the real disk path of
			// the dropped/picked file. Browser File objects do not, but
			// Obsidian runs in Electron so this is reliable here.
			const srcPath = (file as unknown as { path?: string }).path;
			const destPath = path.join(destDir, file.name);
			try {
				if (fs.existsSync(destPath) && !this.overwrite) {
					skipped++;
					continue;
				}
				if (srcPath) {
					await fs.promises.copyFile(srcPath, destPath);
				} else {
					// Fallback: read the File via ArrayBuffer and write bytes.
					const buf = Buffer.from(await file.arrayBuffer());
					await fs.promises.writeFile(destPath, buf);
				}
				copied++;
			} catch (err) {
				console.error(`Failed to copy ${file.name}:`, err);
				failed++;
			}
		}

		const parts: string[] = [];
		parts.push(`Added ${copied}`);
		if (skipped) parts.push(`skipped ${skipped}`);
		if (failed) parts.push(`${failed} failed`);
		new Notice(parts.join(', '));

		// The fs.watch on the repo will pick up the new files and re-render
		// the side panel on the next debounce tick — no explicit refresh.
		this.close();
	}
}
