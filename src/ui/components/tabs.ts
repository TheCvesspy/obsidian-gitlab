/**
 * Tabs UI primitive.
 *
 * Renders a tab strip and a body container. Each tab has an id, a label and
 * an optional icon (Obsidian icon name) and badge (e.g. count of changes).
 *
 * The tab strip auto-collapses to icons-only when the host width drops below
 * COMPACT_WIDTH_PX (a CSS class is toggled via ResizeObserver). The body
 * itself is rendered by the caller via `onChange(activeId, bodyEl)`.
 */
import { setIcon } from 'obsidian';

export interface TabDef {
	id: string;
	label: string;
	/** Optional Obsidian icon id (e.g. "git-pull-request"). */
	icon?: string;
	/** Optional badge text (e.g. number of changes). Falsy = no badge. */
	badge?: string | number;
	/** Optional tooltip when hovering the tab. */
	tooltip?: string;
}

export interface TabsOptions {
	tabs: TabDef[];
	activeId: string;
	onChange: (id: string, bodyEl: HTMLElement) => void | Promise<void>;
	/** Width in px below which the strip collapses to icons-only. Default 260. */
	compactWidthPx?: number;
}

const DEFAULT_COMPACT_WIDTH_PX = 260;

export class Tabs {
	private root: HTMLElement;
	private strip!: HTMLElement;
	private body!: HTMLElement;
	private opts: TabsOptions;
	private activeId: string;
	private resizeObserver?: ResizeObserver;

	constructor(parent: HTMLElement, opts: TabsOptions) {
		this.opts = opts;
		this.activeId = opts.activeId;
		this.root = parent.createDiv({ cls: 'gitlab-tabs' });
		this.renderStrip();
		this.body = this.root.createDiv({ cls: 'gitlab-tab-body' });
		this.observeWidth();
		// Initial render of body for the active tab
		void this.opts.onChange(this.activeId, this.body);
	}

	private renderStrip(): void {
		this.strip = this.root.createDiv({ cls: 'gitlab-tabs-strip' });
		for (const tab of this.opts.tabs) {
			const btn = this.strip.createEl('button', {
				cls: `gitlab-tab${tab.id === this.activeId ? ' is-active' : ''}`,
			});
			btn.dataset.tabId = tab.id;
			if (tab.tooltip) btn.title = tab.tooltip;

			if (tab.icon) {
				const iconEl = btn.createSpan({ cls: 'gitlab-tab-icon' });
				try { setIcon(iconEl, tab.icon); } catch { /* icon may not exist */ }
			}
			btn.createSpan({ cls: 'gitlab-tab-label', text: tab.label });
			if (tab.badge !== undefined && tab.badge !== null && tab.badge !== '' && tab.badge !== 0) {
				btn.createSpan({ cls: 'gitlab-tab-badge', text: String(tab.badge) });
			}

			btn.addEventListener('click', () => {
				if (this.activeId === tab.id) return;
				this.setActive(tab.id);
			});
		}
	}

	private setActive(id: string): void {
		this.activeId = id;
		for (const el of Array.from(this.strip.children) as HTMLElement[]) {
			el.classList.toggle('is-active', el.dataset.tabId === id);
		}
		this.body.empty();
		void this.opts.onChange(id, this.body);
	}

	private observeWidth(): void {
		const threshold = this.opts.compactWidthPx ?? DEFAULT_COMPACT_WIDTH_PX;
		const apply = (w: number) => {
			this.root.classList.toggle('gitlab-tabs-narrow', w < threshold);
		};
		try {
			this.resizeObserver = new ResizeObserver((entries) => {
				for (const entry of entries) apply(entry.contentRect.width);
			});
			this.resizeObserver.observe(this.root);
		} catch {
			// ResizeObserver missing — fall back to a one-shot measurement
			requestAnimationFrame(() => apply(this.root.clientWidth));
		}
	}

	/** Detach observers. Call when the host view is being destroyed. */
	destroy(): void {
		this.resizeObserver?.disconnect();
		this.resizeObserver = undefined;
	}

	getActiveId(): string {
		return this.activeId;
	}
}
