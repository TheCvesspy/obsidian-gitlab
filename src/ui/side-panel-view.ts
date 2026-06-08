/**
 * GitLab Side Panel View
 * Main UI for Git operations
 */

import { ItemView, WorkspaceLeaf, Notice, Setting, Modal, App, setIcon } from 'obsidian';
import GitLabPlugin from '../main';
import { RepositoryState, FileStatus, GitBranch, GitTag } from '../types';
import { MergeRequestModal } from './merge-request-modal';
import { GitLabClient } from '../api/gitlab-client';
import { HELP_TEXT } from '../utils/help-text';
import { PagesCompatPipeline, PagesCompatTransformError } from '../core/pages-compat-pipeline';
import { UploadFilesModal } from './upload-files-modal';
import { MoveFilesModal } from './move-files-modal';
import { Tabs, TabDef } from './components/tabs';
import { renderHeaderBar, HeaderBarCallbacks } from './components/header-bar';
import {
	CheckoutConflictModal,
	BranchSwitchModal,
	CreateBranchModal,
	CreateTagModal,
	HelpTooltipModal,
} from './side-panel/modals';
import { renderStashSection, runStashCreate, StashSectionDeps } from './side-panel/stash-section';

const DEFAULT_TAB_ID = 'changes';
const TAB_IDS = ['changes', 'files', 'history', 'branches', 'remote'] as const;
type SidePanelTabId = typeof TAB_IDS[number];

export const VIEW_TYPE_GITLAB = 'gitlab-panel';

/**
 * Side panel view for Git operations
 */
export class GitLabView extends ItemView {
	plugin: GitLabPlugin;
	private selectedRepoId: string | null = null;
	private commitMessage: string = '';
	private jiraTicket: string = '';
	private collapsedSections: Set<string> = new Set();
	private renderInProgress = false;
	private renderQueued = false;
	private selectedTemplateId: string = '';
	private browserExpanded = false;
	private focusedElementClass: string | null = null;
	private cursorPosition: number | null = null;
	private amendMode = false;
	private expandedMrIid: number | null = null;
	private tabs?: Tabs;

	constructor(leaf: WorkspaceLeaf, plugin: GitLabPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_GITLAB;
	}

	getDisplayText(): string {
		return 'GitLab';
	}

	getIcon(): string {
		return 'gitlab-logo';
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		this.tabs?.destroy();
		this.tabs = undefined;
	}

	/**
	 * Create a section header with an info tooltip icon and optional collapse toggle.
	 * When collapsible, returns a content div that is shown/hidden on toggle.
	 */
	private createSectionHeader(
		container: HTMLElement,
		text: string,
		helpKey: string,
		options?: { collapsible?: boolean; extraButtons?: (headerRow: HTMLElement) => void }
	): { header: HTMLElement; content: HTMLElement | null } {
		const header = container.createDiv({ cls: 'gitlab-section-header-row' });
		const isCollapsible = options?.collapsible ?? false;
		const isCollapsed = isCollapsible && this.collapsedSections.has(helpKey);

		if (isCollapsible) {
			const toggle = header.createEl('span', {
				text: isCollapsed ? '▶' : '▼',
				cls: 'gitlab-section-toggle',
			});
			header.addClass('gitlab-section-header-clickable');
		}

		header.createEl('h4', { text });

		const help = HELP_TEXT[helpKey];
		if (help) {
			const infoBtn = header.createEl('span', {
				text: 'ⓘ',
				cls: 'gitlab-info-icon',
			});
			infoBtn.title = `${help.short}\n\n${help.detail}`;
			infoBtn.addEventListener('click', (e) => {
				e.stopPropagation();
				new HelpTooltipModal(this.app, help.title, help.detail).open();
			});
		}

		// Allow caller to add extra buttons to the header row
		if (options?.extraButtons) {
			options.extraButtons(header);
		}

		let contentDiv: HTMLElement | null = null;
		if (isCollapsible) {
			contentDiv = container.createDiv({ cls: 'gitlab-section-content' });
			if (isCollapsed) {
				contentDiv.addClass('gitlab-section-collapsed');
			}
			header.addEventListener('click', (e) => {
				const target = e.target as HTMLElement;
				if (target.closest('.gitlab-info-icon') || target.closest('.gitlab-small-button') || target.closest('.gitlab-tiny-button') || target.tagName === 'BUTTON') return;
				const nowCollapsed = !contentDiv!.classList.contains('gitlab-section-collapsed');
				contentDiv!.classList.toggle('gitlab-section-collapsed');
				const toggleEl = header.querySelector('.gitlab-section-toggle');
				if (toggleEl) toggleEl.textContent = nowCollapsed ? '▶' : '▼';
				if (nowCollapsed) {
					this.collapsedSections.add(helpKey);
				} else {
					this.collapsedSections.delete(helpKey);
				}
			});
		}

		return { header, content: contentDiv };
	}

	/**
	 * Render the panel (with debounce guard to prevent double-render)
	 */
	async render(): Promise<void> {
		if (this.renderInProgress) {
			this.renderQueued = true;
			return;
		}
		this.renderInProgress = true;

		try {
			await this.doRender();
		} finally {
			this.renderInProgress = false;
			if (this.renderQueued) {
				this.renderQueued = false;
				await this.render();
			}
		}
	}

	private async doRender(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;

		// Save scroll position
		const savedScrollTop = container.scrollTop;

		// Save focus state
		const activeEl = document.activeElement as HTMLElement | null;
		if (activeEl && container.contains(activeEl)) {
			if (activeEl.classList.contains('gitlab-commit-message')) {
				this.focusedElementClass = 'gitlab-commit-message';
				this.cursorPosition = (activeEl as HTMLTextAreaElement).selectionStart;
			} else if (activeEl.classList.contains('gitlab-jira-input')) {
				this.focusedElementClass = 'gitlab-jira-input';
				this.cursorPosition = (activeEl as HTMLInputElement).selectionStart;
			} else {
				this.focusedElementClass = null;
				this.cursorPosition = null;
			}
		}

		container.empty();
		this.tabs?.destroy();
		this.tabs = undefined;

		// Refresh file explorer decorations
		this.plugin.fileExplorerDecorator?.refresh();
		container.addClass('gitlab-panel');

		const repositories = this.plugin.settings.repositories.filter(r => r.enabled);

		// Auto-select first repository if none selected
		if (!this.selectedRepoId && repositories.length > 0) {
			this.selectedRepoId = repositories[0].id;
		}

		const state = this.selectedRepoId
			? this.plugin.repositoryManager?.getRepository(this.selectedRepoId) ?? null
			: null;

		// Sticky header bar (repo selector + branch + sync + primary actions)
		renderHeaderBar(container, {
			repositories,
			selectedRepoId: this.selectedRepoId,
			state,
			callbacks: this.buildHeaderCallbacks(state),
		});

		if (repositories.length === 0) {
			container.createEl('p', {
				text: 'No repositories configured. Add one in Settings → GitLab Integration.',
				cls: 'setting-item-description',
			});
		} else if (!state) {
			container.createEl('p', {
				text: 'No repository selected. Pick one above or configure repositories in settings.',
				cls: 'setting-item-description',
			});
		} else {
			await this.renderRepositoryView(container, state);
		}

		// Restore scroll position
		container.scrollTop = savedScrollTop;

		// Restore focus
		if (this.focusedElementClass) {
			const el = container.querySelector(`.${this.focusedElementClass}`) as HTMLElement | null;
			if (el) {
				el.focus();
				if (this.cursorPosition !== null && ('selectionStart' in el)) {
					(el as HTMLInputElement | HTMLTextAreaElement).selectionStart = this.cursorPosition;
					(el as HTMLInputElement | HTMLTextAreaElement).selectionEnd = this.cursorPosition;
				}
			}
			this.focusedElementClass = null;
			this.cursorPosition = null;
		}
	}

	/**
	 * Build the callback bag passed to the HeaderBar. Centralizes the bridge
	 * between the new presentational header and the existing private handlers
	 * on this view, keeping all git-operation logic in one place.
	 */
	private buildHeaderCallbacks(state: RepositoryState | null): HeaderBarCallbacks {
		return {
			onSelectRepo: async (repoId: string) => {
				this.selectedRepoId = repoId;
				await this.render();
			},
			onUpload: () => {
				if (!state) { new Notice('Select a repository first'); return; }
				new UploadFilesModal(this.app, this.plugin, state).open();
			},
			onRefresh: async () => {
				if (!this.selectedRepoId) return;
				await this.plugin.repositoryManager?.refreshRepository(this.selectedRepoId);
				await this.render();
				new Notice('Repository refreshed');
			},
			onSwitchBranch: async (branchName: string) => {
				if (!state) return;
				// switchBranchInteractive expects a <select> element so it can revert
				// the visual selection on cancel/failure. Here we re-render anyway so
				// pass the live select element from the DOM if present, otherwise a
				// detached one (the revert will be a no-op since we re-render).
				const select = this.containerEl.querySelector<HTMLSelectElement>('.gitlab-headerbar-branch-select')
					?? document.createElement('select');
				await this.switchBranchInteractive(state, branchName, select);
			},
			onCreateBranch: async () => { if (state) await this.handleCreateBranch(state); },
			onCleanOrphans: async () => {
				if (!state) return;
				const orphans = (state.branches ?? []).filter(b => b.remoteExists === false && !b.isCurrent);
				if (orphans.length > 0) await this.handleDeleteOrphanedBranches(state, orphans);
			},
			onPull: async () => { if (state) await this.handlePull(state); },
			onPush: async () => { if (state) await this.handlePush(state); },
			onFetch: async () => { if (state) await this.handleFetch(state); },
			overflowItems: state ? this.buildOverflowItems(state) : [],
		};
	}

