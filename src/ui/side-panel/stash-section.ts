/**
 * Stash section — rebuilt for the Changes tab.
 *
 * Surface area:
 *   • One prominent "Stash changes" button at the top, enabled iff there is
 *     anything stashable (tracked changes OR untracked files when -u is on).
 *   • List of existing stashes, each row expandable to show its file list.
 *   • Per-row actions: Pop, Apply, Branch from stash, Drop.
 *   • Sticky "Clear all" footer when there is more than one entry, gated
 *     by a confirmation modal.
 *
 * Why this lives in its own module: side-panel-view.ts is already 2k+ LOC
 * and the old stash section was buried in the Branches tab. Splitting it
 * out keeps the rewrite reviewable and lets `render` re-use the section
 * from either tab without duplicating logic.
 */

import { App, Notice, setIcon } from 'obsidian';
import type GitLabPlugin from '../../main';
import type { RepositoryState, StashEntry, StashFileChange, StashPushOptions } from '../../types';
import type { IGitBackend } from '../../api/git-backend';
import { StashCreateModal, StashConfirmModal, StashBranchModal } from '../stash-modals';

export interface StashSectionDeps {
	app: App;
	plugin: GitLabPlugin;
	state: RepositoryState;
	/**
	 * Called after any operation that may have changed working-tree or
	 * stash state. Implementations typically run refreshRepository + re-render.
	 */
	rerender: () => Promise<void>;
}

/**
 * Render the full stash section into `container`. The function is async
 * because it loads the stash list before rendering — callers that want
 * to avoid a flash of "loading" should await this.
 */
export async function renderStashSection(
	container: HTMLElement,
	deps: StashSectionDeps,
): Promise<void> {
	const { app, plugin, state, rerender } = deps;
	const gitOps = plugin.repositoryManager?.getGitOps(state.config.id);
	if (!gitOps) return;

	const section = container.createDiv({ cls: 'gitlab-stash-v2' });

	// Header — title + count + primary "Stash changes" button.
	const header = section.createDiv({ cls: 'gitlab-stash-v2-header' });
	const titleWrap = header.createDiv({ cls: 'gitlab-stash-v2-title-wrap' });
	const titleIcon = titleWrap.createSpan({ cls: 'gitlab-stash-v2-title-icon' });
	try { setIcon(titleIcon, 'archive'); } catch { /* ignore */ }
	titleWrap.createSpan({ text: 'Stash', cls: 'gitlab-stash-v2-title' });
	const countBadge = titleWrap.createSpan({ cls: 'gitlab-stash-v2-count' });

	const primaryBtn = header.createEl('button', { cls: 'gitlab-stash-v2-primary mod-cta' });
	const primaryIcon = primaryBtn.createSpan({ cls: 'gitlab-stash-v2-primary-icon' });
	try { setIcon(primaryIcon, 'archive'); } catch { /* ignore */ }
	primaryBtn.createSpan({ text: 'Stash changes' });
	const canStash =
		state.syncStatus.hasUncommittedChanges || state.syncStatus.hasUntrackedFiles;
	primaryBtn.disabled = !canStash;
	primaryBtn.title = canStash
		? 'Save your work-in-progress to a stash'
		: 'Nothing to stash — your working tree is clean';
	primaryBtn.addEventListener('click', async () => {
		await runStashCreate({ app, plugin, state, rerender });
	});

	// Body — list (lazy-loaded so the section doesn't block on a slow git
	// call when the user hasn't expanded the panel yet).
	const body = section.createDiv({ cls: 'gitlab-stash-v2-body' });
	const loadingEl = body.createDiv({ cls: 'gitlab-stash-v2-loading', text: 'Loading stashes…' });

	let entries: StashEntry[] = [];
	try {
		entries = await gitOps.stashList();
	} catch {
		// stashList swallows errors and returns [], so reaching here means
		// the backend itself blew up. Keep going with an empty list — the
		// section still works for creating new stashes.
	}
	loadingEl.remove();

	countBadge.setText(entries.length > 0 ? String(entries.length) : '');

	if (entries.length === 0) {
		const empty = body.createDiv({ cls: 'gitlab-stash-v2-empty' });
		const emptyIcon = empty.createDiv({ cls: 'gitlab-stash-v2-empty-icon' });
		try { setIcon(emptyIcon, 'archive'); } catch { /* ignore */ }
		empty.createEl('div', {
			cls: 'gitlab-stash-v2-empty-title',
			text: 'No stashes yet',
		});
		empty.createEl('div', {
			cls: 'gitlab-stash-v2-empty-hint',
			text: 'Use "Stash changes" above to set aside your work-in-progress without committing.',
		});
		return;
	}

	const list = body.createDiv({ cls: 'gitlab-stash-v2-list' });
	for (const entry of entries) {
		renderEntry(list, entry, gitOps, deps);
	}

	if (entries.length > 1) {
		const footer = section.createDiv({ cls: 'gitlab-stash-v2-footer' });
		const clearBtn = footer.createEl('button', {
			cls: 'gitlab-stash-v2-clear mod-warning',
			text: `Clear all (${entries.length})`,
		});
		clearBtn.addEventListener('click', async () => {
			const ok = await new StashConfirmModal(
				app,
				'Clear all stashes?',
				`This will permanently delete all ${entries.length} stash entries. This cannot be undone.`,
				{ destructive: true, confirmLabel: 'Delete all' },
			).pick();
			if (!ok) return;
			try {
				await gitOps.stashClear();
				new Notice('All stashes cleared.');
				await rerender();
			} catch (e) {
				new Notice(`Failed to clear stashes: ${describe(e)}`, 8000);
			}
		});
	}
}

