/**
 * File Explorer Status Decorator
 * Applies VS Code-like git status indicators to Obsidian's file explorer
 */

import { App, TFile, TFolder } from 'obsidian';
import { RepositoryManager } from '../core/repository-manager';
import type { JunctionManager } from '../core/junction-manager';
import { FileStatus, GitFile } from '../types';
import { normalizePath, isPathWithin } from '../utils/path-utils';

/**
 * Maps FileStatus to a short badge letter
 */
function statusToBadge(status: FileStatus): string {
	switch (status) {
		case FileStatus.MODIFIED: return 'M';
		case FileStatus.ADDED: return 'A';
		case FileStatus.DELETED: return 'D';
		case FileStatus.UNTRACKED: return 'U';
		case FileStatus.RENAMED: return 'R';
		case FileStatus.CONFLICTED: return 'C';
		default: return '';
	}
}

/**
 * Maps FileStatus to a CSS color class suffix
 */
function statusToColorClass(status: FileStatus): string {
	switch (status) {
		case FileStatus.MODIFIED: return 'modified';
		case FileStatus.ADDED: return 'added';
		case FileStatus.DELETED: return 'deleted';
		case FileStatus.UNTRACKED: return 'untracked';
		case FileStatus.RENAMED: return 'renamed';
		case FileStatus.CONFLICTED: return 'conflicted';
		default: return '';
	}
}

/**
 * Aggregates file statuses for a folder path.
 * Returns the "most important" status among children.
 */
function aggregateFolderStatus(folderPath: string, files: GitFile[]): FileStatus | null {
	const normalizedFolder = normalizePath(folderPath);
	const childStatuses: FileStatus[] = [];

	for (const file of files) {
		if (file.status === FileStatus.UNMODIFIED || file.status === FileStatus.IGNORED) continue;
		const filePath = normalizePath(file.path);
		// Check if this file is inside this folder
		if (filePath.startsWith(normalizedFolder + '/') || filePath.startsWith(normalizedFolder + '\\')) {
			childStatuses.push(file.status);
		}
	}

	if (childStatuses.length === 0) return null;

	// Priority: conflicted > deleted > modified > added > untracked > renamed
	const priority: FileStatus[] = [
		FileStatus.CONFLICTED,
		FileStatus.DELETED,
		FileStatus.MODIFIED,
		FileStatus.ADDED,
		FileStatus.UNTRACKED,
		FileStatus.RENAMED,
	];

	for (const p of priority) {
		if (childStatuses.includes(p)) return p;
	}

	return childStatuses[0];
}

export class FileExplorerDecorator {
	private app: App;
	private repositoryManager: RepositoryManager;
	private junctionManager: JunctionManager | null;
	private observer: MutationObserver | null = null;
	private enabled: boolean = true;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;

	constructor(app: App, repositoryManager: RepositoryManager, junctionManager: JunctionManager | null = null) {
		this.app = app;
		this.repositoryManager = repositoryManager;
		this.junctionManager = junctionManager;
	}

	/**
	 * Start observing the file explorer and applying decorations
	 */
	start(): void {
		this.applyDecorations();

		// Observe DOM changes to re-apply decorations when file explorer updates
		this.observer = new MutationObserver(() => {
			this.debouncedApply();
		});

		// Observe the workspace container for changes
		const container = document.querySelector('.workspace');
		if (container) {
			this.observer.observe(container, {
				childList: true,
				subtree: true,
			});
		}
	}

	/**
	 * Stop observing and remove all decorations
	 */
	stop(): void {
		if (this.observer) {
			this.observer.disconnect();
			this.observer = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		this.removeAllDecorations();
	}

	/**
	 * Toggle decorations on/off
	 */
	setEnabled(enabled: boolean): void {
		this.enabled = enabled;
		if (enabled) {
			this.applyDecorations();
		} else {
			this.removeAllDecorations();
		}
	}

	/**
	 * Force refresh decorations (call after git operations)
	 */
	refresh(): void {
		if (this.enabled) {
			this.applyDecorations();
		}
	}

	private debouncedApply(): void {
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
		}
		this.debounceTimer = setTimeout(() => {
			if (this.enabled) {
				this.applyDecorations();
			}
		}, 300);
	}

	/**
	 * Build a map of vault-relative file paths to their git status
	 */
	private buildStatusMap(): Map<string, FileStatus> {
		const statusMap = new Map<string, FileStatus>();
		const repos = this.repositoryManager.getAllRepositories();

		for (const state of repos) {
			if (!state.config.enabled) continue;
			const useJunctions = this.junctionManager?.isActiveFor(state.config);
			const repoLocalPath = normalizePath(state.config.localPath);

			for (const file of state.files) {
				if (file.status === FileStatus.UNMODIFIED || file.status === FileStatus.IGNORED) continue;

				let vaultPath: string | null;
				if (useJunctions) {
					vaultPath = this.junctionManager!.repoRelativeToVaultPath(state.config, file.path);
				} else {
					vaultPath = normalizePath(repoLocalPath + '/' + file.path);
				}

				if (vaultPath) statusMap.set(normalizePath(vaultPath), file.status);
			}
		}

		return statusMap;
	}