	/**
	 * Items shown in the header overflow ⋯ menu. Houses less-frequent actions
	 * that used to live as buttons in the old action row (Graph, MR, Open in
	 * GitLab) plus help.
	 */
	private buildOverflowItems(state: RepositoryState): HeaderBarCallbacks['overflowItems'] {
		const items: HeaderBarCallbacks['overflowItems'] = [];
		items.push({
			title: 'Open Git Graph',
			icon: 'git-branch',
			onClick: () => this.plugin.openGitGraph(state.config.id),
		});
		items.push({
			title: 'Create Merge Request…',
			icon: 'git-pull-request',
			onClick: () => new MergeRequestModal(
				this.app, this.plugin, state.config.id, state.currentBranch, this.jiraTicket
			).open(),
		});
		items.push({
			title: 'Open in GitLab (browser)',
			icon: 'globe',
			onClick: () => {
				const url = GitLabClient.buildWebUrl(state.config.repositoryUrl, state.currentBranch);
				if (url) window.open(url, '_blank');
				else new Notice('Could not construct GitLab URL');
			},
		});
		items.push({
			title: 'Move files…',
			icon: 'folder-input',
			onClick: () => new MoveFilesModal(this.app, this.plugin, state, []).open(),
		});
		return items;
	}

	/**
	 * Resolve which tab should be active for the current repo, falling back to
	 * the default if no preference has been stored or the stored value is
	 * unknown.
	 */
	private getActiveTabId(repoId: string): SidePanelTabId {
		const stored = this.plugin.settings.activeTabByRepo?.[repoId];
		if (stored && (TAB_IDS as readonly string[]).includes(stored)) {
			return stored as SidePanelTabId;
		}
		return DEFAULT_TAB_ID;
	}

	private async setActiveTabId(repoId: string, id: SidePanelTabId): Promise<void> {
		const map = this.plugin.settings.activeTabByRepo ?? {};
		if (map[repoId] === id) return;
		map[repoId] = id;
		this.plugin.settings.activeTabByRepo = map;
		await this.plugin.settingsManager.saveSettings();
	}

	/**
	 * Render repository view: orphan banner (if any) + tabbed body.
	 */
	private async renderRepositoryView(container: HTMLElement, state: RepositoryState): Promise<void> {
		// Orphan banner stays visible regardless of active tab — it's a critical signal.
		const currentBranchInfo = state.branches?.find(b => b.name === state.currentBranch);
		if (currentBranchInfo?.remoteExists === false) {
			this.renderOrphanCurrentBanner(container, state);
		}

		const repoId = state.config.id;
		const fileCount = state.files?.length ?? 0;
		const tabDefs: TabDef[] = [
			{ id: 'changes',  label: 'Changes',  icon: 'file-diff',         badge: fileCount, tooltip: 'Modified files & commit' },
			{ id: 'files',    label: 'Files',    icon: 'folder-tree',       tooltip: 'Browse all repository files' },
			{ id: 'history',  label: 'History',  icon: 'history',           tooltip: 'Commit history' },
			{ id: 'branches', label: 'Branches', icon: 'git-branch',        tooltip: 'Branches and tags' },
			{ id: 'remote',   label: 'Remote',   icon: 'cloud',             tooltip: 'Merge requests & pipelines' },
		];

		this.tabs = new Tabs(container, {
			tabs: tabDefs,
			activeId: this.getActiveTabId(repoId),
			onChange: async (id, body) => {
				await this.setActiveTabId(repoId, id as SidePanelTabId);
				await this.renderTabBody(id as SidePanelTabId, body, state);
			},
		});
	}

	/**
	 * Render the body of a given tab. Each tab simply re-uses the existing
	 * render* methods so this is a pure layout change — no git logic moves.
	 */
	private async renderTabBody(id: SidePanelTabId, body: HTMLElement, state: RepositoryState): Promise<void> {
		switch (id) {
			case 'changes': {
				body.addClass('gitlab-changes-tab');
				const scroll = body.createDiv({ cls: 'gitlab-changes-scroll' });
				this.renderFileList(scroll, state);
				// Stash sits between the file list and the commit composer —
				// it's the natural place for "save these changes for later".
				// We don't await: stash list loads in the background while
				// the commit composer renders synchronously below.
				void renderStashSection(scroll, this.stashDeps(state));
				const footer = body.createDiv({ cls: 'gitlab-changes-footer' });
				this.renderCommitSection(footer, state);
				return;
			}
			case 'files':
				await this.renderRepositoryBrowser(body, state);
				return;
			case 'history':
				await this.renderCommitHistory(body, state);
				return;
			case 'branches':
				await this.renderTagsSection(body, state);
				return;
			case 'remote':
				await this.renderMergeRequests(body, state);
				await this.renderPipelines(body, state);
				return;
		}
	}

	/**
	 * Render the changed-files list, grouped by status.
	 *
	 * Groups (in display order): Conflicted, Staged, Unstaged, Untracked.
	 * Empty groups are omitted entirely. Each row exposes hover-revealed
	 * Lucide-icon actions for diff / history / move; the only behaviors
	 * available match what existed before — this is a presentation pass.
	 */
	private renderFileList(container: HTMLElement, state: RepositoryState): void {
		const fileSection = container.createDiv({ cls: 'gitlab-changes-section' });

		// Empty state: cleaner, centered, with an icon — replaces the bare line.
		if (state.files.length === 0) {
			const empty = fileSection.createDiv({ cls: 'gitlab-empty-state' });
			const iconEl = empty.createDiv({ cls: 'gitlab-empty-state-icon' });
			try { setIcon(iconEl, 'check-circle-2'); } catch { /* ignore */ }
			empty.createEl('div', { cls: 'gitlab-empty-state-title', text: 'Working tree clean' });
			empty.createEl('div', {
				cls: 'gitlab-empty-state-hint',
				text: 'No changes to commit. Modify a tracked file to see it appear here.',
			});
			return;
		}

		// Bucket files into the four meaningful groups.
		const conflicted = state.files.filter(f => f.status === FileStatus.CONFLICTED);
		const staged     = state.files.filter(f => f.staged && f.status !== FileStatus.CONFLICTED);
		const unstaged   = state.files.filter(f => !f.staged && f.status !== FileStatus.UNTRACKED && f.status !== FileStatus.CONFLICTED);
		const untracked  = state.files.filter(f => !f.staged && f.status === FileStatus.UNTRACKED);

		const renderGroup = (
			groupId: string,
			title: string,
			files: typeof state.files,
			tone: 'danger' | 'accent' | 'warning' | 'muted',
		) => {
			if (files.length === 0) return;
			const collapseKey = `changes-group-${groupId}`;
			const collapsed = this.collapsedSections.has(collapseKey);

			const group = fileSection.createDiv({ cls: `gitlab-files-group gitlab-files-group-${tone}` });
			const header = group.createDiv({ cls: 'gitlab-files-group-header' });
			const toggle = header.createSpan({ cls: 'gitlab-files-group-toggle' });
			try { setIcon(toggle, collapsed ? 'chevron-right' : 'chevron-down'); } catch { /* ignore */ }
			header.createSpan({ cls: 'gitlab-files-group-title', text: title });
			header.createSpan({ cls: 'gitlab-files-group-count', text: String(files.length) });

			const list = group.createDiv({ cls: 'gitlab-files-group-list' });
			if (collapsed) list.addClass('gitlab-section-collapsed');

			header.addEventListener('click', () => {
				const nowCollapsed = !list.classList.contains('gitlab-section-collapsed');
				list.classList.toggle('gitlab-section-collapsed');
				try { setIcon(toggle, nowCollapsed ? 'chevron-right' : 'chevron-down'); } catch { /* ignore */ }
				if (nowCollapsed) this.collapsedSections.add(collapseKey);
				else this.collapsedSections.delete(collapseKey);
			});

			for (const file of files) this.renderFileRow(list, state, file);
		};

		renderGroup('conflicted', 'Conflicted', conflicted, 'danger');
		renderGroup('staged',     'Staged',     staged,     'accent');
		renderGroup('unstaged',   'Unstaged',   unstaged,   'warning');
		renderGroup('untracked',  'Untracked',  untracked,  'muted');
	}