// ---------- entry row ----------

function renderEntry(
	parent: HTMLElement,
	entry: StashEntry,
	gitOps: IGitBackend,
	deps: StashSectionDeps,
): void {
	const { app, rerender } = deps;
	const row = parent.createDiv({ cls: 'gitlab-stash-v2-row' });

	// --- Summary line (clickable to expand) ---
	const summary = row.createDiv({ cls: 'gitlab-stash-v2-summary' });
	const expander = summary.createSpan({ cls: 'gitlab-stash-v2-expander' });
	try { setIcon(expander, 'chevron-right'); } catch { /* ignore */ }

	const info = summary.createDiv({ cls: 'gitlab-stash-v2-info' });
	const topLine = info.createDiv({ cls: 'gitlab-stash-v2-top' });
	topLine.createSpan({
		cls: 'gitlab-stash-v2-ref',
		text: `stash@{${entry.index}}`,
	});
	topLine.createSpan({
		cls: 'gitlab-stash-v2-msg',
		text: entry.message?.trim() || '(no message)',
	});

	const subLine = info.createDiv({ cls: 'gitlab-stash-v2-sub' });
	if (entry.branch) {
		const b = subLine.createSpan({ cls: 'gitlab-stash-v2-sub-pill' });
		const bIcon = b.createSpan({ cls: 'gitlab-stash-v2-sub-pill-icon' });
		try { setIcon(bIcon, 'git-branch'); } catch { /* ignore */ }
		b.createSpan({ text: entry.branch });
	}
	if (entry.timestamp) {
		const t = subLine.createSpan({ cls: 'gitlab-stash-v2-sub-time' });
		t.setText(formatRelativeTime(entry.timestamp));
		t.title = new Date(entry.timestamp * 1000).toLocaleString();
	}
	if (entry.oid) {
		subLine.createSpan({
			cls: 'gitlab-stash-v2-sub-oid',
			text: entry.oid.slice(0, 7),
		});
	}

	// --- Action buttons ---
	const actions = summary.createDiv({ cls: 'gitlab-stash-v2-actions' });

	const popBtn = makeActionBtn(actions, 'corner-down-left', 'Pop — apply this stash and remove it from the list', async () => {
		try {
			await gitOps.stashPop(entry.index);
			new Notice('Stash popped.');
			await rerender();
		} catch (e) {
			new Notice(`Failed to pop stash: ${describe(e)}`, 8000);
		}
	});
	popBtn.createSpan({ text: 'Pop' });

	const applyBtn = makeActionBtn(actions, 'copy', 'Apply — apply this stash but keep it in the list', async () => {
		try {
			await gitOps.stashApply(entry.index);
			new Notice('Stash applied.');
			await rerender();
		} catch (e) {
			new Notice(`Failed to apply stash: ${describe(e)}`, 8000);
		}
	});
	applyBtn.createSpan({ text: 'Apply' });

	const branchBtn = makeIconBtn(actions, 'git-branch-plus', 'Create branch from stash', async () => {
		const suggestion = suggestBranchName(entry);
		const name = await new StashBranchModal(app, suggestion).pick();
		if (!name) return;
		try {
			await gitOps.stashBranch(entry.index, name);
			new Notice(`Created branch '${name}' from stash and popped it.`);
			await rerender();
		} catch (e) {
			new Notice(`Failed to create branch from stash: ${describe(e)}`, 8000);
		}
	});
	branchBtn.classList.add('gitlab-stash-v2-iconbtn');

	const dropBtn = makeIconBtn(actions, 'trash-2', 'Drop this stash', async () => {
		const ok = await new StashConfirmModal(
			app,
			'Drop this stash?',
			`stash@{${entry.index}}${entry.message ? ` — “${entry.message}”` : ''} will be permanently deleted. This cannot be undone.`,
			{ destructive: true, confirmLabel: 'Drop' },
		).pick();
		if (!ok) return;
		try {
			await gitOps.stashDrop(entry.index);
			new Notice('Stash dropped.');
			await rerender();
		} catch (e) {
			new Notice(`Failed to drop stash: ${describe(e)}`, 8000);
		}
	});
	dropBtn.classList.add('gitlab-stash-v2-iconbtn', 'gitlab-stash-v2-iconbtn-danger');

	// --- Lazy-loaded file list (toggled by clicking the summary) ---
	const detail = row.createDiv({ cls: 'gitlab-stash-v2-detail gitlab-stash-v2-collapsed' });
	let loaded = false;
	let loadingPromise: Promise<void> | null = null;
	const toggle = async () => {
		const nowCollapsed = !detail.classList.contains('gitlab-stash-v2-collapsed');
		detail.classList.toggle('gitlab-stash-v2-collapsed');
		try { setIcon(expander, nowCollapsed ? 'chevron-right' : 'chevron-down'); } catch { /* ignore */ }
		if (!nowCollapsed && !loaded) {
			loadingPromise ??= loadDetail(detail, entry, gitOps).then(() => { loaded = true; });
			await loadingPromise;
		}
	};
	summary.addEventListener('click', (e) => {
		// Don't toggle when the user clicked one of the action buttons.
		if ((e.target as HTMLElement).closest('button')) return;
		void toggle();
	});
}

