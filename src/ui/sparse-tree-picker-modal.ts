/**
 * Tree picker modal for selecting cone-mode sparse checkout paths.
 *
 * Source priority (auto):
 *   1. If the repo is already cloned locally, use git ls-tree (fast, offline).
 *   2. Otherwise, fetch the tree via the GitLab REST API.
 *
 * Cone mode is folder-only, so only directories are selectable.
 * Selecting a parent implicitly includes everything under it — child
 * checkboxes are visually marked but not separately tracked in the
 * sparse-checkout set.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import { SubTreeConfig } from '../types';
import { GitLabClient } from '../api/gitlab-client';
import type { IGitBackend } from '../api/git-backend';
import { DebugLogger } from '../utils/debug-logger';

interface TreeNode {
	name: string;
	path: string; // POSIX path relative to repo root
	children: Map<string, TreeNode>;
	expanded: boolean;
}

export class SparseTreePickerModal extends Modal {
	private repo: SubTreeConfig;
	private gitOps: IGitBackend | undefined;
	private initialPaths: Set<string>;
	private selectedPaths: Set<string>;
	private onSubmit: (paths: string[]) => void;
	private root: TreeNode;
	private statusEl: HTMLElement | null = null;
	private treeContainerEl: HTMLElement | null = null;
	private summaryEl: HTMLElement | null = null;
	private filterText = '';

	constructor(
		app: App,
		repo: SubTreeConfig,
		gitOps: IGitBackend | undefined,
		currentPaths: string[],
		onSubmit: (paths: string[]) => void,
	) {
		super(app);
		this.repo = repo;
		this.gitOps = gitOps;
		this.initialPaths = new Set(currentPaths.map(p => p.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '')));
		this.selectedPaths = new Set(this.initialPaths);
		this.onSubmit = onSubmit;
		this.root = { name: '', path: '', children: new Map(), expanded: true };
	}

	async onOpen() {
		const { contentEl } = this;
		contentEl.empty();
		contentEl.style.minWidth = '500px';

		contentEl.createEl('h2', { text: 'Pick sparse checkout folders' });

		const sub = contentEl.createEl('p', {
			text: `Select directories to include in ${this.repo.name}. Selecting a folder includes everything under it.`,
		});
		sub.style.fontSize = '0.85em';
		sub.style.opacity = '0.8';

		// Filter input
		const filterRow = contentEl.createDiv();
		filterRow.style.marginBottom = '8px';
		const filterInput = filterRow.createEl('input', {
			type: 'text',
			placeholder: 'Filter folders…',
		});
		filterInput.style.width = '100%';
		filterInput.style.padding = '6px 8px';
		filterInput.addEventListener('input', () => {
			this.filterText = filterInput.value.trim().toLowerCase();
			this.renderTree();
		});

		// Status / loading state
		this.statusEl = contentEl.createDiv();
		this.statusEl.style.padding = '8px';
		this.statusEl.style.opacity = '0.7';
		this.statusEl.style.fontSize = '0.9em';
		this.statusEl.setText('Loading repository tree…');

		// Tree container
		this.treeContainerEl = contentEl.createDiv({ cls: 'gitlab-sparse-tree' });
		this.treeContainerEl.style.maxHeight = '420px';
		this.treeContainerEl.style.overflowY = 'auto';
		this.treeContainerEl.style.border = '1px solid var(--background-modifier-border)';
		this.treeContainerEl.style.borderRadius = '4px';
		this.treeContainerEl.style.padding = '4px';
		this.treeContainerEl.style.fontFamily = 'var(--font-monospace)';
		this.treeContainerEl.style.fontSize = '0.9em';

		// Summary row
		this.summaryEl = contentEl.createDiv();
		this.summaryEl.style.marginTop = '10px';
		this.summaryEl.style.fontSize = '0.85em';
		this.updateSummary();

		// Buttons
		const buttonRow = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonRow.style.display = 'flex';
		buttonRow.style.justifyContent = 'space-between';
		buttonRow.style.gap = '10px';
		buttonRow.style.marginTop = '16px';

		const leftButtons = buttonRow.createDiv();
		leftButtons.style.display = 'flex';
		leftButtons.style.gap = '8px';

		const expandAll = leftButtons.createEl('button', { text: 'Expand all' });
		expandAll.addEventListener('click', () => {
			this.setAllExpanded(this.root, true);
			this.renderTree();
		});
		const collapseAll = leftButtons.createEl('button', { text: 'Collapse all' });
		collapseAll.addEventListener('click', () => {
			this.setAllExpanded(this.root, false);
			this.root.expanded = true;
			this.renderTree();
		});
		const clearAll = leftButtons.createEl('button', { text: 'Clear selection' });
		clearAll.addEventListener('click', () => {
			this.selectedPaths.clear();
			this.renderTree();
			this.updateSummary();
		});

		const rightButtons = buttonRow.createDiv();
		rightButtons.style.display = 'flex';
		rightButtons.style.gap = '8px';

		const cancelBtn = rightButtons.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.close());

		const applyBtn = rightButtons.createEl('button', {
			text: 'Apply',
			cls: 'mod-cta',
		});
		applyBtn.addEventListener('click', () => {
			const result = this.canonicalizeSelection();
			this.onSubmit(result);
			this.close();
		});

		// Kick off tree loading
		await this.loadTree();
	}

	private async loadTree() {
		let folders: string[] = [];
		let source = '';

		// Try local first
		if (this.gitOps) {
			try {
				const isCloned = await this.isRepoCloned();
				if (isCloned) {
					folders = await this.gitOps.listTrackedFolders();
					source = 'local clone';
				}
			} catch (e) {
				DebugLogger.warn('SparseTreePicker', 'Local listing failed, falling back to API', { error: String(e) });
			}
		}

		// Fall back to GitLab API
		if (folders.length === 0) {
			try {
				folders = await this.fetchFoldersFromApi();
				source = 'GitLab API';
			} catch (e) {
				if (this.statusEl) {
					this.statusEl.setText(`Failed to load tree: ${e instanceof Error ? e.message : String(e)}`);
				}
				return;
			}
		}

		if (folders.length === 0) {
			if (this.statusEl) {
				this.statusEl.setText('Repository tree is empty.');
			}
			return;
		}

		// Build tree from flat list
		this.buildTreeFromPaths(folders);

		if (this.statusEl) {
			this.statusEl.setText(`Loaded ${folders.length} folders from ${source}`);
		}

		this.renderTree();
		this.updateSummary();
	}

	private async isRepoCloned(): Promise<boolean> {
		if (!this.gitOps) return false;
		try {
			const folders = await this.gitOps.listTrackedFolders();
			return folders.length > 0;
		} catch {
			return false;
		}
	}

	private async fetchFoldersFromApi(): Promise<string[]> {
		const host = GitLabClient.extractHost(this.repo.repositoryUrl);
		const projectPath = GitLabClient.extractProjectPath(this.repo.repositoryUrl);
		if (!host || !projectPath) {
			throw new Error('Could not parse repository URL');
		}

		const client = new GitLabClient({
			host,
			token: this.repo.token,
			disableSslVerification: this.repo.disableSslVerification,
		});

		const projectId = await client.getProjectId(projectPath);
		const ref = this.repo.currentBranch || undefined;
		return client.listRepositoryFolders(projectId, ref);
	}

	private buildTreeFromPaths(paths: string[]) {
		for (const fullPath of paths) {
			const parts = fullPath.split('/').filter(p => p.length > 0);
			let node = this.root;
			let acc = '';
			for (const part of parts) {
				acc = acc ? `${acc}/${part}` : part;
				let child = node.children.get(part);
				if (!child) {
					child = {
						name: part,
						path: acc,
						children: new Map(),
						expanded: this.shouldAutoExpand(acc),
					};
					node.children.set(part, child);
				}
				node = child;
			}
		}
	}

	/** Auto-expand ancestors of any initially-selected path. */
	private shouldAutoExpand(folderPath: string): boolean {
		for (const sel of this.initialPaths) {
			if (sel === folderPath || sel.startsWith(folderPath + '/')) {
				return true;
			}
		}
		return false;
	}

	private renderTree() {
		if (!this.treeContainerEl) return;
		this.treeContainerEl.empty();

		const filter = this.filterText;
		const renderNode = (node: TreeNode, depth: number, container: HTMLElement) => {
			const children = Array.from(node.children.values()).sort((a, b) => a.name.localeCompare(b.name));

			for (const child of children) {
				const matchesFilter = !filter
					|| child.path.toLowerCase().includes(filter)
					|| this.hasDescendantMatching(child, filter);
				if (!matchesFilter) continue;

				const row = container.createDiv({ cls: 'gitlab-sparse-tree-row' });
				row.style.display = 'flex';
				row.style.alignItems = 'center';
				row.style.gap = '4px';
				row.style.padding = '2px 4px';
				row.style.paddingLeft = `${4 + depth * 16}px`;
				row.style.cursor = 'pointer';
				row.addEventListener('mouseenter', () => {
					row.style.background = 'var(--background-modifier-hover)';
				});
				row.addEventListener('mouseleave', () => {
					row.style.background = '';
				});

				// Chevron / spacer
				const chevron = row.createSpan();
				chevron.style.width = '14px';
				chevron.style.display = 'inline-flex';
				chevron.style.justifyContent = 'center';
				if (child.children.size > 0) {
					try { setIcon(chevron, child.expanded ? 'chevron-down' : 'chevron-right'); }
					catch { chevron.setText(child.expanded ? '▾' : '▸'); }
					chevron.style.cursor = 'pointer';
					chevron.addEventListener('click', (e) => {
						e.stopPropagation();
						child.expanded = !child.expanded;
						this.renderTree();
					});
				}

				// Checkbox
				const checkbox = row.createEl('input', { type: 'checkbox' });
				const state = this.getSelectionState(child);
				checkbox.checked = state === 'checked';
				checkbox.indeterminate = state === 'partial';
				checkbox.addEventListener('click', (e) => e.stopPropagation());
				checkbox.addEventListener('change', () => {
					if (checkbox.checked) {
						this.selectFolder(child);
					} else {
						this.deselectFolder(child);
					}
					this.renderTree();
					this.updateSummary();
				});

				// Folder icon
				const folderIcon = row.createSpan();
				folderIcon.style.opacity = '0.7';
				try { setIcon(folderIcon, 'folder'); } catch { folderIcon.setText('📁'); }

				// Name
				const nameEl = row.createSpan({ text: child.name });
				if (state === 'checked') {
					nameEl.style.fontWeight = '600';
					nameEl.style.color = 'var(--text-accent)';
				}

				// Click row toggles expand (not checkbox)
				row.addEventListener('click', () => {
					if (child.children.size > 0) {
						child.expanded = !child.expanded;
						this.renderTree();
					}
				});

				if (child.expanded && child.children.size > 0) {
					renderNode(child, depth + 1, container);
				}
			}
		};

		renderNode(this.root, 0, this.treeContainerEl);
	}

	private hasDescendantMatching(node: TreeNode, filter: string): boolean {
		for (const child of node.children.values()) {
			if (child.path.toLowerCase().includes(filter)) return true;
			if (this.hasDescendantMatching(child, filter)) return true;
		}
		return false;
	}

	private getSelectionState(node: TreeNode): 'checked' | 'partial' | 'unchecked' {
		// Checked: this exact path is in selection, or an ancestor is
		if (this.isPathIncluded(node.path)) return 'checked';

		// Partial: any descendant is selected
		for (const sel of this.selectedPaths) {
			if (sel.startsWith(node.path + '/')) return 'partial';
		}
		return 'unchecked';
	}

	private isPathIncluded(folderPath: string): boolean {
		if (this.selectedPaths.has(folderPath)) return true;
		for (const sel of this.selectedPaths) {
			if (folderPath === sel || folderPath.startsWith(sel + '/')) return true;
		}
		return false;
	}

	private selectFolder(node: TreeNode) {
		// Remove any descendants already selected — this folder subsumes them
		for (const sel of Array.from(this.selectedPaths)) {
			if (sel.startsWith(node.path + '/')) {
				this.selectedPaths.delete(sel);
			}
		}
		this.selectedPaths.add(node.path);
	}

	private deselectFolder(node: TreeNode) {
		// If exactly this path is selected, remove it
		if (this.selectedPaths.has(node.path)) {
			this.selectedPaths.delete(node.path);
			return;
		}

		// If an ancestor is selected, we need to expand the selection:
		// remove the ancestor and add its other immediate children.
		// (Rare edge case — usually we just removed an exact match above.)
		for (const sel of Array.from(this.selectedPaths)) {
			if (node.path.startsWith(sel + '/')) {
				this.selectedPaths.delete(sel);
				// Walk down from `sel` and add every sibling of the path-to-node
				this.expandSelectionExcept(sel, node.path);
				return;
			}
		}
	}

	/**
	 * When deselecting a node whose ancestor is the selection root, replace
	 * the ancestor selection with the set of all paths between ancestor and
	 * target — minus the target itself.
	 */
	private expandSelectionExcept(ancestorPath: string, excludePath: string) {
		// Find the ancestor node
		const findNode = (root: TreeNode, p: string): TreeNode | null => {
			if (p === '') return root;
			const parts = p.split('/').filter(Boolean);
			let n = root;
			for (const part of parts) {
				const next = n.children.get(part);
				if (!next) return null;
				n = next;
			}
			return n;
		};
		const ancestor = findNode(this.root, ancestorPath);
		if (!ancestor) return;

		// Walk from ancestor toward excludePath; at each step, include siblings
		const remainder = excludePath.substring(ancestorPath.length + 1);
		const remainderParts = remainder.split('/').filter(Boolean);

		let current = ancestor;
		for (const part of remainderParts) {
			for (const [siblingName, siblingNode] of current.children) {
				if (siblingName !== part) {
					this.selectedPaths.add(siblingNode.path);
				}
			}
			const next = current.children.get(part);
			if (!next) return;
			current = next;
		}
	}

	private setAllExpanded(node: TreeNode, expanded: boolean) {
		node.expanded = expanded;
		for (const child of node.children.values()) {
			this.setAllExpanded(child, expanded);
		}
	}

	/**
	 * Collapse the selection set: if a folder and an ancestor are both
	 * selected, drop the redundant child. Returns a sorted, minimal list.
	 */
	private canonicalizeSelection(): string[] {
		const sorted = Array.from(this.selectedPaths).sort();
		const result: string[] = [];
		for (const p of sorted) {
			if (result.some(r => p === r || p.startsWith(r + '/'))) continue;
			result.push(p);
		}
		return result;
	}

	private updateSummary() {
		if (!this.summaryEl) return;
		const canon = this.canonicalizeSelection();
		if (canon.length === 0) {
			this.summaryEl.setText('No folders selected.');
			this.summaryEl.style.color = 'var(--text-muted)';
		} else {
			this.summaryEl.setText(`Selected (${canon.length}): ${canon.join(', ')}`);
			this.summaryEl.style.color = '';
		}
	}

	onClose() {
		this.contentEl.empty();
	}
}