	/**
	 * Render a single file row inside one of the change groups.
	 * The row is `[checkbox] [status badge] [filename] ··· [hover actions]`.
	 */
	private renderFileRow(parent: HTMLElement, state: RepositoryState, file: { path: string; status: FileStatus; staged: boolean }): void {
		const row = parent.createDiv({ cls: 'gitlab-file-row' });
		row.setAttribute('title', `${file.path} — ${this.getStatusTooltip(file.status)}${file.staged ? ' (staged)' : ''}`);

		// Stage/unstage checkbox (kept for parity with previous behavior).
		const checkbox = row.createEl('input', { type: 'checkbox', cls: 'gitlab-file-checkbox' });
		checkbox.checked = file.staged;
		checkbox.addEventListener('click', (e) => e.stopPropagation());
		checkbox.addEventListener('change', async (e) => {
			await this.handleStageToggle(state, file.path, (e.target as HTMLInputElement).checked);
		});

		// Color-coded status badge (M/A/D/?/!).
		const badge = row.createEl('span', {
			text: this.getStatusBadge(file.status),
			cls: `gitlab-status-badge gitlab-status-${file.status}`,
		});
		badge.setAttribute('title', this.getStatusTooltip(file.status));

		// Filename — clicking opens the diff (preserves prior behavior).
		const fileName = row.createEl('span', {
			text: file.path,
			cls: 'gitlab-file-name gitlab-file-clickable',
		});
		fileName.title = 'Click to view diff';
		fileName.addEventListener('click', async () => { await this.openFileDiff(state, file.path); });

		// Hover-revealed actions on the right.
		const actions = row.createDiv({ cls: 'gitlab-file-row-actions' });
		this.iconAction(actions, 'file-diff', 'View diff', (e) => {
			e.stopPropagation();
			void this.openFileDiff(state, file.path);
		});
		this.iconAction(actions, 'history', 'View file history', (e) => {
			e.stopPropagation();
			void this.openFileHistory(state, file.path);
		});
		this.iconAction(actions, 'folder-input', 'Move or rename this file', (e) => {
			e.stopPropagation();
			new MoveFilesModal(this.app, this.plugin, state, [file.path]).open();
		});
		// Per-file stash: opens the same modal as "Stash changes" but with
		// the path pre-populated so only this file's diff is captured.
		this.iconAction(actions, 'archive', 'Stash this file', (e) => {
			e.stopPropagation();
			void this.stashThisFile(state, file.path);
		});
	}

	/**
	 * Compact icon-only button used for hover-revealed row actions and similar
	 * tight slots throughout the panel. Centralizes the Lucide icon wiring.
	 */
	private iconAction(parent: HTMLElement, icon: string, title: string, onClick: (e: MouseEvent) => void): HTMLButtonElement {
		const btn = parent.createEl('button', { cls: 'gitlab-icon-action' });
		btn.title = title;
		btn.setAttr('aria-label', title);
		const iconEl = btn.createSpan({ cls: 'gitlab-icon-action-icon' });
		try { setIcon(iconEl, icon); } catch { iconEl.textContent = '•'; }
		btn.addEventListener('click', onClick);
		return btn;
	}

	/**
	 * Render commit section
	 */
	private renderCommitSection(container: HTMLElement, state: RepositoryState): void {
		const commitSection = container.createDiv({ cls: 'gitlab-commit-section' });
		// Inline header (no collapsible — the section is always visible in the
		// pinned footer of the Changes tab).
		const headerRow = commitSection.createDiv({ cls: 'gitlab-commit-header' });
		headerRow.createEl('h4', { text: 'Commit', cls: 'gitlab-commit-header-title' });

		const target = commitSection.createDiv({ cls: 'gitlab-commit-body' });

		// Create commit button early so input handlers can update its state
		const commitButton = target.createEl('button', {
			text: 'Commit',
			cls: 'gitlab-commit-button mod-cta',
		});

		const updateButtonState = () => {
			const stagedCount = state.files.filter(f => f.staged).length;
			const hasStagedFiles = stagedCount > 0;
			commitButton.disabled = !hasStagedFiles || !this.commitMessage.trim() || state.operationInProgress;
			const verb = this.amendMode ? 'Amend' : 'Commit';
			commitButton.setText(hasStagedFiles ? `${verb} (${stagedCount} staged)` : verb);
		};

		// JIRA ticket field
		const jiraRow = target.createDiv({ cls: 'gitlab-jira-row' });
		jiraRow.createEl('label', {
			text: 'JIRA Ticket',
			cls: 'gitlab-jira-label',
		});
		const jiraInput = jiraRow.createEl('input', {
			type: 'text',
			cls: 'gitlab-jira-input',
			placeholder: 'e.g. PROJ-123',
		});
		jiraInput.value = this.jiraTicket;
		jiraInput.addEventListener('input', (e) => {
			this.jiraTicket = (e.target as HTMLInputElement).value;
		});

		// Commit template selector
		if (this.plugin.settings.commitTemplates.length > 0) {
			const templateRow = target.createDiv({ cls: 'gitlab-template-row' });
			templateRow.createEl('label', {
				text: 'Template',
				cls: 'gitlab-template-label',
			});
			const templateSelect = templateRow.createEl('select', { cls: 'gitlab-template-select' });
			templateSelect.createEl('option', { text: '— None —', value: '' });
			for (const tpl of this.plugin.settings.commitTemplates) {
				templateSelect.createEl('option', { text: tpl.name, value: tpl.id });
			}
			// Restore selected template
			if (this.selectedTemplateId) {
				templateSelect.value = this.selectedTemplateId;
			}
			templateSelect.addEventListener('change', () => {
				this.selectedTemplateId = templateSelect.value;
				const tpl = this.plugin.settings.commitTemplates.find(t => t.id === templateSelect.value);
				if (tpl) {
					let msg = tpl.template;
					msg = msg.replace(/\{jira\}/g, this.jiraTicket || '');
					msg = msg.replace(/\{branch\}/g, state.currentBranch || '');
					msg = msg.replace(/\{date\}/g, new Date().toLocaleDateString());
					msg = msg.replace(/\{author\}/g, this.plugin.settings.defaultAuthorName || '');
					this.commitMessage = msg;
					textarea.value = msg;
					updateButtonAndPreview();
				}
			});
		}

		const textarea = target.createEl('textarea', {
			cls: 'gitlab-commit-message',
			placeholder: 'Enter commit message...',
		});
		textarea.value = this.commitMessage;
		textarea.addEventListener('input', (e) => {
			this.commitMessage = (e.target as HTMLTextAreaElement).value;
			updateButtonAndPreview();
		});

		// Reactive commit preview container
		const previewContainer = target.createDiv({ cls: 'gitlab-commit-preview' });

		const updatePreview = () => {
			previewContainer.empty();
			if (this.jiraTicket.trim() && this.commitMessage.trim()) {
				previewContainer.style.display = '';
				previewContainer.createEl('span', { text: 'Preview: ', cls: 'gitlab-commit-preview-label' });
				previewContainer.createEl('span', {
					text: `Changes for JIRA: ${this.jiraTicket.trim()}`,
					cls: 'gitlab-commit-preview-text',
				});
			} else {
				previewContainer.style.display = 'none';
			}
		};

		const updateButtonAndPreview = () => {
			updateButtonState();
			updatePreview();
		};

		// Wire JIRA input to update button and preview reactively
		jiraInput.addEventListener('input', () => { updateButtonAndPreview(); });

		// Amend checkbox
		const amendRow = target.createDiv({ cls: 'gitlab-amend-row' });
		const amendCheckbox = amendRow.createEl('input', {
			type: 'checkbox',
			cls: 'gitlab-amend-checkbox',
		});
		amendCheckbox.checked = this.amendMode;
		amendCheckbox.id = 'gitlab-amend-toggle';
		const amendLabel = amendRow.createEl('label', { text: 'Amend last commit' });
		amendLabel.setAttribute('for', 'gitlab-amend-toggle');
		amendCheckbox.addEventListener('change', async () => {
			this.amendMode = amendCheckbox.checked;
			if (this.amendMode) {
				// Pre-fill with last commit message
				const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
				if (gitOps) {
					try {
						const commits = await gitOps.log(state.currentBranch, 1);
						if (commits.length > 0) {
							this.commitMessage = commits[0].message;
							textarea.value = this.commitMessage;
						}
					} catch { /* ignore */ }
				}
				commitButton.setText('Amend');
				// updateButtonState below will overwrite this with "Amend (N staged)".
			} else {
				commitButton.setText('Commit');
			}
			updateButtonState();
		});

		// Move commit button to the end visually (it was created early for closure access)
		target.appendChild(commitButton);
		commitButton.addEventListener('click', async () => {
			if (this.amendMode) {
				await this.handleAmendCommit(state);
			} else {
				await this.handleCommit(state);
			}
		});

		// Set initial states
		updateButtonState();
		updatePreview();
	}

	/**
	 * Build the shared dependency bag the stash section uses. Lives on the
	 * view so the section module stays oblivious to how we refresh — and
	 * so the Per-file "Stash this file" action can reuse the same flow.
	 */
	stashDeps(state: RepositoryState): StashSectionDeps {
		return {
			app: this.app,
			plugin: this.plugin,
			state,
			rerender: async () => {
				await this.plugin.repositoryManager?.refreshRepository(state.config.id);
				await this.render();
			},
		};
	}

	/**
	 * Public stash-this-file entry point — called from the per-file row's
	 * context action. Delegates to the same modal flow as the section
	 * header button, but pre-populates the pathspec and message.
	 */
	async stashThisFile(state: RepositoryState, filePath: string): Promise<void> {
		const branch = state.currentBranch || 'work';
		await runStashCreate(this.stashDeps(state), {
			paths: [filePath],
			defaultMessageOverride: `WIP on ${branch} · ${filePath}`,
		});
	}