async function loadDetail(
	container: HTMLElement,
	entry: StashEntry,
	gitOps: IGitBackend,
): Promise<void> {
	const loading = container.createDiv({ cls: 'gitlab-stash-v2-detail-loading', text: 'Loading files…' });
	let files: StashFileChange[] = [];
	try {
		files = await gitOps.stashShow(entry.index);
	} catch {
		// fall through
	}
	loading.remove();

	if (files.length === 0) {
		container.createDiv({
			cls: 'gitlab-stash-v2-detail-empty',
			text: 'No file preview available for this stash.',
		});
		return;
	}

	const totalAdd = files.reduce((s, f) => s + f.insertions, 0);
	const totalDel = files.reduce((s, f) => s + f.deletions, 0);
	const stat = container.createDiv({ cls: 'gitlab-stash-v2-detail-stat' });
	stat.createSpan({
		cls: 'gitlab-stash-v2-detail-stat-files',
		text: `${files.length} file${files.length === 1 ? '' : 's'}`,
	});
	if (totalAdd > 0) {
		stat.createSpan({ cls: 'gitlab-stash-v2-add', text: `+${totalAdd}` });
	}
	if (totalDel > 0) {
		stat.createSpan({ cls: 'gitlab-stash-v2-del', text: `-${totalDel}` });
	}

	const list = container.createDiv({ cls: 'gitlab-stash-v2-detail-files' });
	for (const f of files) {
		const fileRow = list.createDiv({ cls: 'gitlab-stash-v2-detail-file' });
		fileRow.createSpan({
			cls: `gitlab-stash-v2-detail-status gitlab-stash-v2-detail-status-${f.status.toLowerCase()}`,
			text: f.status,
			attr: { title: statusLabel(f.status) },
		});
		fileRow.createSpan({ cls: 'gitlab-stash-v2-detail-file-path', text: f.path });
		const stats = fileRow.createSpan({ cls: 'gitlab-stash-v2-detail-file-stats' });
		if (f.insertions > 0) stats.createSpan({ cls: 'gitlab-stash-v2-add', text: `+${f.insertions}` });
		if (f.deletions > 0) stats.createSpan({ cls: 'gitlab-stash-v2-del', text: `-${f.deletions}` });
	}
}

