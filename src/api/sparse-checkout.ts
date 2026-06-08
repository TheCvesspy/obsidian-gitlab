/**
 * High-level sparse checkout orchestration.
 *
 * Wraps the IGitBackend sparse-checkout methods with flows for
 * initial setup, path updates, and state queries. Used by the
 * repository manager for sparse clone and by the UI for managing
 * sparse paths on existing repos.
 */

import type { IGitBackend } from './git-backend';
import { UnsupportedOperationError } from './git-cli-executor';
import { DebugLogger } from '../utils/debug-logger';

export class SparseCheckoutManager {
	private backend: IGitBackend;

	constructor(backend: IGitBackend) {
		this.backend = backend;
	}

	/**
	 * Initialize sparse checkout on an existing repo and set the
	 * cone-mode include paths. Idempotent: calling on a repo that
	 * already has sparse checkout enabled just updates the paths.
	 */
	async initSparse(paths: string[]): Promise<void> {
		if (paths.length === 0) {
			DebugLogger.warn('SparseCheckout', 'No paths specified; skipping init');
			return;
		}

		try {
			// Modern Git (2.30+) auto-initializes via `set` — we skip the
			// explicit `init --cone` step because it has a known crash on
			// Git for Windows when re-applying to an existing checkout.
			await this.backend.sparseCheckoutSet(paths);
			DebugLogger.log('SparseCheckout', 'Initialized', { paths });
		} catch (error) {
			if (error instanceof UnsupportedOperationError) {
				DebugLogger.warn('SparseCheckout', 'Backend does not support sparse checkout');
				throw error;
			}
			throw error;
		}
	}

	/**
	 * Replace the current sparse paths with a new set. If the repo
	 * does not have sparse checkout enabled, initializes it first.
	 */
	async updatePaths(paths: string[]): Promise<void> {
		if (paths.length === 0) {
			await this.disable();
			return;
		}
		await this.initSparse(paths);
	}

	/**
	 * Add more paths to the existing sparse set without removing
	 * current ones.
	 */
	async addPaths(paths: string[]): Promise<void> {
		if (paths.length === 0) return;
		await this.backend.sparseCheckoutAdd(paths);
	}

	/**
	 * Check whether sparse checkout is currently active.
	 */
	async isActive(): Promise<boolean> {
		try {
			return await this.backend.isSparseCheckout();
		} catch {
			return false;
		}
	}

	/**
	 * Get the list of currently included cone paths.
	 */
	async getIncludedPaths(): Promise<string[]> {
		try {
			return await this.backend.sparseCheckoutList();
		} catch {
			return [];
		}
	}

	/**
	 * Disable sparse checkout, restoring the full working tree.
	 */
	async disable(): Promise<void> {
		try {
			const active = await this.isActive();
			if (active) {
				await this.backend.sparseCheckoutDisable();
				DebugLogger.log('SparseCheckout', 'Disabled');
			}
		} catch (error) {
			if (!(error instanceof UnsupportedOperationError)) {
				throw error;
			}
		}
	}
}
