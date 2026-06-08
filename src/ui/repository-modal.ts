import { App, Modal, Setting, Notice } from 'obsidian';
import { SubTreeConfig } from '../types';
import {
	validateRepositoryConfig,
	generateRepositoryId,
	extractRepoNameFromUrl
} from '../utils/validators';
import type { IGitBackend } from '../api/git-backend';
import { SparseTreePickerModal } from './sparse-tree-picker-modal';
import { isJunctionSupported } from '../utils/junction-utils';

/**
 * Modal for adding or editing a repository configuration
 */
export class RepositoryConfigModal extends Modal {
	private config: Partial<SubTreeConfig>;
	private onSubmit: (config: SubTreeConfig) => void;
	private isEdit: boolean;
	private gitCliAvailable: boolean;
	private getGitOps: ((repoId: string) => IGitBackend | undefined) | null;

	constructor(
		app: App,
		existingConfig: Partial<SubTreeConfig> | null,
		onSubmit: (config: SubTreeConfig) => void,
		gitCliAvailable = false,
		getGitOps: ((repoId: string) => IGitBackend | undefined) | null = null,
	) {
		super(app);
		this.isEdit = existingConfig !== null;
		this.config = existingConfig || {
			enabled: true,
			currentBranch: 'main'
		};
		this.onSubmit = onSubmit;
		this.gitCliAvailable = gitCliAvailable;
		this.getGitOps = getGitOps;
	}