	/**
	 * Render tags section
	 */
	private async renderTagsSection(container: HTMLElement, state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const tagSection = container.createDiv({ cls: 'gitlab-tag-section' });

		let tags: GitTag[] = [];
		try {
			tags = await gitOps.listTags();
		} catch { /* no tags */ }

		const tagCountText = tags.length > 0 ? ` (${tags.length})` : '';
		const { content: contentDiv } = this.createSectionHeader(tagSection, `Tags${tagCountText}`, 'tags', {
			collapsible: true,
			extraButtons: (headerRow) => {
				const createBtn = headerRow.createEl('button', {
					text: '+ Tag',
					cls: 'gitlab-small-button',
				});
				createBtn.title = 'Create a new tag';
				createBtn.addEventListener('click', () => {
					new CreateTagModal(this.app, async (name, message) => {
						try {
							await gitOps.createTag(name, message ? { message } : undefined);
							new Notice(`Tag "${name}" created`);
							await this.render();
						} catch {
							new Notice('Failed to create tag');
						}
					}).open();
				});
			}
		});
		const tagTarget = contentDiv || tagSection;

		if (tags.length > 0) {
			const tagList = tagTarget.createDiv({ cls: 'gitlab-tag-list' });
			for (const tag of tags) {
				const tagEl = tagList.createDiv({ cls: 'gitlab-tag-entry' });

				const tagIcon = tagEl.createSpan({ cls: 'gitlab-tag-icon' });
				try { setIcon(tagIcon, 'tag'); } catch { /* ignore */ }
				tagEl.createEl('span', { text: tag.name, cls: 'gitlab-tag-name' });
				if (tag.message) {
					tagEl.createEl('span', { text: tag.message.split('\n')[0], cls: 'gitlab-tag-message' });
				}

				const actions = tagEl.createDiv({ cls: 'gitlab-tag-actions' });

				const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
				const token = currentConfig?.token || state.config.token;

				const pushBtn = actions.createEl('button', { cls: 'gitlab-tiny-button gitlab-tiny-icon-btn' });
				try { setIcon(pushBtn, 'arrow-up-from-line'); } catch { pushBtn.textContent = '⬆'; }
				pushBtn.title = 'Push tag to remote';
				pushBtn.addEventListener('click', async () => {
					try {
						await gitOps.pushTag(tag.name, token);
						new Notice(`Tag "${tag.name}" pushed`);
					} catch { new Notice('Failed to push tag'); }
				});

				const deleteBtn = actions.createEl('button', { cls: 'gitlab-tiny-button gitlab-tiny-danger gitlab-tiny-icon-btn' });
				try { setIcon(deleteBtn, 'x'); } catch { deleteBtn.textContent = '✕'; }
				deleteBtn.title = 'Delete tag';
				deleteBtn.addEventListener('click', async () => {
					try {
						await gitOps.deleteTag(tag.name);
						new Notice(`Tag "${tag.name}" deleted`);
						await this.render();
					} catch { new Notice('Failed to delete tag'); }
				});
			}
		}
	}

