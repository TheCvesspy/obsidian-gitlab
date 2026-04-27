/**
 * Sticky HeaderBar for the GitLab side panel.
 *
 * Layout:
 *   Row 1: [Repo dropdown ▾]                           [+] [⟳]
 *   Row 2: ⎇ branch ▾   ↓N ↑N   [Pull] [Push] [Fetch]  [⋯]
 *   (orphan banner is rendered by the caller below the header when needed)
 *
 * This component owns rendering only — all behavior is supplied by the caller
 * via the `callbacks` object so existing private methods on the side-panel
 * view stay the source of truth for actual git operations.
 */
import { Menu, setIcon } from 'obsidian';
import { RepositoryState, SubTreeConfig } from '../../types';

export interface HeaderBarCallbacks {
	onSelectRepo: (repoId: string) => void | Promise<void>;
	onUpload: () => void;
	onRefresh: () => void | Promise<void>;
	onSwitchBranch: (branchName: string) => void | Promise<void>;
	onCreateBranch: () => void | Promise<void>;
	onCleanOrphans: () => void | Promise<void>;
	onPull: () => void | Promise<void>;
	onPush: () => void | Promise<void>;
	onFetch: () => void | Promise<void>;
	/** Items shown in the overflow ⋯ menu. */
	overflowItems: Array<{
		title: string;
		icon?: string;
		onClick: () => void | Promise<void>;
	}>;
}

export interface HeaderBarOptions {
	repositories: SubTreeConfig[];
	selectedRepoId: string | null;
	state: RepositoryState | null;
	callbacks: HeaderBarCallbacks;
}

/**
 * Render the sticky header bar into `container`. Returns the root element so
 * callers can append additional elements (e.g. an orphan-branch banner)
 * directly underneath.
 */
export function renderHeaderBar(container: HTMLElement, opts: HeaderBarOptions): HTMLElement {
	const root = container.createDiv({ cls: 'gitlab-headerbar' });

	renderRow1(root, opts);
	if (opts.state) {
		renderRow2(root, opts);
	}

	return root;
}

function renderRow1(root: HTMLElement, opts: HeaderBarOptions): void {
	const row = root.createDiv({ cls: 'gitlab-headerbar-row gitlab-headerbar-row-1' });

	// Repo dropdown
	const repoWrap = row.createDiv({ cls: 'gitlab-headerbar-repo' });
	const logo = repoWrap.createDiv({ cls: 'gitlab-headerbar-logo' });
	try { setIcon(logo, 'gitlab-logo'); } catch { /* ignore */ }

	if (opts.repositories.length === 0) {
		repoWrap.createSpan({ cls: 'gitlab-headerbar-empty', text: 'No repositories' });
	} else {
		const select = repoWrap.createEl('select', { cls: 'gitlab-headerbar-repo-select' });
		const placeholder = select.createEl('option', { text: 'Select a repository…', value: '' });
		placeholder.disabled = true;
		placeholder.selected = !opts.selectedRepoId;
		for (const repo of opts.repositories) {
			const option = select.createEl('option', { text: repo.name, value: repo.id });
			if (repo.id === opts.selectedRepoId) option.selected = true;
		}
		select.addEventListener('change', (e) => {
			const value = (e.target as HTMLSelectElement).value;
			if (value) void opts.callbacks.onSelectRepo(value);
		});
	}

	// Trailing global icon buttons
	const actions = row.createDiv({ cls: 'gitlab-headerbar-globals' });
	iconBtn(actions, {
		icon: 'plus',
		title: 'Add files to repository (any file type)',
		onClick: opts.callbacks.onUpload,
		disabled: !opts.state,
	});
	iconBtn(actions, {
		icon: 'refresh-cw',
		title: 'Refresh repository',
		onClick: opts.callbacks.onRefresh,
		disabled: !opts.state,
	});
}

