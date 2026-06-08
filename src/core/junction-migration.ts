/**
 * One-shot migration to hidden-clone-with-junctions mode.
 *
 * Called by the settings save handler when it detects `hiddenClone.enabled`
 * flipped from off to on for a repo. Moves the existing clone (if any) into
 * the hidden folder, then creates junctions for each sparse path.
 *
 * Idempotent and rollback-safe: if anything after the rename fails, we
 * rename back to the original location.
 */

import { App, Notice } from 'obsidian';
import * as fs from 'fs';
import * as path from 'path';
import { SubTreeConfig, GitLabPluginSettings } from '../types';
import { SettingsManager } from '../settings';
import { RepositoryManager } from './repository-manager';
import { JunctionManager } from './junction-manager';
import { isJunctionSupported } from '../utils/junction-utils';
import { DebugLogger } from '../utils/debug-logger';

export interface MigrationResult {
	cloneFolder: string;
	movedFromLegacyPath: boolean;
	aliasesCreated: number;
	conflicts: string[];
}

export async function migrateToHiddenClone(
	app: App,
	settingsManager: SettingsManager,
	repoManager: RepositoryManager,
	config: SubTreeConfig,
	junctionMgr: JunctionManager,
): Promise<MigrationResult> {
	// Pre-flight
	if (!isJunctionSupported()) {
		throw new Error('Hidden clone mode requires Windows (directory junctions).');
	}
	if (!config.hiddenClone?.enabled) {
		throw new Error('hiddenClone.enabled is false — nothing to migrate.');
	}
	if (!config.sparseCheckout?.enabled || (config.sparseCheckout?.paths || []).length === 0) {
		throw new Error('Sparse checkout must be enabled with at least one path before using hidden clone.');
	}

	const basePath = (app.vault.adapter as any).basePath as string;

	// Ensure cloneFolder is set
	if (!config.hiddenClone.cloneFolder) {
		config.hiddenClone.cloneFolder = junctionMgr.defaultCloneFolder(config.id);
	}
	const newCloneAbs = path.join(basePath, config.hiddenClone.cloneFolder);
	const oldCloneAbs = path.join(basePath, config.localPath);

	const oldExists = fs.existsSync(oldCloneAbs);
	const newExists = fs.existsSync(newCloneAbs);

	if (newExists && oldExists && !pathsEqual(oldCloneAbs, newCloneAbs)) {
		throw new Error(
			`Migration target "${config.hiddenClone.cloneFolder}" already exists. ` +
			`Remove it or pick a different folder.`,
		);
	}

	// Stop the file watcher on the old path so the rename isn't blocked
	repoManager.stopWatcherPublic(config.id);

	let movedFromLegacyPath = false;
	if (oldExists && !pathsEqual(oldCloneAbs, newCloneAbs)) {
		// Make sure parent directory exists
		const parent = path.dirname(newCloneAbs);
		if (!fs.existsSync(parent)) {
			fs.mkdirSync(parent, { recursive: true });
		}
		try {
			fs.renameSync(oldCloneAbs, newCloneAbs);
			movedFromLegacyPath = true;
			DebugLogger.log('JunctionMigration', 'Clone moved', { from: oldCloneAbs, to: newCloneAbs });
		} catch (e) {
			throw new Error(`Failed to move clone: ${e instanceof Error ? e.message : String(e)}`);
		}
	} else if (!oldExists && !newExists) {
		// Fresh repo — just create the empty target directory; the normal
		// init/clone flow will populate it on next finalize.
		fs.mkdirSync(newCloneAbs, { recursive: true });
	}

	// Seed any missing aliases with defaults
	junctionMgr.seedAliases(config);

	// Persist config
	const settings = settingsManager.getSettings();
	const idx = settings.repositories.findIndex(r => r.id === config.id);
	if (idx !== -1) {
		settings.repositories[idx] = config;
	}
	await settingsManager.saveSettings();

	let conflicts: string[] = [];
	let aliasesCreated = 0;

	try {
		// Re-register the repository so the backend picks up the new clone path.
		// We use the same initialize+finalize flow that the settings save handler
		// uses; the manager will see hiddenClone enabled and reconcile junctions.
		await repoManager.initialize(settings.repositories);
		await repoManager.finalizeInitialization();

		// Reconcile junctions explicitly so we can return per-alias results.
		const results = await junctionMgr.reconcile(config);
		for (const [alias, status] of results) {
			if (status === 'created' || status === 'repaired') aliasesCreated++;
			if (status === 'conflict' || status === 'error') conflicts.push(alias);
		}
	} catch (e) {
		// Rollback: try to restore the clone to its original location
		if (movedFromLegacyPath) {
			try {
				fs.renameSync(newCloneAbs, oldCloneAbs);
				DebugLogger.warn('JunctionMigration', 'Rolled back clone move', { error: String(e) });
			} catch (rollbackErr) {
				DebugLogger.error('JunctionMigration', 'Rollback failed', { error: String(rollbackErr) });
			}
		}
		// Mark hiddenClone disabled in the saved settings so next load is sane
		if (idx !== -1) {
			settings.repositories[idx].hiddenClone = { ...config.hiddenClone, enabled: false };
			await settingsManager.saveSettings();
		}
		throw e;
	}

	if (conflicts.length > 0) {
		new Notice(
			`Hidden clone migration completed with ${conflicts.length} conflict(s). ` +
			`See console for details.`,
			10_000,
		);
	} else {
		new Notice(
			`"${config.name}" migrated to hidden clone — ${aliasesCreated} junction(s) created.`,
			6_000,
		);
	}

	return {
		cloneFolder: config.hiddenClone.cloneFolder,
		movedFromLegacyPath,
		aliasesCreated,
		conflicts,
	};
}

function pathsEqual(a: string, b: string): boolean {
	const norm = (p: string) => p.replace(/[\\/]+/g, '/').replace(/\/+$/, '').toLowerCase();
	return norm(a) === norm(b);
}
