/**
 * Stash-specific modals.
 *
 * These exist because Electron's renderer disables `window.prompt()` /
 * `window.confirm()` in Obsidian, so the old `prompt('Stash message…')`
 * call silently returned null and the user thought stashing was broken.
 */

import { App, Modal, Notice, setIcon } from 'obsidian';
import type { StashPushOptions } from '../types';

export interface StashCreateInitial {
	defaultMessage?: string;
	branch?: string;
	/** Pre-checked "Include untracked" — defaults to true for Obsidian. */
	includeUntracked?: boolean;
	/** Optional pathspec — when provided the modal renders a per-file label. */
	paths?: string[];
}

/**
 * Modal for creating a new stash. Replaces the old `window.prompt()` call.
 * Resolves with `null` if the user cancels, or a populated StashPushOptions
 * if they confirm.
 */
export class StashCreateModal extends Modal {
	private initial: StashCreateInitial;
	private resolver: ((opts: StashPushOptions | null) => void) | null = null;
	private decided = false;

	constructor(app: App, initial: StashCreateInitial = {}) {
		super(app);
		this.initial = initial;
	}

	pick(): Promise<StashPushOptions | null> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	private decide(opts: StashPushOptions | null): void {
		if (this.decided) return;
		this.decided = true;
		this.resolver?.(opts);
		this.close();
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		contentEl.addClass('gitlab-stash-modal');
		titleEl.setText('Stash changes');

		// Header line — branch + scope context. Makes it clear what's
		// about to be saved even before the user reads the message field.
		const meta = contentEl.createDiv({ cls: 'gitlab-stash-modal-meta' });
		const branchPill = meta.createSpan({ cls: 'gitlab-stash-modal-pill' });
		const branchIcon = branchPill.createSpan({ cls: 'gitlab-stash-modal-pill-icon' });
		try { setIcon(branchIcon, 'git-branch'); } catch { /* ignore */ }
		branchPill.createSpan({ text: this.initial.branch || '(unknown branch)' });

		if (this.initial.paths && this.initial.paths.length > 0) {
			const scopePill = meta.createSpan({ cls: 'gitlab-stash-modal-pill gitlab-stash-modal-pill-scope' });
			const scopeIcon = scopePill.createSpan({ cls: 'gitlab-stash-modal-pill-icon' });
			try { setIcon(scopeIcon, 'file'); } catch { /* ignore */ }
			scopePill.createSpan({
				text: `${this.initial.paths.length} selected file${this.initial.paths.length === 1 ? '' : 's'}`,
			});
		}

		// Message field.
		const msgLabel = contentEl.createEl('label', {
			cls: 'gitlab-stash-modal-label',
			text: 'Message',
		});
		msgLabel.createEl('span', {
			cls: 'gitlab-stash-modal-label-hint',
			text: '— shown in the stash list',
		});
		const msgInput = contentEl.createEl('textarea', {
			cls: 'gitlab-stash-modal-textarea',
			attr: { rows: '2', placeholder: 'Describe what you\'re stashing…' },
		});
		if (this.initial.defaultMessage) msgInput.value = this.initial.defaultMessage;

		// Options.
		const optsRow = contentEl.createDiv({ cls: 'gitlab-stash-modal-options' });

		const untrackedRow = optsRow.createEl('label', { cls: 'gitlab-stash-modal-option' });
		const untrackedCb = untrackedRow.createEl('input', { type: 'checkbox' });
		untrackedCb.checked = this.initial.includeUntracked ?? true;
		untrackedRow.createSpan({ text: 'Include untracked files' });
		untrackedRow.createSpan({
			cls: 'gitlab-stash-modal-option-hint',
			text: 'Captures new notes/images that aren\'t tracked yet.',
		});

		const keepIndexRow = optsRow.createEl('label', { cls: 'gitlab-stash-modal-option' });
		const keepIndexCb = keepIndexRow.createEl('input', { type: 'checkbox' });
		keepIndexCb.checked = false;
		keepIndexRow.createSpan({ text: 'Keep index' });
		keepIndexRow.createSpan({
			cls: 'gitlab-stash-modal-option-hint',
			text: 'Staged changes stay staged in the working tree.',
		});

		// Buttons.
		const btnRow = contentEl.createDiv({ cls: 'gitlab-stash-modal-buttons' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.decide(null));

		const submitBtn = btnRow.createEl('button', { text: 'Stash', cls: 'mod-cta' });
		const submit = () => {
			const message = msgInput.value.trim();
			this.decide({
				message: message || undefined,
				includeUntracked: untrackedCb.checked,
				keepIndex: keepIndexCb.checked,
				paths: this.initial.paths,
			});
		};
		submitBtn.addEventListener('click', submit);

		// Keyboard: Ctrl/Cmd+Enter submits, Esc cancels (Modal handles Esc itself,
		// but onClose still has to treat it as cancel).
		msgInput.addEventListener('keydown', (e) => {
			if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});

		// Focus the message field, select pre-filled text so the user can
		// just start typing to replace it.
		setTimeout(() => {
			msgInput.focus();
			if (msgInput.value) msgInput.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) {
			this.decided = true;
			this.resolver?.(null);
		}
	}
}

/** Small confirmation modal — used in place of the disabled `window.confirm`. */
export class StashConfirmModal extends Modal {
	private title: string;
	private body: string;
	private destructive: boolean;
	private confirmLabel: string;
	private resolver: ((ok: boolean) => void) | null = null;
	private decided = false;

	constructor(
		app: App,
		title: string,
		body: string,
		opts: { destructive?: boolean; confirmLabel?: string } = {},
	) {
		super(app);
		this.title = title;
		this.body = body;
		this.destructive = opts.destructive ?? true;
		this.confirmLabel = opts.confirmLabel ?? 'Confirm';
	}

	pick(): Promise<boolean> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	private decide(ok: boolean): void {
		if (this.decided) return;
		this.decided = true;
		this.resolver?.(ok);
		this.close();
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		titleEl.setText(this.title);
		contentEl.addClass('gitlab-stash-modal');
		contentEl.createEl('p', { text: this.body, cls: 'gitlab-stash-modal-body' });

		const btnRow = contentEl.createDiv({ cls: 'gitlab-stash-modal-buttons' });
		const cancel = btnRow.createEl('button', { text: 'Cancel' });
		cancel.addEventListener('click', () => this.decide(false));

		const confirm = btnRow.createEl('button', {
			text: this.confirmLabel,
			cls: this.destructive ? 'mod-warning' : 'mod-cta',
		});
		confirm.addEventListener('click', () => this.decide(true));

		setTimeout(() => confirm.focus(), 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) {
			this.decided = true;
			this.resolver?.(false);
		}
	}
}

/** Tiny modal for typing a new branch name when running "Branch from stash". */
export class StashBranchModal extends Modal {
	private suggestion: string;
	private resolver: ((name: string | null) => void) | null = null;
	private decided = false;

	constructor(app: App, suggestion: string) {
		super(app);
		this.suggestion = suggestion;
	}

	pick(): Promise<string | null> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	private decide(name: string | null): void {
		if (this.decided) return;
		this.decided = true;
		this.resolver?.(name);
		this.close();
	}

	onOpen(): void {
		const { contentEl, titleEl } = this;
		contentEl.addClass('gitlab-stash-modal');
		titleEl.setText('Create branch from stash');
		contentEl.createEl('p', {
			cls: 'gitlab-stash-modal-body',
			text: 'Applies this stash on a new branch and drops it on success. Useful when the stash no longer applies cleanly to the current branch.',
		});

		const label = contentEl.createEl('label', {
			cls: 'gitlab-stash-modal-label',
			text: 'Branch name',
		});
		label.createEl('span', {
			cls: 'gitlab-stash-modal-label-hint',
			text: '— branches off the commit the stash was created from',
		});
		const input = contentEl.createEl('input', {
			type: 'text',
			cls: 'gitlab-stash-modal-input',
			attr: { placeholder: 'feature/recovered-stash' },
		});
		input.value = this.suggestion;

		const btnRow = contentEl.createDiv({ cls: 'gitlab-stash-modal-buttons' });
		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.decide(null));
		const submitBtn = btnRow.createEl('button', { text: 'Create branch', cls: 'mod-cta' });
		const submit = () => {
			const name = input.value.trim();
			if (!name) {
				new Notice('Branch name is required.');
				return;
			}
			this.decide(name);
		};
		submitBtn.addEventListener('click', submit);
		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				e.preventDefault();
				submit();
			}
		});
		setTimeout(() => {
			input.focus();
			input.select();
		}, 0);
	}

	onClose(): void {
		this.contentEl.empty();
		if (!this.decided) {
			this.decided = true;
			this.resolver?.(null);
		}
	}
}