	onOpen() {
		const { contentEl } = this;
		contentEl.empty();

		contentEl.createEl('h2', { 
			text: this.isEdit ? 'Edit Repository Mapping' : 'Add Repository Mapping'
		});

		// Name field
		new Setting(contentEl)
			.setName('Repository Name')
			.setDesc('A friendly name for this repository')
			.addText(text => text
				.setPlaceholder('My Project')
				.setValue(this.config.name || '')
				.onChange(value => {
					this.config.name = value;
				}));

		// Local path field
		new Setting(contentEl)
			.setName('Local Path')
			.setDesc('Path to the folder within your vault (relative to vault root)')
			.addText(text => text
				.setPlaceholder('Projects/MyProject')
				.setValue(this.config.localPath || '')
				.onChange(value => {
					this.config.localPath = value;
				}));

		// Repository URL field
		new Setting(contentEl)
			.setName('GitLab Repository URL')
			.setDesc('HTTPS URL of your GitLab repository')
			.addText(text => {
				text
					.setPlaceholder('https://gitlab.com/username/project.git')
					.setValue(this.config.repositoryUrl || '')
					.onChange(value => {
						this.config.repositoryUrl = value;
						
						// Auto-fill name if empty
						if (!this.config.name && value) {
							const extractedName = extractRepoNameFromUrl(value);
							this.config.name = extractedName;
							// We'd need to refresh the modal to show the updated name
						}
					});
				text.inputEl.style.width = '100%';
			});

		// Access token field
		new Setting(contentEl)
			.setName('Personal Access Token')
			.setDesc('GitLab personal access token with repository access')
			.addText(text => {
				text
					.setPlaceholder('glpat-xxxxxxxxxxxxxxxxxxxx')
					.setValue(this.config.token || '')
					.onChange(value => {
						this.config.token = value;
					});
				text.inputEl.type = 'password';
				text.inputEl.style.width = '100%';
			});

		// Current branch field
		new Setting(contentEl)
			.setName('Default Branch')
			.setDesc('The default branch to use (typically "main" or "master")')
			.addText(text => text
				.setPlaceholder('main')
				.setValue(this.config.currentBranch || 'main')
				.onChange(value => {
					this.config.currentBranch = value;
				}));

		// Enabled toggle
		new Setting(contentEl)
			.setName('Enabled')
			.setDesc('Whether this repository mapping is active')
			.addToggle(toggle => toggle
				.setValue(this.config.enabled ?? true)
				.onChange(value => {
					this.config.enabled = value;
				}));

		// SSL Verification toggle
		new Setting(contentEl)
			.setName('Disable SSL Verification')
			.setDesc('⚠️ Only enable for self-signed certificates or trusted corporate GitLab instances')
			.addToggle(toggle => toggle
				.setValue(this.config.disableSslVerification ?? false)
				.onChange(value => {
					this.config.disableSslVerification = value;
				}));

		// Ignore patterns
		const ignoreSetting = new Setting(contentEl)
			.setName('Exclude Patterns')
			.setDesc('Glob patterns to exclude from sync and display (one per line). E.g.: src/**, *.exe, build/**');

		const ignoreTextarea = contentEl.createEl('textarea', {
			cls: 'gitlab-ignore-textarea',
			placeholder: 'src/**\nbuild/**\n*.exe\nnode_modules/**\n.env',
		});
		ignoreTextarea.value = (this.config.ignorePatterns || []).join('\n');
		ignoreTextarea.addEventListener('input', () => {
			this.config.ignorePatterns = ignoreTextarea.value
				.split('\n')
				.map(l => l.trim())
				.filter(l => l.length > 0 && !l.startsWith('#'));
		});

		// GitLab Pages compatibility section
		contentEl.createEl('h3', { text: 'GitLab Pages compatibility' });
		const pagesDesc = contentEl.createEl('p', {
			text: 'Rewrite Obsidian-only syntax (image embeds, wiki links, callouts) at commit time so docs render correctly on GitLab Pages. Your vault notes are not modified.',
		});
		pagesDesc.style.fontSize = '0.85em';
		pagesDesc.style.opacity = '0.8';

		const pagesCfg = (this.config.gitlabPagesCompat ||= { enabled: false });

		new Setting(contentEl)
			.setName('Enable GitLab Pages transform')
			.setDesc('Apply transforms to staged .md files when committing this repo')
			.addToggle(toggle => toggle
				.setValue(pagesCfg.enabled)
				.onChange(value => {
					pagesCfg.enabled = value;
				}));

		new Setting(contentEl)
			.setName('Assets folder')
			.setDesc('Folder (relative to repo root, forward slashes) where out-of-repo images are copied at commit time. Default: assets. Tip: set Obsidian Settings → Files & Links → "Default location for new attachments" to this same folder so pasted images land here directly and the plugin has nothing to copy.')
			.addText(text => text
				.setPlaceholder('assets')
				.setValue(pagesCfg.assetsFolder || '')
				.onChange(value => {
					pagesCfg.assetsFolder = value.trim() || undefined;
				}));

		new Setting(contentEl)
			.setName('Transform image embeds')
			.setDesc('![[image.png]] → ![](path) (or <img> when width is set)')
			.addToggle(toggle => toggle
				.setValue(pagesCfg.transformImages !== false)
				.onChange(value => {
					pagesCfg.transformImages = value;
				}));

		new Setting(contentEl)
			.setName('Transform wiki links')
			.setDesc('[[note]] → [note](note.md)')
			.addToggle(toggle => toggle
				.setValue(pagesCfg.transformWikiLinks !== false)
				.onChange(value => {
					pagesCfg.transformWikiLinks = value;
				}));

		new Setting(contentEl)
			.setName('Transform callouts')
			.setDesc('> [!note] → portable emoji-prefixed blockquote')
			.addToggle(toggle => toggle
				.setValue(pagesCfg.transformCallouts !== false)
				.onChange(value => {
					pagesCfg.transformCallouts = value;
				}));

		new Setting(contentEl)
			.setName('Max asset size (MB)')
			.setDesc('Out-of-repo images larger than this will abort the commit instead of being moved into the repo. Default: 10.')
			.addText(text => text
				.setPlaceholder('10')
				.setValue(pagesCfg.maxAssetBytes != null ? String(Math.round(pagesCfg.maxAssetBytes / (1024 * 1024))) : '')
				.onChange(value => {
					const n = Number(value.trim());
					if (Number.isFinite(n) && n > 0) {
						pagesCfg.maxAssetBytes = Math.round(n * 1024 * 1024);
					} else {
						pagesCfg.maxAssetBytes = undefined;
					}
				}));

		// Forward declaration so the sparse textarea's onInput can refresh
		// the hidden-clone alias list when the user adds/removes sparse paths.
		let refreshHiddenCloneUi: (() => void) | null = null;

		// Sparse checkout section
		contentEl.createEl('h3', { text: 'Sparse checkout' });

		if (this.gitCliAvailable) {
			const sparseDesc = contentEl.createEl('p', {
				text: 'Check out only specific directories from the repository. Other files remain in Git but are not downloaded to your vault.',
			});
			sparseDesc.style.fontSize = '0.85em';
			sparseDesc.style.opacity = '0.8';

			const sparseCfg = (this.config.sparseCheckout ||= { enabled: false, paths: [] });

			new Setting(contentEl)
				.setName('Enable sparse checkout')
				.setDesc('Only check out selected directories (cone mode)')
				.addToggle(toggle => toggle
					.setValue(sparseCfg.enabled)
					.onChange(value => {
						sparseCfg.enabled = value;
						sparsePathsContainer.style.display = value ? 'block' : 'none';
					}));

			const sparsePathsContainer = contentEl.createDiv();
			sparsePathsContainer.style.display = sparseCfg.enabled ? 'block' : 'none';

			const sparsePathsHeader = sparsePathsContainer.createDiv();
			sparsePathsHeader.style.display = 'flex';
			sparsePathsHeader.style.justifyContent = 'space-between';
			sparsePathsHeader.style.alignItems = 'center';
			sparsePathsHeader.style.marginBottom = '4px';

			const sparsePathsLabel = sparsePathsHeader.createDiv();
			sparsePathsLabel.createEl('div', {
				text: 'Included paths',
				cls: 'setting-item-name',
			});
			sparsePathsLabel.createEl('div', {
				text: 'Directories to include (one per line, relative to repo root)',
				cls: 'setting-item-description',
			});

			const browseBtn = sparsePathsHeader.createEl('button', { text: 'Browse…' });
			browseBtn.style.marginLeft = '8px';

			const sparseTextarea = sparsePathsContainer.createEl('textarea', {
				cls: 'gitlab-ignore-textarea',
				placeholder: 'docs/cs/analysis\nassets/images',
			});
			sparseTextarea.value = (sparseCfg.paths || []).join('\n');
			sparseTextarea.addEventListener('input', () => {
				sparseCfg.paths = sparseTextarea.value
					.split('\n')
					.map(l => l.trim().replace(/\\/g, '/'))
					.filter(l => l.length > 0 && !l.startsWith('#'));
				// Re-render junction aliases section so it reflects the new sparse paths
				if (refreshHiddenCloneUi) refreshHiddenCloneUi();
			});

			browseBtn.addEventListener('click', () => {
				// Validate we have what we need
				if (!this.config.repositoryUrl || !this.config.token) {
					new Notice('Set the repository URL and token before browsing the tree.');
					return;
				}

				// Build a minimal SubTreeConfig snapshot for the picker
				const repoForPicker: SubTreeConfig = {
					id: this.config.id || 'temp',
					name: this.config.name || 'Repository',
					localPath: this.config.localPath || '',
					repositoryUrl: this.config.repositoryUrl,
					token: this.config.token,
					currentBranch: this.config.currentBranch || 'main',
					enabled: true,
					disableSslVerification: this.config.disableSslVerification,
					ignorePatterns: this.config.ignorePatterns,
				};

				const gitOps = (this.getGitOps && this.config.id)
					? this.getGitOps(this.config.id)
					: undefined;

				const picker = new SparseTreePickerModal(
					this.app,
					repoForPicker,
					gitOps,
					sparseCfg.paths || [],
					(paths) => {
						sparseCfg.paths = paths;
						sparseTextarea.value = paths.join('\n');
					},
				);
				picker.open();
			});
		} else {
			const unavailable = contentEl.createEl('p', {
				text: 'Sparse checkout unavailable — Git CLI not found on your system. Install Git to enable this feature.',
			});
			unavailable.style.fontSize = '0.85em';
			unavailable.style.opacity = '0.6';
			unavailable.style.fontStyle = 'italic';
		}

		// Hidden clone & junctions section (Windows only, requires sparse checkout)
		contentEl.createEl('h3', { text: 'Hidden clone & junctions' });

		if (!isJunctionSupported()) {
			const note = contentEl.createEl('p', {
				text: 'Hidden clone mode requires Windows (uses directory junctions). Unavailable on this platform.',
			});
			note.style.fontSize = '0.85em';
			note.style.opacity = '0.6';
			note.style.fontStyle = 'italic';
		} else if (!this.gitCliAvailable) {
			const note = contentEl.createEl('p', {
				text: 'Hidden clone mode requires the Git CLI backend (and sparse checkout).',
			});
			note.style.fontSize = '0.85em';
			note.style.opacity = '0.6';
			note.style.fontStyle = 'italic';
		} else {
			const hcDesc = contentEl.createEl('p', {
				text: 'Move the clone to a hidden vault folder and expose each sparse path as a directory junction at a custom vault location. Useful for documentation repos where the deep clone path is noisy.',
			});
			hcDesc.style.fontSize = '0.85em';
			hcDesc.style.opacity = '0.8';

			const hcCfg = (this.config.hiddenClone ||= { enabled: false, cloneFolder: '', aliases: {} });
			const sparseCfg = this.config.sparseCheckout || { enabled: false, paths: [] };

			const enableSetting = new Setting(contentEl)
				.setName('Enable hidden clone with junctions')
				.setDesc('On save, the clone moves to a hidden folder and junctions are created for each sparse path.')
				.addToggle(toggle => toggle
					.setValue(hcCfg.enabled)
					.setDisabled(!sparseCfg.enabled || (sparseCfg.paths || []).length === 0)
					.onChange(value => {
						hcCfg.enabled = value;
						if (refreshHiddenCloneUi) refreshHiddenCloneUi();
					}));

			if (!sparseCfg.enabled || (sparseCfg.paths || []).length === 0) {
				const hint = contentEl.createEl('p', {
					text: 'Enable sparse checkout with at least one path above to use this feature.',
				});
				hint.style.fontSize = '0.8em';
				hint.style.opacity = '0.6';
				hint.style.marginLeft = '4px';
			}

			// Container for the rest of the hidden-clone UI (clone folder + aliases)
			const hcContainer = contentEl.createDiv();

			refreshHiddenCloneUi = () => {
				hcContainer.empty();
				if (!hcCfg.enabled) return;

				new Setting(hcContainer)
					.setName('Hidden clone folder')
					.setDesc('Vault-relative folder where the clone lives. Leave blank to use the default (.gitlab-clones/<repo-id>).')
					.addText(text => text
						.setPlaceholder(`.gitlab-clones/${this.config.id || '<repo-id>'}`)
						.setValue(hcCfg.cloneFolder || '')
						.onChange(value => {
							hcCfg.cloneFolder = value.trim();
						}));

				const aliasHeader = hcContainer.createEl('h4', { text: 'Junction aliases' });
				aliasHeader.style.marginBottom = '4px';
				const aliasDesc = hcContainer.createEl('p', {
					text: 'Where each sparse path should appear in your vault.',
				});
				aliasDesc.style.fontSize = '0.8em';
				aliasDesc.style.opacity = '0.7';
				aliasDesc.style.marginTop = '0';

				const sparsePaths = sparseCfg.paths || [];
				if (sparsePaths.length === 0) {
					const empty = hcContainer.createEl('p', {
						text: '(No sparse paths configured yet — add some above.)',
					});
					empty.style.opacity = '0.6';
					empty.style.fontStyle = 'italic';
					return;
				}

				for (const sparsePath of sparsePaths) {
					const defaultAlias = `${(this.config.localPath || '').replace(/[/\\]+$/, '')}/${sparsePath.split('/').pop() || sparsePath}`.replace(/^\/+/, '');
					if (!hcCfg.aliases[sparsePath]) hcCfg.aliases[sparsePath] = defaultAlias;
					new Setting(hcContainer)
						.setName(sparsePath)
						.setDesc('Vault-relative junction path')
						.addText(text => text
							.setValue(hcCfg.aliases[sparsePath])
							.setPlaceholder(defaultAlias)
							.onChange(value => {
								hcCfg.aliases[sparsePath] = value.trim().replace(/\\/g, '/');
							}));
				}

				// Prune orphan aliases (sparse path no longer exists)
				const sparseSet = new Set(sparsePaths);
				for (const key of Object.keys(hcCfg.aliases)) {
					if (!sparseSet.has(key)) delete hcCfg.aliases[key];
				}
			};

			refreshHiddenCloneUi();
		}

		// Buttons
		const buttonContainer = contentEl.createDiv({ cls: 'modal-button-container' });
		buttonContainer.style.display = 'flex';
		buttonContainer.style.justifyContent = 'flex-end';
		buttonContainer.style.gap = '10px';
		buttonContainer.style.marginTop = '20px';

		// Cancel button
		const cancelButton = buttonContainer.createEl('button', { text: 'Cancel' });
		cancelButton.addEventListener('click', () => {
			this.close();
		});

		// Save button
		const saveButton = buttonContainer.createEl('button', { 
			text: this.isEdit ? 'Save' : 'Add',
			cls: 'mod-cta'
		});
		saveButton.addEventListener('click', () => {
			this.handleSubmit();
		});
	}

	private handleSubmit() {
		// Validate configuration
		const validation = validateRepositoryConfig(this.config);
		
		if (!validation.valid) {
			new Notice(`Validation failed:\n${validation.errors.join('\n')}`);
			return;
		}

		// Generate ID if this is a new config
		if (!this.config.id) {
			this.config.id = generateRepositoryId(this.config.name!);
		}

		// Ensure all required fields are present
		const completeConfig: SubTreeConfig = {
			id: this.config.id!,
			name: this.config.name!,
			localPath: this.config.localPath!,
			repositoryUrl: this.config.repositoryUrl!,
			token: this.config.token!,
			currentBranch: this.config.currentBranch!,
			enabled: this.config.enabled ?? true,
			lastSync: this.config.lastSync,
			disableSslVerification: this.config.disableSslVerification ?? false,
			ignorePatterns: this.config.ignorePatterns || [],
			gitlabPagesCompat: this.config.gitlabPagesCompat,
			sparseCheckout: this.config.sparseCheckout,
			hiddenClone: this.config.hiddenClone,
		};

		this.onSubmit(completeConfig);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