// ---------- helpers ----------

/**
 * Run the stash creation flow: open the modal, push to git, re-render.
 * Exported so the side panel can wire it both into the section header and
 * into the per-file "Stash this file" context action.
 */
export async function runStashCreate(
	deps: StashSectionDeps,
	initialOpts: { paths?: string[]; defaultMessageOverride?: string } = {},
): Promise<void> {
	const { app, plugin, state, rerender } = deps;
	const gitOps = plugin.repositoryManager?.getGitOps(state.config.id);
	if (!gitOps) return;

	const branch = state.currentBranch || 'work';
	const defaultMessage = initialOpts.defaultMessageOverride
		?? `WIP on ${branch} · ${formatTimestampForMessage(new Date())}`;

	const opts = await new StashCreateModal(app, {
		defaultMessage,
		branch,
		includeUntracked: true,
		paths: initialOpts.paths,
	}).pick();
	if (!opts) return;

	try {
		await gitOps.stashPush(opts as StashPushOptions);
		new Notice('Changes stashed.');
		await rerender();
	} catch (e) {
		new Notice(`Failed to stash: ${describe(e)}`, 8000);
	}
}

function makeActionBtn(
	parent: HTMLElement,
	icon: string,
	tooltip: string,
	onClick: () => void | Promise<void>,
): HTMLButtonElement {
	const btn = parent.createEl('button', { cls: 'gitlab-stash-v2-actionbtn' });
	btn.title = tooltip;
	btn.setAttr('aria-label', tooltip);
	const iconEl = btn.createSpan({ cls: 'gitlab-stash-v2-actionbtn-icon' });
	try { setIcon(iconEl, icon); } catch { /* ignore */ }
	btn.addEventListener('click', async (e) => {
		e.stopPropagation();
		btn.disabled = true;
		try { await onClick(); }
		finally { btn.disabled = false; }
	});
	return btn;
}

function makeIconBtn(
	parent: HTMLElement,
	icon: string,
	tooltip: string,
	onClick: () => void | Promise<void>,
): HTMLButtonElement {
	const btn = parent.createEl('button', { cls: 'gitlab-stash-v2-actionbtn' });
	btn.title = tooltip;
	btn.setAttr('aria-label', tooltip);
	try { setIcon(btn, icon); } catch { btn.textContent = '•'; }
	btn.addEventListener('click', async (e) => {
		e.stopPropagation();
		btn.disabled = true;
		try { await onClick(); }
		finally { btn.disabled = false; }
	});
	return btn;
}

function suggestBranchName(entry: StashEntry): string {
	const slug = (entry.message || 'stash')
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '-')
		.replace(/^-+|-+$/g, '')
		.slice(0, 32);
	return `stash/${slug || 'recovered'}-${entry.index}`;
}

function formatRelativeTime(epochSeconds: number): string {
	const now = Date.now() / 1000;
	const diff = Math.max(0, now - epochSeconds);
	if (diff < 60) return 'just now';
	if (diff < 3600) {
		const m = Math.floor(diff / 60);
		return `${m} minute${m === 1 ? '' : 's'} ago`;
	}
	if (diff < 86400) {
		const h = Math.floor(diff / 3600);
		return `${h} hour${h === 1 ? '' : 's'} ago`;
	}
	if (diff < 86400 * 7) {
		const d = Math.floor(diff / 86400);
		return `${d} day${d === 1 ? '' : 's'} ago`;
	}
	const date = new Date(epochSeconds * 1000);
	return date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatTimestampForMessage(d: Date): string {
	const pad = (n: number) => String(n).padStart(2, '0');
	return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function statusLabel(s: string): string {
	switch (s.toUpperCase()) {
		case 'A': return 'Added';
		case 'M': return 'Modified';
		case 'D': return 'Deleted';
		case 'R': return 'Renamed';
		case 'C': return 'Copied';
		case '?': return 'Untracked';
		default: return s;
	}
}

function describe(e: unknown): string {
	if (e instanceof Error) return e.message;
	return String(e);
}