	/**
	 * Build a map of vault-relative folder paths to aggregated status
	 */
	private buildFolderStatusMap(statusMap: Map<string, FileStatus>): Map<string, FileStatus> {
		const folderMap = new Map<string, FileStatus>();
		const repos = this.repositoryManager.getAllRepositories();

		for (const state of repos) {
			if (!state.config.enabled) continue;
			const useJunctions = this.junctionManager?.isActiveFor(state.config);
			const repoLocalPath = normalizePath(state.config.localPath);

			// Compute the vault path for every changed file once, so the folder
			// walk uses the right (junction-translated) hierarchy.
			const translated: Array<{ vaultPath: string; status: FileStatus }> = [];
			for (const file of state.files) {
				if (file.status === FileStatus.UNMODIFIED || file.status === FileStatus.IGNORED) continue;
				let vaultPath: string | null;
				if (useJunctions) {
					vaultPath = this.junctionManager!.repoRelativeToVaultPath(state.config, file.path);
				} else {
					vaultPath = normalizePath(repoLocalPath + '/' + file.path);
				}
				if (vaultPath) translated.push({ vaultPath: normalizePath(vaultPath), status: file.status });
			}

			// Junction roots act as "stop walking up" boundaries so a status
			// badge on a junction file doesn't propagate up to vault root.
			const stopAt = new Set<string>(
				useJunctions
					? this.junctionManager!.listVaultRoots(state.config).map(p => normalizePath(p))
					: [repoLocalPath],
			);

			const folders = new Set<string>();
			for (const { vaultPath } of translated) {
				let dir = vaultPath;
				while (true) {
					const lastSlash = Math.max(dir.lastIndexOf('/'), dir.lastIndexOf('\\'));
					if (lastSlash <= 0) break;
					dir = dir.substring(0, lastSlash);
					folders.add(dir);
					if (stopAt.has(dir)) break;
				}
			}

			for (const folder of folders) {
				const folderStatus = aggregateFolderStatus(
					folder,
					translated.map(({ vaultPath, status }) => ({ path: vaultPath, status, staged: false })),
				);
				if (folderStatus) folderMap.set(folder, folderStatus);
			}
		}

		return folderMap;
	}

	/**
	 * Apply status decorations to the file explorer DOM
	 */
	private applyDecorations(): void {
		if (!this.enabled) return;

		const statusMap = this.buildStatusMap();
		const folderStatusMap = this.buildFolderStatusMap(statusMap);

		// Decorate file items
		const fileItems = document.querySelectorAll('.nav-file-title');
		fileItems.forEach((el) => {
			const htmlEl = el as HTMLElement;
			const dataPath = htmlEl.getAttribute('data-path');
			if (!dataPath) return;

			const normalizedPath = normalizePath(dataPath);
			const status = statusMap.get(normalizedPath);

			// Remove previous decorations
			htmlEl.removeAttribute('data-gitlab-status');
			htmlEl.classList.forEach(cls => {
				if (cls.startsWith('gitlab-explorer-')) htmlEl.classList.remove(cls);
			});

			if (status) {
				const badge = statusToBadge(status);
				const colorClass = statusToColorClass(status);
				if (badge) {
					htmlEl.setAttribute('data-gitlab-status', badge);
				}
				if (colorClass) {
					htmlEl.classList.add(`gitlab-explorer-${colorClass}`);
				}
			}
		});

		// Decorate folder items
		const folderItems = document.querySelectorAll('.nav-folder-title');
		folderItems.forEach((el) => {
			const htmlEl = el as HTMLElement;
			const dataPath = htmlEl.getAttribute('data-path');
			if (!dataPath) return;

			const normalizedPath = normalizePath(dataPath);
			const status = folderStatusMap.get(normalizedPath);

			// Remove previous decorations
			htmlEl.removeAttribute('data-gitlab-status');
			htmlEl.classList.forEach(cls => {
				if (cls.startsWith('gitlab-explorer-')) htmlEl.classList.remove(cls);
			});

			if (status) {
				const colorClass = statusToColorClass(status);
				if (colorClass) {
					htmlEl.classList.add(`gitlab-explorer-${colorClass}`);
				}
				// Show count of changed files in this folder
				const badge = statusToBadge(status);
				if (badge) {
					htmlEl.setAttribute('data-gitlab-status', badge);
				}
			}
		});

		// Mark repo root folders
		const repos = this.repositoryManager.getAllRepositories();
		for (const state of repos) {
			if (!state.config.enabled) continue;
			const repoPath = normalizePath(state.config.localPath);
			const repoFolder = document.querySelector(`.nav-folder-title[data-path="${repoPath}"]`) as HTMLElement;
			if (repoFolder) {
				repoFolder.setAttribute('data-gitlab-repo', 'true');
			}
		}
	}

	/**
	 * Remove all git status decorations from the file explorer
	 */
	private removeAllDecorations(): void {
		document.querySelectorAll('[data-gitlab-status]').forEach(el => {
			el.removeAttribute('data-gitlab-status');
		});
		document.querySelectorAll('[data-gitlab-repo]').forEach(el => {
			el.removeAttribute('data-gitlab-repo');
		});
		document.querySelectorAll('.nav-file-title, .nav-folder-title').forEach(el => {
			el.classList.forEach(cls => {
				if (cls.startsWith('gitlab-explorer-')) el.classList.remove(cls);
			});
		});
	}
}
