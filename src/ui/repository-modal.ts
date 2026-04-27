import { App, Modal, Setting, Notice } from 'obsidian';
import { SubTreeConfig } from '../types';
import { 
	validateRepositoryConfig, 
	generateRepositoryId,
	extractRepoNameFromUrl 
} from '../utils/validators';

/**
 * Modal for adding or editing a repository configuration
 */
export class RepositoryConfigModal extends Modal {
	private config: Partial<SubTreeConfig>;
	private onSubmit: (config: SubTreeConfig) => void;
	private isEdit: boolean;

	constructor(
		app: App,
		existingConfig: Partial<SubTreeConfig> | null,
		onSubmit: (config: SubTreeConfig) => void
	) {
		super(app);
		this.isEdit = existingConfig !== null;
		this.config = existingConfig || {
			enabled: true,
			currentBranch: 'main'
		};
		this.onSubmit = onSubmit;
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
		};

		this.onSubmit(completeConfig);
		this.close();
	}

	onClose() {
		const { contentEl } = this;
		contentEl.empty();
	}
}