function renderRow2(root: HTMLElement, opts: HeaderBarOptions): void {
	const state = opts.state!;
	const row = root.createDiv({ cls: 'gitlab-headerbar-row gitlab-headerbar-row-2' });

	// Branch dropdown
	const branchWrap = row.createDiv({ cls: 'gitlab-headerbar-branch' });
	const branchIcon = branchWrap.createSpan({ cls: 'gitlab-headerbar-branch-icon' });
	try { setIcon(branchIcon, 'git-branch'); } catch { /* ignore */ }

	const branchSelect = branchWrap.createEl('select', { cls: 'gitlab-headerbar-branch-select' });
	branchSelect.createEl('option', {
		text: state.currentBranch,
		value: state.currentBranch,
	});
	for (const b of state.branches ?? []) {
		if (b.name === state.currentBranch) continue;
		const orphaned = b.remoteExists === false;
		branchSelect.createEl('option', {
			text: orphaned ? `⚠ ${b.name} (remote deleted)` : b.name,
			value: b.name,
		});
	}
	branchSelect.value = state.currentBranch;
	branchSelect.addEventListener('change', () => {
		const target = branchSelect.value;
		if (target !== state.currentBranch) {
			void opts.callbacks.onSwitchBranch(target);
		}
	});

	// Sync badges
	const badges = row.createDiv({ cls: 'gitlab-headerbar-badges' });
	const { ahead, behind } = state.syncStatus;
	if (behind > 0) {
		badges.createSpan({ cls: 'gitlab-headerbar-badge gitlab-headerbar-badge-behind', text: `↓${behind}` })
			.title = `${behind} commit(s) behind remote`;
	}
	if (ahead > 0) {
		badges.createSpan({ cls: 'gitlab-headerbar-badge gitlab-headerbar-badge-ahead', text: `↑${ahead}` })
			.title = `${ahead} commit(s) ahead of remote`;
	}
	if (ahead === 0 && behind === 0) {
		const upToDate = badges.createSpan({ cls: 'gitlab-headerbar-badge gitlab-headerbar-badge-uptodate', text: '✓' });
		upToDate.title = 'Up to date with remote';
	}

	// Primary actions: pull / push / fetch
	const actions = row.createDiv({ cls: 'gitlab-headerbar-actions' });
	const isNewBranch = state.syncStatus.remoteBranchMissing === true;
	iconBtn(actions, {
		icon: 'arrow-down-to-line',
		title: 'Pull',
		onClick: opts.callbacks.onPull,
		disabled: state.operationInProgress,
	});
	iconBtn(actions, {
		icon: 'arrow-up-to-line',
		title: isNewBranch ? 'Publish branch to remote' : 'Push',
		onClick: opts.callbacks.onPush,
		disabled: state.operationInProgress || (state.syncStatus.ahead === 0 && !isNewBranch),
		highlight: isNewBranch || state.syncStatus.ahead > 0,
	});
	iconBtn(actions, {
		icon: 'rotate-cw',
		title: 'Fetch',
		onClick: opts.callbacks.onFetch,
		disabled: state.operationInProgress,
	});

	// New branch quick-action and (if relevant) clean-orphans
	iconBtn(actions, {
		icon: 'git-branch-plus',
		title: 'Create new branch from current HEAD',
		onClick: opts.callbacks.onCreateBranch,
		disabled: state.operationInProgress,
	});
	const orphanedBranches = (state.branches ?? []).filter(b => b.remoteExists === false && !b.isCurrent);
	if (orphanedBranches.length > 0) {
		iconBtn(actions, {
			icon: 'trash-2',
			title: `Delete ${orphanedBranches.length} orphaned branch(es) whose remote was deleted`,
			onClick: opts.callbacks.onCleanOrphans,
			disabled: state.operationInProgress,
			danger: true,
		});
	}

	// Overflow menu
	if (opts.callbacks.overflowItems.length > 0) {
		const overflowBtn = iconBtn(actions, {
			icon: 'more-horizontal',
			title: 'More actions',
			onClick: () => { /* handled below */ },
		});
		overflowBtn.addEventListener('click', (e) => {
			e.preventDefault();
			e.stopPropagation();
			const menu = new Menu();
			for (const item of opts.callbacks.overflowItems) {
				menu.addItem(mi => {
					mi.setTitle(item.title);
					if (item.icon) mi.setIcon(item.icon);
					mi.onClick(() => void item.onClick());
				});
			}
			menu.showAtMouseEvent(e as MouseEvent);
		});
	}
}

interface IconBtnOpts {
	icon: string;
	title: string;
	onClick: (e: MouseEvent) => void | Promise<void>;
	disabled?: boolean;
	highlight?: boolean;
	danger?: boolean;
}

function iconBtn(parent: HTMLElement, opts: IconBtnOpts): HTMLButtonElement {
	const btn = parent.createEl('button', {
		cls: `gitlab-headerbar-iconbtn${opts.highlight ? ' is-highlight' : ''}${opts.danger ? ' is-danger' : ''}`,
	});
	btn.title = opts.title;
	btn.setAttr('aria-label', opts.title);
	btn.disabled = !!opts.disabled;
	const iconEl = btn.createSpan({ cls: 'gitlab-headerbar-iconbtn-icon' });
	try { setIcon(iconEl, opts.icon); } catch { iconEl.textContent = '•'; }
	btn.addEventListener('click', (e) => { void opts.onClick(e); });
	return btn;
}
