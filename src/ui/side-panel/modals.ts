/**
 * Side-panel modal dialogs.
 * Extracted from side-panel-view.ts so handler/tab modules can import
 * them without pulling the whole view (avoids circular imports).
 */

import { App, Modal, Notice } from 'obsidian';

export type CheckoutConflictChoice = 'stash' | 'discard' | 'cancel';

/**
 * Modal shown when a branch switch is blocked by local file changes that
 * isomorphic-git would overwrite. Lets the user choose to stash, force-discard,
 * or cancel — replacing the no-op `window.prompt` path that doesn't work in
 * Obsidian's Electron renderer.
 */
export class CheckoutConflictModal extends Modal {
	private fromBranch: string;
	private toBranch: string;
	private files: string[];
	private resolver: ((c: CheckoutConflictChoice) => void) | null = null;
	private decided = false;

	constructor(app: App, fromBranch: string, toBranch: string, files: string[]) {
		super(app);
		this.fromBranch = fromBranch;
		this.toBranch = toBranch;
		this.files = files;
	}

	pick(): Promise<CheckoutConflictChoice> {
		return new Promise((resolve) => {
			this.resolver = resolve;
			this.open();
		});
	}

	private decide(choice: CheckoutConflictChoice): void {
		if (this.decided) return;
		this.decided = true;
		this.resolver?.(choice);
		this.close();
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Cannot switch branches' });
		contentEl.createEl('p', {
			text: `Switching from "${this.fromBranch}" to "${this.toBranch}" would overwrite local changes in:`,
		});

		const list = contentEl.createEl('ul');
		(this.files.length ? this.files : ['(unknown files)']).forEach(f => {
			list.createEl('li', { text: f });
		});

		const btnRow = contentEl.createDiv();
		btnRow.style.cssText = 'display:flex;gap:8px;justify-content:flex-end;margin-top:12px;flex-wrap:wrap;';

		const stashBtn = btnRow.createEl('button', { text: 'Stash & switch' });
		stashBtn.title = 'Save your changes to a stash, then switch branches';
		stashBtn.addEventListener('click', () => this.decide('stash'));

		const discardBtn = btnRow.createEl('button', { text: 'Discard & switch' });
		discardBtn.style.cssText = 'background:var(--background-modifier-error);color:var(--text-on-accent);';
		discardBtn.title = 'PERMANENTLY discard your local changes and force the switch';
		discardBtn.addEventListener('click', () => {
			if (confirm('This will permanently DISCARD your local changes. Continue?')) {
				this.decide('discard');
			}
		});

		const cancelBtn = btnRow.createEl('button', { text: 'Cancel' });
		cancelBtn.addEventListener('click', () => this.decide('cancel'));
	}

	onClose(): void {
		this.contentEl.empty();
		// If the user dismissed the modal another way (Esc, click outside), treat as cancel.
		if (!this.decided) {
			this.decided = true;
			this.resolver?.('cancel');
		}
	}
}

/**
 * Modal for selecting a branch to switch to.
 */
export class BranchSwitchModal extends Modal {
	private branches: string[];
	private onSelect: (branch: string) => void;

	constructor(app: App, branches: string[], onSelect: (branch: string) => void) {
		super(app);
		this.branches = branches;
		this.onSelect = onSelect;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Switch Branch' });

		const list = contentEl.createDiv({ cls: 'gitlab-branch-list' });
		this.branches.forEach(branch => {
			const item = list.createEl('button', {
				text: branch,
				cls: 'gitlab-branch-list-item',
			});
			item.addEventListener('click', () => {
				this.onSelect(branch);
				this.close();
			});
		});
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Modal for creating a new branch.
 */
export class CreateBranchModal extends Modal {
	private fromBranch: string;
	private onCreate: (branchName: string) => void;

	constructor(app: App, fromBranch: string, onCreate: (branchName: string) => void) {
		super(app);
		this.fromBranch = fromBranch;
		this.onCreate = onCreate;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Create New Branch' });
		contentEl.createEl('p', {
			text: `From: ${this.fromBranch}`,
			cls: 'setting-item-description',
		});

		const inputContainer = contentEl.createDiv({ cls: 'gitlab-branch-create' });
		const input = inputContainer.createEl('input', {
			type: 'text',
			placeholder: 'Branch name...',
			cls: 'gitlab-branch-input',
		});

		const createBtn = inputContainer.createEl('button', {
			text: 'Create',
			cls: 'gitlab-commit-button',
		});
		createBtn.addEventListener('click', () => {
			const name = input.value.trim();
			if (name) {
				this.onCreate(name);
				this.close();
			} else {
				new Notice('Please enter a branch name');
			}
		});

		input.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') {
				createBtn.click();
			}
		});

		input.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Modal for creating a new tag.
 */
export class CreateTagModal extends Modal {
	private onSubmit: (name: string, message: string) => void;

	constructor(app: App, onSubmit: (name: string, message: string) => void) {
		super(app);
		this.onSubmit = onSubmit;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.createEl('h3', { text: 'Create Tag' });

		const nameInput = contentEl.createEl('input', {
			type: 'text',
			placeholder: 'Tag name (e.g. v1.0)',
			cls: 'gitlab-tag-input',
		});
		nameInput.style.width = '100%';
		nameInput.style.marginBottom = '8px';

		contentEl.createEl('p', {
			text: 'Message (optional — adds an annotated tag):',
			cls: 'setting-item-description',
		});

		const messageInput = contentEl.createEl('textarea', {
			placeholder: 'Tag message...',
			cls: 'gitlab-tag-message-input',
		});
		messageInput.style.width = '100%';
		messageInput.rows = 3;

		const createBtn = contentEl.createEl('button', {
			text: 'Create Tag',
			cls: 'gitlab-commit-button',
		});
		createBtn.style.marginTop = '8px';
		createBtn.addEventListener('click', () => {
			const name = nameInput.value.trim();
			if (name) {
				this.onSubmit(name, messageInput.value.trim());
				this.close();
			} else {
				new Notice('Please enter a tag name');
			}
		});

		nameInput.addEventListener('keydown', (e) => {
			if (e.key === 'Enter') createBtn.click();
		});

		nameInput.focus();
	}

	onClose(): void {
		this.contentEl.empty();
	}
}

/**
 * Modal for showing contextual help.
 */
export class HelpTooltipModal extends Modal {
	private helpTitle: string;
	private detail: string;

	constructor(app: App, title: string, detail: string) {
		super(app);
		this.helpTitle = title;
		this.detail = detail;
	}

	onOpen(): void {
		const { contentEl } = this;
		contentEl.addClass('gitlab-help-modal');
		contentEl.createEl('h3', { text: `ⓘ ${this.helpTitle}` });

		const paragraphs = this.detail.split('\n');
		for (const p of paragraphs) {
			if (p.trim()) {
				contentEl.createEl('p', { text: p.trim(), cls: 'gitlab-help-text' });
			}
		}

		const closeBtn = contentEl.createEl('button', {
			text: 'Got it',
			cls: 'mod-cta',
		});
		closeBtn.style.marginTop = '12px';
		closeBtn.addEventListener('click', () => this.close());
	}

	onClose(): void {
		this.contentEl.empty();
	}
}