	/**
	 * Render commit history
	 */
	private async renderCommitHistory(container: HTMLElement, state: RepositoryState): Promise<void> {
		const historySection = container.createDiv();
		const { content: contentDiv } = this.createSectionHeader(historySection, 'Recent Commits', 'recent-commits', { collapsible: true });
		const histTarget = contentDiv || historySection;

		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			const commits = await gitOps.log(state.currentBranch, 10);

			if (commits.length === 0) {
				histTarget.createEl('p', {
					text: 'No commits yet',
					cls: 'setting-item-description',
				});
				return;
			}

			const historyList = histTarget.createDiv({ cls: 'gitlab-history-list' });

			commits.forEach(commit => {
				const commitItem = historyList.createDiv({ cls: 'gitlab-commit-item' });

				const commitHeader = commitItem.createDiv({ cls: 'gitlab-commit-header-row' });
				commitHeader.createEl('div', {
					text: commit.message,
					cls: 'gitlab-commit-message-text',
				});

				// Revert button
				const revertBtn = commitHeader.createEl('button', {
					text: '↩',
					cls: 'gitlab-tiny-button',
				});
				revertBtn.title = 'Revert this commit';
				revertBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					const proceed = confirm(
						`Revert commit "${commit.message.split('\n')[0]}"?\n\n` +
						`This will create a new commit that undoes the changes from ${commit.sha.substring(0, 7)}.`
					);
					if (!proceed) return;

					try {
						new Notice('Reverting commit...');
						await gitOps.revertCommit(commit.sha);
						new Notice('Commit reverted successfully');
						await this.plugin.repositoryManager?.refreshRepository(state.config.id);
						this.plugin.updateStatusBar();
						await this.render();
					} catch (error) {
						new Notice(`Failed to revert: ${error instanceof Error ? error.message : 'Unknown error'}`);
					}
				});

				const commitMeta = commitItem.createDiv({ cls: 'gitlab-commit-meta' });
				commitMeta.createEl('span', {
					text: commit.authorName,
				});
				commitMeta.createEl('span', {
					text: new Date(commit.timestamp).toLocaleString(),
				});
				commitMeta.createEl('span', {
					text: commit.sha.substring(0, 7),
					cls: 'gitlab-commit-sha',
				});
			});
		} catch (error) {
			console.error('Failed to load commit history:', error);
		}
	}

	/**
	 * Get status badge text
	 */
	private getStatusBadge(status: FileStatus): string {
		switch (status) {
			case FileStatus.MODIFIED: return 'M';
			case FileStatus.ADDED: return 'A';
			case FileStatus.DELETED: return 'D';
			case FileStatus.UNTRACKED: return '?';
			case FileStatus.CONFLICTED: return '!';
			default: return '';
		}
	}

	/**
	 * Get human-readable tooltip for a file status
	 */
	private getStatusTooltip(status: FileStatus): string {
		switch (status) {
			case FileStatus.MODIFIED: return 'Modified — file has been changed';
			case FileStatus.ADDED: return 'Added — new file staged for commit';
			case FileStatus.DELETED: return 'Deleted — file has been removed';
			case FileStatus.UNTRACKED: return 'Untracked — new file not yet staged';
			case FileStatus.RENAMED: return 'Renamed — file has been moved or renamed';
			case FileStatus.COPIED: return 'Copied — file has been copied';
			case FileStatus.CONFLICTED: return 'Conflicted — merge conflict detected';
			case FileStatus.IGNORED: return 'Ignored — file is in .gitignore';
			default: return 'Unmodified';
		}
	}

	/**
	 * Handle amend commit
	 */
	private async handleAmendCommit(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);

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
			const amendResult = await gitOps.amendCommit(finalMessage, author, hook);
			if (amendResult.transformedWorkdirOids) {
				await this.plugin.recordPagesCompatSnapshot(state.config.id, amendResult.transformedWorkdirOids);
			}
			this.commitMessage = '';
			this.amendMode = false;

			new Notice('Commit amended successfully');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			this.plugin.updateStatusBar();
			await this.render();
		} catch (error) {
			if (error instanceof PagesCompatTransformError) {
				const head = error.failures.slice(0, 5).map(f => `• ${f.linkName} in ${f.mdPath}: ${f.reason}`).join('\n');
				const more = error.failures.length > 5 ? `\n…and ${error.failures.length - 5} more` : '';
				new Notice(`GitLab Pages transform aborted — commit not made:\n${head}${more}`, 12000);
			} else {
				new Notice('Failed to amend commit');
			}
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		}
	}

	/**
	 * Create a GitLabClient for the given repo config
	 */
	private createGitLabClient(state: RepositoryState): GitLabClient | null {
		const host = GitLabClient.extractHost(state.config.repositoryUrl);
		const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
		const token = currentConfig?.token || state.config.token;
		if (!host || !token) return null;

		return new GitLabClient({
			host,
			token,
			disableSslVerification: state.config.disableSslVerification,
		});
	}

	/**
	 * Render merge requests section with comments and approvals
	 */
	private async renderMergeRequests(container: HTMLElement, state: RepositoryState): Promise<void> {
		const mrSection = container.createDiv();
		const { content: contentDiv } = this.createSectionHeader(mrSection, 'Merge Requests', 'merge-requests', { collapsible: true });
		const target = contentDiv || mrSection;

		const client = this.createGitLabClient(state);
		if (!client) {
			target.createEl('p', { text: 'GitLab connection not configured', cls: 'setting-item-description' });
			return;
		}

		const projectPath = GitLabClient.extractProjectPath(state.config.repositoryUrl);
		if (!projectPath) {
			target.createEl('p', { text: 'Could not determine project path', cls: 'setting-item-description' });
			return;
		}

			try {
			const projectId = await client.getProjectId(projectPath);
			const mergeRequests = await client.listMergeRequests(projectId);

			if (mergeRequests.length === 0) {
				target.createEl('p', { text: 'No open merge requests', cls: 'setting-item-description' });
				return;
			}

			// Fetch current user once for all MRs
			let currentUser: { id: number; name: string; username: string; email: string } | null = null;
			try {
				currentUser = await client.getCurrentUser();
			} catch { /* user info unavailable */ }

			const mrList = target.createDiv({ cls: 'gitlab-mr-list' });

			for (const mr of mergeRequests) {
				const mrItem = mrList.createDiv({ cls: 'gitlab-mr-item' });

				// MR header row
				const mrHeader = mrItem.createDiv({ cls: 'gitlab-mr-header' });
				const mrTitle = mrHeader.createEl('span', {
					text: `!${mr.iid} ${mr.title}`,
					cls: 'gitlab-mr-title gitlab-file-clickable',
				});
				mrTitle.title = 'Click to expand/collapse discussion';

				// Branches
				mrHeader.createEl('span', {
					text: `${mr.sourceBranch} \u2192 ${mr.targetBranch}`,
					cls: 'gitlab-mr-branches',
				});

				// Open in browser
				const openBtn = mrHeader.createEl('button', {
					text: '\uD83C\uDF10',
					cls: 'gitlab-tiny-button',
				});
				openBtn.title = 'Open in GitLab';
				openBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					window.open(mr.webUrl, '_blank');
				});

				// Approval badge
				try {
					const approvals = await client.getMergeRequestApprovals(projectId, mr.iid);
					const approved = approvals.approved_by.length;
					const required = approvals.approvals_required;
					const badgeCls = approvals.approved ? 'gitlab-approval-ok' : 'gitlab-approval-pending';
					const badgeText = required > 0 ? `\u2713 ${approved}/${required}` : (approved > 0 ? `\u2713 ${approved}` : '');
					if (badgeText) {
						mrHeader.createEl('span', {
							text: badgeText,
							cls: `gitlab-approval-badge ${badgeCls}`,
						});
					}

					// Approver names
					if (approvals.approved_by.length > 0) {
						const approverNames = approvals.approved_by.map(a => a.user.name).join(', ');
						mrHeader.createEl('span', {
							text: `Approved by: ${approverNames}`,
							cls: 'gitlab-mr-approvers',
						});
					}

					// Approve/Unapprove button (only if we know the current user)
					if (currentUser) {
						const userApproved = approvals.approved_by.some(a => a.user.username === currentUser!.username);
						const approveBtn = mrHeader.createEl('button', {
							text: userApproved ? '\u2715 Unapprove' : '\u2713 Approve',
							cls: 'gitlab-tiny-button',
						});
						approveBtn.addEventListener('click', async (e) => {
							e.stopPropagation();
							try {
								if (userApproved) {
									await client.unapproveMergeRequest(projectId, mr.iid);
									new Notice('Unapproved merge request');
								} else {
									await client.approveMergeRequest(projectId, mr.iid);
									new Notice('Approved merge request');
								}
								await this.render();
							} catch (error) {
								new Notice(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
							}
						});
					}
				} catch { /* approvals API may not be available */ }

				// Expandable discussion section
				const isExpanded = this.expandedMrIid === mr.iid;
				const discussionDiv = mrItem.createDiv({
					cls: `gitlab-mr-discussion${isExpanded ? '' : ' gitlab-section-collapsed'}`,
				});

				mrTitle.addEventListener('click', async () => {
					try {
						if (this.expandedMrIid === mr.iid) {
							this.expandedMrIid = null;
							discussionDiv.addClass('gitlab-section-collapsed');
						} else {
							this.expandedMrIid = mr.iid;
							discussionDiv.removeClass('gitlab-section-collapsed');
							await this.loadMrDiscussion(discussionDiv, client, projectId, mr.iid);
						}
					} catch (error) {
						new Notice('Failed to load discussion');
					}
				});

				if (isExpanded) {
					await this.loadMrDiscussion(discussionDiv, client, projectId, mr.iid);
				}
			}
		} catch (error) {
			target.createEl('p', { text: 'Failed to load merge requests', cls: 'setting-item-description' });
		}
	}

	/**
	 * Load MR discussion (comments) into a container
	 */
	private async loadMrDiscussion(container: HTMLElement, client: GitLabClient, projectId: number, mrIid: number): Promise<void> {
		container.empty();
		container.createEl('p', { text: 'Loading discussion...', cls: 'setting-item-description' });

		try {
			const notes = await client.getMergeRequestNotes(projectId, mrIid);
			container.empty();

			if (notes.length === 0) {
				container.createEl('p', { text: 'No comments yet', cls: 'setting-item-description' });
			} else {
				const notesList = container.createDiv({ cls: 'gitlab-mr-notes' });
				for (const note of notes) {
					if (note.system) continue; // Skip system notes for cleaner view
					const noteDiv = notesList.createDiv({ cls: 'gitlab-mr-note' });
					const noteMeta = noteDiv.createDiv({ cls: 'gitlab-mr-note-meta' });
					noteMeta.createEl('strong', { text: note.author.name });
					noteMeta.createEl('span', {
						text: ` \u2022 ${new Date(note.created_at).toLocaleString()}`,
						cls: 'gitlab-mr-note-time',
					});
					noteDiv.createEl('div', {
						text: note.body,
						cls: 'gitlab-mr-note-body',
					});
				}
			}

			// Add comment input
			const addCommentDiv = container.createDiv({ cls: 'gitlab-mr-add-comment' });
			const commentInput = addCommentDiv.createEl('textarea', {
				placeholder: 'Write a comment...',
				cls: 'gitlab-mr-comment-input',
			});
			commentInput.rows = 2;

			const postBtn = addCommentDiv.createEl('button', {
				text: 'Comment',
				cls: 'gitlab-action-button',
			});
			postBtn.addEventListener('click', async () => {
				const body = commentInput.value.trim();
				if (!body) return;
				try {
					await client.createMergeRequestNote(projectId, mrIid, body);
					new Notice('Comment posted');
					await this.loadMrDiscussion(container, client, projectId, mrIid);
				} catch (error) {
					new Notice('Failed to post comment');
				}
			});
		} catch (error) {
			container.empty();
			container.createEl('p', { text: 'Failed to load discussion', cls: 'setting-item-description' });
		}
	}

	/**
	 * Render CI/CD pipeline status section
	 */
	private async renderPipelines(container: HTMLElement, state: RepositoryState): Promise<void> {
		const pipelineSection = container.createDiv();
		const { content: contentDiv } = this.createSectionHeader(pipelineSection, 'CI/CD Pipelines', 'pipelines', { collapsible: true });
		const target = contentDiv || pipelineSection;

		const client = this.createGitLabClient(state);
		if (!client) {
			target.createEl('p', { text: 'GitLab connection not configured', cls: 'setting-item-description' });
			return;
		}

		const projectPath = GitLabClient.extractProjectPath(state.config.repositoryUrl);
		if (!projectPath) return;

		try {
			const projectId = await client.getProjectId(projectPath);
			const pipelines = await client.getPipelines(projectId, state.currentBranch);

			if (pipelines.length === 0) {
				target.createEl('p', { text: 'No pipelines for this branch', cls: 'setting-item-description' });
				return;
			}

			const pipelineList = target.createDiv({ cls: 'gitlab-pipeline-list' });

			for (const pipeline of pipelines) {
				const pipelineItem = pipelineList.createDiv({ cls: 'gitlab-pipeline-item' });

				const statusIcon = this.getPipelineStatusIcon(pipeline.status);
				const statusCls = `gitlab-pipeline-status gitlab-pipeline-${pipeline.status}`;

				const pipelineRow = pipelineItem.createDiv({ cls: 'gitlab-pipeline-row' });
				pipelineRow.createEl('span', { text: statusIcon, cls: statusCls });
				pipelineRow.createEl('span', { text: `#${pipeline.id}`, cls: 'gitlab-pipeline-id' });
				pipelineRow.createEl('span', {
					text: pipeline.status,
					cls: statusCls,
				});
				pipelineRow.createEl('span', {
					text: new Date(pipeline.created_at).toLocaleString(),
					cls: 'gitlab-pipeline-date',
				});

				const openPipelineBtn = pipelineRow.createEl('button', {
					cls: 'gitlab-tiny-button gitlab-tiny-icon-btn',
				});
				try { setIcon(openPipelineBtn, 'external-link'); } catch { openPipelineBtn.textContent = '↗'; }
				openPipelineBtn.title = 'Open pipeline in GitLab';
				openPipelineBtn.addEventListener('click', () => {
					window.open(pipeline.web_url, '_blank');
				});

				// Load jobs for the most recent pipeline
				if (pipeline === pipelines[0]) {
					try {
						const jobs = await client.getPipelineJobs(projectId, pipeline.id);
						if (jobs.length > 0) {
							const jobsList = pipelineItem.createDiv({ cls: 'gitlab-pipeline-jobs' });
							for (const job of jobs) {
								const jobDiv = jobsList.createDiv({ cls: 'gitlab-pipeline-job' });
								jobDiv.createEl('span', {
									text: this.getPipelineStatusIcon(job.status),
									cls: `gitlab-pipeline-status gitlab-pipeline-${job.status}`,
								});
								jobDiv.createEl('span', { text: job.stage, cls: 'gitlab-pipeline-stage' });
								jobDiv.createEl('span', { text: job.name, cls: 'gitlab-pipeline-job-name' });
							}
						}
					} catch { /* jobs may not be accessible */ }
				}
			}
		} catch (error) {
			target.createEl('p', { text: 'Failed to load pipelines', cls: 'setting-item-description' });
		}
	}

	/**
	 * Get icon for pipeline status
	 */
	private getPipelineStatusIcon(status: string): string {
		switch (status) {
			case 'success': return '\u2705';
			case 'failed': return '\u274C';
			case 'running': return '\u25B6\uFE0F';
			case 'pending': return '\u23F3';
			case 'canceled': return '\u26D4';
			case 'skipped': return '\u23ED\uFE0F';
			case 'created': return '\u{1F195}';
			case 'manual': return '\u270B';
			default: return '\u2753';
		}
	}

	/**
	 * Handle stage/unstage toggle
	 */
	private async handleStageToggle(state: RepositoryState, filepath: string, stage: boolean): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			if (stage) {
				const file = state.files.find(f => f.path === filepath);
				if (file && file.status === FileStatus.DELETED) {
					await gitOps.remove([filepath]);
				} else {
					await gitOps.add([filepath]);
				}
			} else {
				await gitOps.reset([filepath]);
			}
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			await this.render();
		} catch (error) {
			new Notice(`Failed to ${stage ? 'stage' : 'unstage'} file`);
		}
	}

	/**
	 * Immediately disable all action buttons to prevent double-clicks
	 */
	private disableActionButtons(actionsContainer: HTMLElement): void {
		actionsContainer.querySelectorAll('button').forEach(btn => {
			(btn as HTMLButtonElement).disabled = true;
		});
	}

	/**
	 * Open diff view for a file in the repo
	 */
	private async openFileDiff(state: RepositoryState, filepath: string): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const oldContent = await gitOps.getFileAtCommit(filepath) || '';
		const newContent = await gitOps.getWorkingCopyContent(filepath) || '';

		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: 'gitlab-diff',
			state: {
				filePath: filepath,
				repoId: state.config.id,
				oldContent,
				newContent,
				oldLabel: 'HEAD',
				newLabel: 'Working Copy',
			},
		});
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Open file history view
	 */
	private async openFileHistory(state: RepositoryState, filepath: string): Promise<void> {
		const leaf = this.app.workspace.getLeaf('tab');
		await leaf.setViewState({
			type: 'gitlab-file-history',
			state: {
				filePath: filepath,
				repoId: state.config.id,
			},
		});
		this.app.workspace.revealLeaf(leaf);
	}

	/**
	 * Handle commit
	 */
	private async handleCommit(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);
			
			const author = {
				name: this.plugin.settings.defaultAuthorName || 'Obsidian User',
				email: this.plugin.settings.defaultAuthorEmail || 'user@obsidian.md',
			};

			// Build final commit message with JIRA ticket prefix
			let finalMessage = this.commitMessage;
			if (this.jiraTicket.trim()) {
				finalMessage = `Changes for JIRA: ${this.jiraTicket.trim()}\n${this.commitMessage}`;
			}

			const hook = state.config.gitlabPagesCompat?.enabled
				? (paths: string[]) =>
						new PagesCompatPipeline(this.plugin, state.config, gitOps).buildTransformedSnapshot(paths)
				: undefined;
			const commitResult = await gitOps.commit(finalMessage, author, hook);
			if (commitResult.transformedWorkdirOids) {
				await this.plugin.recordPagesCompatSnapshot(state.config.id, commitResult.transformedWorkdirOids);
			}
			this.commitMessage = '';
			// Keep JIRA ticket for consecutive commits to same ticket

			new Notice('Changes committed successfully');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			this.plugin.updateStatusBar();
			await this.render();
		} catch (error) {
			if (error instanceof PagesCompatTransformError) {
				const head = error.failures.slice(0, 5).map(f => `• ${f.linkName} in ${f.mdPath}: ${f.reason}`).join('\n');
				const more = error.failures.length > 5 ? `\n…and ${error.failures.length - 5} more` : '';
				new Notice(`GitLab Pages transform aborted — commit not made:\n${head}${more}`, 12000);
			} else {
				new Notice('Failed to commit changes');
			}
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		}
	}

	/**
	 * Handle pull
	 */
	private async handlePull(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		// Warn if there are uncommitted changes that could conflict
		if (state.syncStatus.hasUncommittedChanges || state.syncStatus.hasUntrackedFiles) {
			const modifiedFiles = state.files.filter(f => f.status !== FileStatus.UNMODIFIED);
			const proceed = confirm(
				`⚠️ You have ${modifiedFiles.length} uncommitted change(s):\n\n` +
				modifiedFiles.slice(0, 5).map(f => `  • ${f.path} (${f.status})`).join('\n') +
				(modifiedFiles.length > 5 ? `\n  ... and ${modifiedFiles.length - 5} more` : '') +
				'\n\nPulling may cause conflicts. Consider committing or stashing your changes first.\n\nProceed with pull anyway?'
			);
			if (!proceed) return;
		}

		// Always get the latest token from current settings
		const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
		const token = currentConfig?.token || state.config.token;

		try {
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);
			new Notice('Pulling changes...');
			
			await gitOps.pull('origin', state.currentBranch, token);
			
			new Notice('Pull completed successfully');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		} catch (error) {
			const errorMsg = error instanceof Error ? error.message : String(error);
			if (errorMsg.includes('conflict') || errorMsg.includes('CONFLICT') || errorMsg.includes('Merge')) {
				new Notice('⚠️ Pull resulted in conflicts. Check the Changes section and resolve conflicts.');
			} else {
				new Notice('Failed to pull changes: ' + errorMsg);
			}
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		}
	}

	/**
	 * Handle push
	 */
	private async handlePush(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
		const token = currentConfig?.token || state.config.token;

		try {
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);
			const isPublish = state.syncStatus.remoteBranchMissing === true;
			new Notice(isPublish ? 'Publishing branch...' : 'Pushing changes...');
			
			await gitOps.push('origin', state.currentBranch, token);
			
			new Notice(isPublish ? `Branch '${state.currentBranch}' published successfully` : 'Push completed successfully');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		} catch (error: any) {
			const msg = error?.message || error?.data?.statusMessage || 'Unknown error';
			new Notice(`Failed to push: ${msg}`, 8000);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		}
	}

	/**
	 * Handle fetch
	 */
	private async handleFetch(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const currentConfig = this.plugin.settings.repositories.find(r => r.id === state.config.id);
		const token = currentConfig?.token || state.config.token;

		try {
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);
			new Notice('Fetching from remote...');
			
			await gitOps.fetch('origin', token);
			
			new Notice('Fetch completed successfully');
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		} catch (error) {
			new Notice('Failed to fetch from remote');
			this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			await this.render();
		}
	}

	/**
	 * Render repository file browser showing ALL files (including non-md)
	 */
	private async renderRepositoryBrowser(container: HTMLElement, state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const browserSection = container.createDiv({ cls: 'gitlab-browser-section' });

		const headerRow = browserSection.createDiv({ cls: 'gitlab-browser-header' });
		const toggle = headerRow.createEl('span', {
			text: '▶',
			cls: 'gitlab-browser-toggle',
		});
		headerRow.createEl('h4', { text: 'Repository Files' });
		const browserHelp = HELP_TEXT['file-browser'];
		if (browserHelp) {
			const infoBtn = headerRow.createEl('span', { text: 'ⓘ', cls: 'gitlab-info-icon' });
			infoBtn.title = `${browserHelp.short}\n\n${browserHelp.detail}`;
			infoBtn.addEventListener('click', (e) => { e.stopPropagation(); new HelpTooltipModal(this.app, browserHelp.title, browserHelp.detail).open(); });
		}

		// Add file button
		const addFileBtn = headerRow.createEl('button', {
			text: '+ Add File',
			cls: 'gitlab-action-button gitlab-add-file-btn',
		});
		addFileBtn.addEventListener('click', async () => {
			await this.handleAddFile(state);
		});

		// Move files button
		const moveFilesBtn = headerRow.createEl('button', {
			text: '⇢ Move…',
			cls: 'gitlab-action-button gitlab-move-files-btn',
		});
		moveFilesBtn.title = 'Move files within the repository';
		moveFilesBtn.addEventListener('click', (e) => {
			e.stopPropagation();
			new MoveFilesModal(this.app, this.plugin, state, []).open();
		});

		const browserContent = browserSection.createDiv({
			cls: `gitlab-browser-content${this.browserExpanded ? '' : ' gitlab-browser-collapsed'}`,
		});
		toggle.textContent = this.browserExpanded ? '▼' : '▶';

		// Toggle expand/collapse
		headerRow.addEventListener('click', (e) => {
			if ((e.target as HTMLElement).closest('.gitlab-add-file-btn')) return;
			if ((e.target as HTMLElement).closest('.gitlab-move-files-btn')) return;
			if ((e.target as HTMLElement).closest('.gitlab-info-icon')) return;
			const isCollapsed = browserContent.classList.contains('gitlab-browser-collapsed');
			browserContent.classList.toggle('gitlab-browser-collapsed');
			this.browserExpanded = isCollapsed;
			toggle.textContent = isCollapsed ? '▼' : '▶';

			if (isCollapsed && browserContent.childElementCount === 0) {
				this.loadRepositoryFiles(browserContent, state);
			}
		});

		// Auto-load if was expanded
		if (this.browserExpanded && browserContent.childElementCount === 0) {
			this.loadRepositoryFiles(browserContent, state);
		}
	}

	/**
	 * Load and render the file tree
	 */
	private async loadRepositoryFiles(container: HTMLElement, state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		container.empty();
		container.createEl('p', { text: 'Loading files...', cls: 'setting-item-description' });

		try {
			const allFiles = await gitOps.listAllFiles();
			const statusMap = new Map<string, FileStatus>();
			state.files.forEach(f => statusMap.set(f.path, f.status));

			container.empty();

			if (allFiles.length === 0) {
				container.createEl('p', { text: 'No files in repository', cls: 'setting-item-description' });
				return;
			}

			// Build tree structure
			interface TreeNode {
				name: string;
				path: string;
				isDirectory: boolean;
				size: number;
				children: Map<string, TreeNode>;
			}

			const root: TreeNode = { name: '', path: '', isDirectory: true, size: 0, children: new Map() };

			for (const file of allFiles) {
				const parts = file.path.split('/');
				let current = root;
				let pathSoFar = '';
				for (let i = 0; i < parts.length; i++) {
					pathSoFar = pathSoFar ? `${pathSoFar}/${parts[i]}` : parts[i];
					if (!current.children.has(parts[i])) {
						current.children.set(parts[i], {
							name: parts[i],
							path: pathSoFar,
							isDirectory: i < parts.length - 1 || file.isDirectory,
							size: i === parts.length - 1 ? file.size : 0,
							children: new Map(),
						});
					}
					current = current.children.get(parts[i])!;
				}
			}

			const repoDir = gitOps.getRepoDir();
			this.renderTreeNode(container, root, statusMap, repoDir, 0, state);

		} catch (error) {
			container.empty();
			container.createEl('p', { text: 'Failed to load files', cls: 'setting-item-description' });
		}
	}

	/**
	 * Render a tree node recursively
	 */
	private renderTreeNode(
		container: HTMLElement,
		node: { name: string; path: string; isDirectory: boolean; size: number; children: Map<string, any> },
		statusMap: Map<string, FileStatus>,
		repoDir: string,
		depth: number,
		state: RepositoryState,
	): void {
		// Sort: directories first, then files, alphabetically
		const sorted = Array.from(node.children.values()).sort((a: any, b: any) => {
			if (a.isDirectory && !b.isDirectory) return -1;
			if (!a.isDirectory && b.isDirectory) return 1;
			return a.name.localeCompare(b.name);
		});

		for (const child of sorted) {
			const status = statusMap.get(child.path);

			if (child.isDirectory) {
				const folderDiv = container.createDiv({ cls: 'gitlab-tree-folder' });
				folderDiv.style.paddingLeft = `${depth * 16}px`;

				const folderRow = folderDiv.createDiv({ cls: 'gitlab-tree-row gitlab-tree-folder-row' });
				const folderToggle = folderRow.createEl('span', { cls: 'gitlab-tree-toggle' });
				try { setIcon(folderToggle, 'chevron-right'); } catch { folderToggle.textContent = '▶'; }
				const folderIconEl = folderRow.createEl('span', { cls: 'gitlab-tree-icon' });
				try { setIcon(folderIconEl, 'folder'); } catch { folderIconEl.textContent = '📁'; }
				folderRow.createEl('span', { text: child.name, cls: 'gitlab-tree-name' });

				const childContainer = container.createDiv({ cls: 'gitlab-tree-children gitlab-tree-collapsed' });

				folderRow.addEventListener('click', () => {
					const isCollapsed = childContainer.classList.contains('gitlab-tree-collapsed');
					childContainer.classList.toggle('gitlab-tree-collapsed');
					try {
						setIcon(folderToggle, isCollapsed ? 'chevron-down' : 'chevron-right');
						setIcon(folderIconEl, isCollapsed ? 'folder-open' : 'folder');
					} catch { folderToggle.textContent = isCollapsed ? '▼' : '▶'; }
				});

				this.renderTreeNode(childContainer, child, statusMap, repoDir, depth + 1, state);
			} else {
				const fileDiv = container.createDiv({ cls: 'gitlab-tree-row gitlab-tree-file-row' });
				fileDiv.style.paddingLeft = `${(depth * 16) + 20}px`;

				const ext = child.name.split('.').pop()?.toLowerCase() || '';
				const fileIconEl = fileDiv.createEl('span', { cls: 'gitlab-tree-icon' });
				try { setIcon(fileIconEl, this.getFileIcon(ext)); } catch { fileIconEl.textContent = '•'; }

				const nameEl = fileDiv.createEl('span', { text: child.name, cls: 'gitlab-tree-name' });

				// Color the name by status
				if (status) {
					const colorClass = this.getStatusColorClass(status);
					if (colorClass) nameEl.classList.add(colorClass);
				}

				// File size
				const sizeText = this.formatFileSize(child.size);
				fileDiv.createEl('span', { text: sizeText, cls: 'gitlab-tree-size' });

				// Status badge
				if (status) {
					const badge = this.getStatusBadge(status);
					if (badge) {
						fileDiv.createEl('span', {
							text: badge,
							cls: `gitlab-status-badge gitlab-status-${status}`,
						});
					}
				}

				// Move button (icon)
				const moveBtn = fileDiv.createEl('span', {
					cls: 'gitlab-tree-move-btn gitlab-icon-action',
				});
				const moveBtnIcon = moveBtn.createSpan({ cls: 'gitlab-icon-action-icon' });
				try { setIcon(moveBtnIcon, 'folder-input'); } catch { moveBtn.textContent = '⇢'; }
				moveBtn.title = 'Move or rename this file';
				moveBtn.addEventListener('click', (e) => {
					e.stopPropagation();
					new MoveFilesModal(this.app, this.plugin, state, [child.path]).open();
				});

				// Click to open file
				fileDiv.addEventListener('click', () => {
					this.openRepoFile(repoDir, child.path, ext);
				});

				fileDiv.setAttribute('title', `${child.path} (${sizeText})\nClick to open`);
			}
		}
	}

	/**
	 * Map a file extension to a Lucide icon name. Used to render file rows in
	 * the repository browser with native Obsidian icons (consistent visual
	 * language) instead of mixed emoji.
	 */
	private getFileIcon(ext: string): string {
		const iconMap: Record<string, string> = {
			md: 'file-text', txt: 'file-text', rtf: 'file-text',
			json: 'braces', yaml: 'braces', yml: 'braces', toml: 'braces', xml: 'code',
			js: 'file-code', ts: 'file-code', jsx: 'file-code', tsx: 'file-code',
			css: 'file-code', scss: 'file-code', html: 'file-code', vue: 'file-code', svelte: 'file-code',
			py: 'file-code', rb: 'file-code', go: 'file-code', rs: 'file-code',
			java: 'file-code', cs: 'file-code', cpp: 'file-code', c: 'file-code', h: 'file-code',
			png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', svg: 'image', webp: 'image', bmp: 'image', ico: 'image',
			pdf: 'file-text',
			doc: 'file-text', docx: 'file-text', odt: 'file-text',
			xls: 'sheet', xlsx: 'sheet', csv: 'sheet', ods: 'sheet',
			ppt: 'presentation', pptx: 'presentation', odp: 'presentation',
			zip: 'archive', rar: 'archive', '7z': 'archive', tar: 'archive', gz: 'archive', bz2: 'archive',
			mp3: 'music', wav: 'music', flac: 'music', ogg: 'music', m4a: 'music',
			mp4: 'film', avi: 'film', mkv: 'film', mov: 'film', webm: 'film',
			vtt: 'subtitles', srt: 'subtitles',
			exe: 'terminal', dll: 'terminal', sh: 'terminal', bat: 'terminal', cmd: 'terminal', ps1: 'terminal',
		};
		return iconMap[ext] || 'file';
	}

	/**
	 * Get CSS class for status coloring
	 */
	private getStatusColorClass(status: FileStatus): string {
		switch (status) {
			case FileStatus.MODIFIED: return 'gitlab-tree-modified';
			case FileStatus.ADDED: return 'gitlab-tree-added';
			case FileStatus.DELETED: return 'gitlab-tree-deleted';
			case FileStatus.UNTRACKED: return 'gitlab-tree-untracked';
			default: return '';
		}
	}

	/**
	 * Format file size
	 */
	private formatFileSize(bytes: number): string {
		if (bytes === 0) return '';
		if (bytes < 1024) return `${bytes} B`;
		if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
		return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
	}

	/**
	 * Open a file from the repo - md files in Obsidian, others with system default app
	 */
	private openRepoFile(repoDir: string, relativePath: string, ext: string): void {
		const fullPath = `${repoDir}/${relativePath}`.replace(/\//g, '\\');

		const mdExtensions = ['md', 'markdown', 'canvas'];
		const obsidianExtensions = ['md', 'markdown', 'canvas', 'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'pdf'];

		if (obsidianExtensions.includes(ext)) {
			// Try to open in Obsidian
			const vaultBasePath = (this.app.vault.adapter as any).basePath as string;
			const normalizedFull = fullPath.replace(/\\/g, '/');
			const normalizedVault = vaultBasePath.replace(/\\/g, '/');
			if (normalizedFull.startsWith(normalizedVault)) {
				const vaultRelative = normalizedFull.substring(normalizedVault.length + 1);
				const file = this.app.vault.getAbstractFileByPath(vaultRelative);
				if (file) {
					this.app.workspace.openLinkText(vaultRelative, '', false);
					return;
				}
			}
		}

		// Open with system default application
		try {
			const { shell } = require('electron');
			shell.openPath(fullPath);
		} catch {
			new Notice(`Cannot open file: ${relativePath}`);
		}
	}

	/**
	 * Handle adding a file to the repository via file picker
	 */
	private async handleAddFile(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			const { dialog } = require('electron').remote || require('@electron/remote') || {};
			let result: any;

			if (dialog) {
				result = await dialog.showOpenDialog({
					properties: ['openFile', 'multiSelections'],
					title: 'Add files to repository',
				});
			} else {
				// Fallback: use Electron's main process dialog via ipcRenderer
				const electron = require('electron');
				if (electron.ipcRenderer) {
					result = await electron.ipcRenderer.invoke('dialog:openFile');
				}
			}

			if (!result || result.canceled || !result.filePaths?.length) return;

			const repoDir = gitOps.getRepoDir();
			const fsModule = require('fs');
			const pathModule = require('path');

			let copiedCount = 0;
			for (const filePath of result.filePaths) {
				const fileName = pathModule.basename(filePath);
				const destPath = pathModule.join(repoDir, fileName);
				try {
					fsModule.copyFileSync(filePath, destPath);
					copiedCount++;
				} catch (err) {
					new Notice(`Failed to copy: ${fileName}`);
				}
			}

			if (copiedCount > 0) {
				new Notice(`Added ${copiedCount} file(s) to repository`);
				await this.plugin.repositoryManager?.refreshRepository(state.config.id);
				await this.render();
			}
		} catch (error) {
			// Fallback: show instructions if Electron dialog is not available
			const repoDir = gitOps.getRepoDir();
			new Notice(`Copy files manually to: ${repoDir}`);
		}
	}

	/**
	 * Handle branch switching
	 */
	private async handleSwitchBranch(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		try {
			const branches = await gitOps.listBranches();
			const otherBranches = branches.filter(b => !b.isCurrent);

			if (otherBranches.length === 0) {
				new Notice('No other branches available. Create a new branch first.');
				return;
			}

			const modal = new BranchSwitchModal(this.app, otherBranches.map(b => b.name), async (selectedBranch) => {
				try {
					this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);
					new Notice(`Switching to branch: ${selectedBranch}...`);
					await gitOps.checkout(selectedBranch);
					new Notice(`Switched to branch: ${selectedBranch}`);
					await this.plugin.repositoryManager?.refreshRepository(state.config.id);
					await this.render();
				} catch (error) {
					new Notice(`Failed to switch branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
				} finally {
					this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
				}
			});
			modal.open();
		} catch (error) {
			new Notice('Failed to list branches');
		}
	}

	/**
	 * Handle delete orphaned branches (remote deleted)
	 */
	private async handleDeleteOrphanedBranches(state: RepositoryState, orphanedBranches: GitBranch[]): Promise<void> {
		const branchNames = orphanedBranches.map(b => b.name).join('\n  • ');
		const proceed = confirm(
			`🗑️ Delete orphaned branches?\n\n` +
			`These branches no longer exist on the remote:\n  • ${branchNames}\n\n` +
			`This will delete the local branches. This cannot be undone.`
		);
		if (!proceed) return;

		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		let deleted = 0;
		let failed = 0;
		for (const branch of orphanedBranches) {
			try {
				await gitOps.deleteBranch(branch.name);
				deleted++;
			} catch (error) {
				failed++;
				console.error(`Failed to delete branch ${branch.name}:`, error);
			}
		}

		const msg = failed > 0
			? `Deleted ${deleted} branch(es), ${failed} failed`
			: `Deleted ${deleted} orphaned branch(es)`;
		new Notice(msg);

		await this.plugin.repositoryManager?.refreshRepository(state.config.id);
		await this.render();
	}

	/**
	 * Render a banner above the branch selector when the current branch's
	 * remote tracking ref no longer exists (e.g. MR merged & source branch
	 * deleted on GitLab). Offers a one-click "switch to main and delete".
	 */
	private renderOrphanCurrentBanner(container: HTMLElement, state: RepositoryState): void {
		const banner = container.createDiv({ cls: 'gitlab-orphan-banner' });
		banner.style.cssText = 'margin-top:6px;padding:8px;border-radius:4px;background:var(--background-modifier-error);color:var(--text-on-accent);font-size:12px;';
		banner.createDiv({
			text: `⚠️ Branch "${state.currentBranch}" no longer exists on the remote (likely merged & deleted).`,
		});
		const btnRow = banner.createDiv();
		btnRow.style.cssText = 'margin-top:6px;display:flex;gap:6px;';

		// Pick a reasonable target: prefer 'main', then 'master', else any other local branch.
		const others = (state.branches || []).filter(b => b.name !== state.currentBranch).map(b => b.name);
		const target = others.find(n => n === 'main') || others.find(n => n === 'master') || others[0];
		if (!target) return;

		const switchBtn = btnRow.createEl('button', { text: `Switch to ${target} & delete` });
		switchBtn.addEventListener('click', async () => {
			await this.handleSwitchAwayFromOrphan(state, target);
		});
	}

	/**
	 * Switch away from an orphaned branch. If its commits are fully merged into
	 * the target, this is a safe discard. Otherwise warn loudly so the user
	 * doesn't lose unmerged work.
	 */
	private async handleSwitchAwayFromOrphan(state: RepositoryState, target: string): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const orphan = state.currentBranch;
		try {
			const merged = await gitOps.isBranchMergedInto(orphan, target);
			if (!merged) {
				const proceed = confirm(
					`⚠️ Branch "${orphan}" has commits that are NOT in "${target}".\n\n` +
					`Switching and deleting it will lose those commits locally.\n\n` +
					`Continue anyway?`
				);
				if (!proceed) return;
			}

			await this.switchBranchInteractive(state, target, null);

			// Only delete if we actually moved off the orphan.
			const fresh = this.plugin.repositoryManager?.getRepository(state.config.id);
			if (fresh && fresh.currentBranch === target) {
				try {
					await gitOps.deleteBranch(orphan);
					new Notice(`Deleted local branch: ${orphan}`);
					await this.plugin.repositoryManager?.refreshRepository(state.config.id);
					await this.render();
				} catch (e) {
					new Notice(`Switched to ${target}, but failed to delete ${orphan}: ${e instanceof Error ? e.message : 'unknown error'}`);
				}
			}
		} catch (error) {
			new Notice(`Failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
		}
	}

	/**
	 * Switch branches with friendly handling of isomorphic-git's
	 * "would be overwritten by checkout" conflict (offers stash/discard).
	 */
	private async switchBranchInteractive(
		state: RepositoryState,
		selectedBranch: string,
		branchSelect: HTMLSelectElement | null,
	): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		// Pre-flight warning matches old behaviour for the common dirty case.
		if (state.syncStatus.hasUncommittedChanges || state.syncStatus.hasUntrackedFiles) {
			const proceed = confirm(
				`⚠️ You have uncommitted changes.\n\n` +
				`Switching to "${selectedBranch}" may cause you to lose your work.\n` +
				`Consider stashing or committing your changes first.\n\n` +
				`Switch branch anyway?`
			);
			if (!proceed) {
				if (branchSelect) branchSelect.value = state.currentBranch;
				return;
			}
		}

		const tryCheckout = async (force: boolean) => {
			new Notice(`Switching to branch: ${selectedBranch}...`);
			await gitOps.checkout(selectedBranch, { force });
			new Notice(`Switched to branch: ${selectedBranch}`);
			await this.plugin.repositoryManager?.refreshRepository(state.config.id);
			await this.render();
		};

		try {
			await tryCheckout(false);
		} catch (error) {
			const msg = error instanceof Error ? error.message : String(error);
			const isOverwriteConflict = /would be overwritten/i.test(msg) || /CheckoutConflictError/i.test(msg);
			if (!isOverwriteConflict) {
				new Notice(`Failed to switch branch: ${msg}`);
				if (branchSelect) branchSelect.value = state.currentBranch;
				return;
			}

			// Extract the conflicting file list from isomorphic-git's error if available.
			const conflictFiles: string[] = (error as any)?.data?.filepaths
				|| (error as any)?.error?.data?.filepaths
				|| [];

			// Offer the user actionable choices via a real Obsidian Modal
			// (window.prompt is a no-op in Obsidian's Electron renderer).
			const choice = await new CheckoutConflictModal(
				this.app,
				state.currentBranch,
				selectedBranch,
				conflictFiles,
			).pick();

			if (choice === 'cancel') {
				if (branchSelect) branchSelect.value = state.currentBranch;
				return;
			}

			try {
				if (choice === 'stash') {
					await gitOps.stashPush({
						message: `auto-stash before switching to ${selectedBranch}`,
						includeUntracked: true,
					});
					new Notice('Changes stashed.');
					await tryCheckout(false);
				} else if (choice === 'discard') {
					await tryCheckout(true);
				}
			} catch (e) {
				new Notice(`Failed to switch branch: ${e instanceof Error ? e.message : 'Unknown error'}`);
				if (branchSelect) branchSelect.value = state.currentBranch;
			}
		}
	}

	/**
	 * Handle create branch
	 */
	private async handleCreateBranch(state: RepositoryState): Promise<void> {
		const gitOps = this.plugin.repositoryManager?.getGitOps(state.config.id);
		if (!gitOps) return;

		const modal = new CreateBranchModal(this.app, state.currentBranch, async (branchName) => {
			try {
				this.plugin.repositoryManager?.setOperationInProgress(state.config.id, true);
				new Notice(`Creating branch: ${branchName}...`);
				await gitOps.createBranch(branchName);
				await gitOps.checkout(branchName);
				new Notice(`Created and switched to branch: ${branchName}`);
				await this.plugin.repositoryManager?.refreshRepository(state.config.id);
				await this.render();
			} catch (error) {
				new Notice(`Failed to create branch: ${error instanceof Error ? error.message : 'Unknown error'}`);
			} finally {
				this.plugin.repositoryManager?.setOperationInProgress(state.config.id, false);
			}
		});
		modal.open();
	}
}
