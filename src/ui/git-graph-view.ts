/**
 * Git Graph View
 * VS Code-like commit graph visualization with branches, merges, and authors
 */

import { ItemView, WorkspaceLeaf, Notice } from 'obsidian';
import GitLabPlugin from '../main';
import { GitCommit } from '../types';

export const VIEW_TYPE_GIT_GRAPH = 'gitlab-git-graph';

// Branch colors for the graph lanes
const LANE_COLORS = [
	'#4ec9b0', '#569cd6', '#ce9178', '#dcdcaa', '#c586c0',
	'#9cdcfe', '#d7ba7d', '#608b4e', '#d16969', '#b5cea8',
	'#6a9955', '#e6c07b', '#61afef', '#c678dd', '#e06c75',
];

interface GraphNode {
	commit: GitCommit;
	column: number;
	branchLabels: string[];
}

interface GraphEdge {
	fromRow: number;
	fromCol: number;
	toRow: number;
	toCol: number;
	color: string;
}

/**
 * Git Graph View — renders commit history as a visual graph
 */
export class GitGraphView extends ItemView {
	plugin: GitLabPlugin;
	private repoId: string | null = null;

	constructor(leaf: WorkspaceLeaf, plugin: GitLabPlugin) {
		super(leaf);
		this.plugin = plugin;
	}

	getViewType(): string {
		return VIEW_TYPE_GIT_GRAPH;
	}

	getDisplayText(): string {
		return 'Git Graph';
	}

	getIcon(): string {
		return 'git-branch';
	}

	async onOpen(): Promise<void> {
		await this.render();
	}

	async onClose(): Promise<void> {
		// cleanup
	}

	/**
	 * Set the repository to display and re-render
	 */
	async setRepository(repoId: string): Promise<void> {
		this.repoId = repoId;
		await this.render();
	}

	async render(): Promise<void> {
		const container = this.containerEl.children[1] as HTMLElement;
		container.empty();
		container.addClass('gitlab-graph-container');

		// Header
		const header = container.createDiv({ cls: 'gitlab-graph-header' });
		header.createEl('h3', { text: '⎇ Git Graph' });

		// Repo selector
		const repos = this.plugin.repositoryManager?.getAllRepositories() || [];
		if (repos.length === 0) {
			container.createEl('p', { text: 'No repositories configured.', cls: 'setting-item-description' });
			return;
		}

		if (!this.repoId && repos.length > 0) {
			this.repoId = repos[0].config.id;
		}

		if (repos.length > 1) {
			const select = header.createEl('select', { cls: 'gitlab-graph-repo-select' });
			repos.forEach(r => {
				const opt = select.createEl('option', { text: r.config.name, value: r.config.id });
				if (r.config.id === this.repoId) opt.selected = true;
			});
			select.addEventListener('change', async () => {
				this.repoId = select.value;
				await this.render();
			});
		}

		// Depth control
		const controls = header.createDiv({ cls: 'gitlab-graph-controls' });
		const depthLabel = controls.createEl('label', { text: 'Commits: ' });
		const depthSelect = depthLabel.createEl('select', { cls: 'gitlab-graph-depth' });
		for (const n of [50, 100, 200, 500]) {
			depthSelect.createEl('option', { text: String(n), value: String(n) });
		}
		depthSelect.value = '100';

		const refreshBtn = controls.createEl('button', { text: '↻ Refresh', cls: 'gitlab-action-button' });

		const graphArea = container.createDiv({ cls: 'gitlab-graph-area' });

		const loadGraph = async () => {
			graphArea.empty();
			graphArea.createEl('p', { text: 'Loading graph...', cls: 'setting-item-description' });

			const gitOps = this.plugin.repositoryManager?.getGitOps(this.repoId!);
			if (!gitOps) {
				graphArea.empty();
				graphArea.createEl('p', { text: 'Repository not found.', cls: 'setting-item-description' });
				return;
			}

			try {
				const depth = parseInt(depthSelect.value);
				const { commits, branchHeads } = await gitOps.getAllBranchLogs(depth);

				if (commits.length === 0) {
					graphArea.empty();
					graphArea.createEl('p', { text: 'No commits found.', cls: 'setting-item-description' });
					return;
				}

				// Build reverse lookup: SHA → branch names
				const shaToBranches = new Map<string, string[]>();
				for (const [name, sha] of branchHeads) {
					if (!shaToBranches.has(sha)) shaToBranches.set(sha, []);
					shaToBranches.get(sha)!.push(name);
				}

				// Add tag labels
				const shaToTags = new Map<string, string[]>();
				try {
					const tags = await gitOps.listTags();
					for (const tag of tags) {
						if (tag.oid) {
							if (!shaToTags.has(tag.oid)) shaToTags.set(tag.oid, []);
							shaToTags.get(tag.oid)!.push(`🏷️ ${tag.name}`);
						}
					}
					// Merge tags into branch labels
					for (const [sha, tagNames] of shaToTags) {
						if (!shaToBranches.has(sha)) shaToBranches.set(sha, []);
						shaToBranches.get(sha)!.push(...tagNames);
					}
				} catch { /* tags not available */ }

				// Layout the graph
				const { nodes, edges, maxColumn } = this.layoutGraph(commits, shaToBranches);

				graphArea.empty();
				this.renderGraph(graphArea, nodes, edges, maxColumn);
			} catch (error) {
				graphArea.empty();
				graphArea.createEl('p', {
					text: `Failed to load graph: ${error instanceof Error ? error.message : 'Unknown error'}`,
					cls: 'setting-item-description',
				});
			}
		};

		refreshBtn.addEventListener('click', loadGraph);
		depthSelect.addEventListener('change', loadGraph);

		await loadGraph();
	}

	/**
	 * Assign columns (lanes) to commits for graph layout
	 */
	private layoutGraph(
		commits: GitCommit[],
		shaToBranches: Map<string, string[]>,
	): { nodes: GraphNode[]; edges: GraphEdge[]; maxColumn: number } {
		const nodes: GraphNode[] = [];
		const edges: GraphEdge[] = [];

		const shaToRow = new Map<string, number>();

		// Active lanes: each lane tracks which SHA it's "following" (waiting for)
		const lanes: (string | null)[] = [];

		const findOrCreateLane = (sha: string): number => {
			// Check if this SHA is already being tracked in a lane
			const idx = lanes.indexOf(sha);
			if (idx !== -1) return idx;
			// Find an empty lane
			const emptyIdx = lanes.indexOf(null);
			if (emptyIdx !== -1) {
				lanes[emptyIdx] = sha;
				return emptyIdx;
			}
			// Create new lane
			lanes.push(sha);
			return lanes.length - 1;
		};

		for (let i = 0; i < commits.length; i++) {
			const commit = commits[i];
			shaToRow.set(commit.sha, i);

			// Find which lane this commit belongs to
			let col = lanes.indexOf(commit.sha);
			if (col === -1) {
				// New branch — assign a lane
				col = findOrCreateLane(commit.sha);
			}

			// Clear the current lane since we've arrived at this commit
			lanes[col] = null;

			const branchLabels = shaToBranches.get(commit.sha) || [];
			nodes.push({ commit, column: col, branchLabels });

			// Route parents
			if (commit.parents.length >= 1) {
				// First parent continues in the same lane
				const firstParent = commit.parents[0];
				const parentRow = shaToRow.get(firstParent);

				if (parentRow === undefined) {
					// Parent hasn't been seen yet — reserve this lane for it
					if (lanes[col] === null) {
						lanes[col] = firstParent;
					} else {
						findOrCreateLane(firstParent);
					}
				}

				// Additional parents (merges) get their own lanes
				for (let p = 1; p < commit.parents.length; p++) {
					const parentSha = commit.parents[p];
					if (!shaToRow.has(parentSha)) {
						findOrCreateLane(parentSha);
					}
				}
			}

			// Clean up lanes that are no longer needed (compact)
			while (lanes.length > 0 && lanes[lanes.length - 1] === null) {
				lanes.pop();
			}
		}

		// Build edges
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			for (const parentSha of node.commit.parents) {
				const parentRow = shaToRow.get(parentSha);
				if (parentRow !== undefined) {
					const parentNode = nodes[parentRow];
					const color = LANE_COLORS[node.column % LANE_COLORS.length];
					edges.push({
						fromRow: i,
						fromCol: node.column,
						toRow: parentRow,
						toCol: parentNode.column,
						color,
					});
				}
			}
		}

		const maxColumn = Math.max(0, ...nodes.map(n => n.column));
		return { nodes, edges, maxColumn };
	}

	/**
	 * Render the graph with SVG lines and HTML commit details
	 */
	private renderGraph(
		container: HTMLElement,
		nodes: GraphNode[],
		edges: GraphEdge[],
		maxColumn: number,
	): void {
		const ROW_HEIGHT = 32;
		const COL_WIDTH = 20;
		const NODE_RADIUS = 5;
		const GRAPH_LEFT_PAD = 10;
		const graphWidth = GRAPH_LEFT_PAD + (maxColumn + 1) * COL_WIDTH + 20;
		const totalHeight = nodes.length * ROW_HEIGHT;

		// Scrollable wrapper
		const wrapper = container.createDiv({ cls: 'gitlab-graph-scroll' });

		// Table-like layout: graph column + details column
		const table = wrapper.createDiv({ cls: 'gitlab-graph-table' });
		table.style.minHeight = `${totalHeight}px`;

		// SVG for the graph lines
		const svgNS = 'http://www.w3.org/2000/svg';
		const svg = document.createElementNS(svgNS, 'svg');
		svg.setAttribute('width', String(graphWidth));
		svg.setAttribute('height', String(totalHeight));
		svg.classList.add('gitlab-graph-svg');

		// Draw edges
		for (const edge of edges) {
			const x1 = GRAPH_LEFT_PAD + edge.fromCol * COL_WIDTH + COL_WIDTH / 2;
			const y1 = edge.fromRow * ROW_HEIGHT + ROW_HEIGHT / 2;
			const x2 = GRAPH_LEFT_PAD + edge.toCol * COL_WIDTH + COL_WIDTH / 2;
			const y2 = edge.toRow * ROW_HEIGHT + ROW_HEIGHT / 2;

			const path = document.createElementNS(svgNS, 'path');

			if (x1 === x2) {
				// Straight vertical line
				path.setAttribute('d', `M ${x1} ${y1} L ${x2} ${y2}`);
			} else {
				// Curved line for branch/merge
				const midY = (y1 + y2) / 2;
				path.setAttribute('d',
					`M ${x1} ${y1} C ${x1} ${midY}, ${x2} ${midY}, ${x2} ${y2}`
				);
			}

			path.setAttribute('stroke', edge.color);
			path.setAttribute('stroke-width', '2');
			path.setAttribute('fill', 'none');
			svg.appendChild(path);
		}

		// Draw commit nodes
		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const cx = GRAPH_LEFT_PAD + node.column * COL_WIDTH + COL_WIDTH / 2;
			const cy = i * ROW_HEIGHT + ROW_HEIGHT / 2;
			const color = LANE_COLORS[node.column % LANE_COLORS.length];

			const isMerge = node.commit.parents.length > 1;

			const circle = document.createElementNS(svgNS, 'circle');
			circle.setAttribute('cx', String(cx));
			circle.setAttribute('cy', String(cy));
			circle.setAttribute('r', String(isMerge ? NODE_RADIUS + 1 : NODE_RADIUS));
			circle.setAttribute('fill', color);
			circle.setAttribute('stroke', isMerge ? '#fff' : 'none');
			circle.setAttribute('stroke-width', isMerge ? '2' : '0');
			svg.appendChild(circle);
		}

		// Graph column
		const graphCol = table.createDiv({ cls: 'gitlab-graph-col' });
		graphCol.style.width = `${graphWidth}px`;
		graphCol.style.minWidth = `${graphWidth}px`;
		graphCol.appendChild(svg);

		// Details column
		const detailsCol = table.createDiv({ cls: 'gitlab-graph-details-col' });

		for (let i = 0; i < nodes.length; i++) {
			const node = nodes[i];
			const color = LANE_COLORS[node.column % LANE_COLORS.length];

			const row = detailsCol.createDiv({ cls: 'gitlab-graph-row' });
			row.style.height = `${ROW_HEIGHT}px`;

			// Branch labels
			if (node.branchLabels.length > 0) {
				for (const label of node.branchLabels) {
					const badge = row.createEl('span', {
						text: label,
						cls: 'gitlab-graph-branch-label',
					});
					badge.style.backgroundColor = color;
				}
			}

			// Commit message (first line only)
			const firstLine = node.commit.message.split('\n')[0].trim();
			row.createEl('span', {
				text: firstLine,
				cls: 'gitlab-graph-message',
			});

			// Author
			row.createEl('span', {
				text: node.commit.authorName,
				cls: 'gitlab-graph-author',
			});

			// Date
			const date = new Date(node.commit.timestamp);
			const relativeTime = this.getRelativeTime(date);
			const dateEl = row.createEl('span', {
				text: relativeTime,
				cls: 'gitlab-graph-date',
			});
			dateEl.setAttribute('title', date.toLocaleString());

			// SHA
			row.createEl('span', {
				text: node.commit.sha.substring(0, 7),
				cls: 'gitlab-graph-sha',
			});

			// Revert button
			if (node.commit.parents.length > 0) {
				const revertBtn = row.createEl('button', {
					text: '↩',
					cls: 'gitlab-tiny-button gitlab-graph-revert',
				});
				revertBtn.title = 'Revert this commit';
				revertBtn.addEventListener('click', async (e) => {
					e.stopPropagation();
					const proceed = confirm(
						`Revert commit "${node.commit.message.split('\n')[0]}"?\n\n` +
						`This will create a new commit that undoes the changes.`
					);
					if (!proceed) return;

					if (!this.repoId) return;
					const gitOps = this.plugin.repositoryManager?.getGitOps(this.repoId);
					if (!gitOps) return;

					try {
						new Notice('Reverting commit...');
						await gitOps.revertCommit(node.commit.sha);
						new Notice('Commit reverted successfully');
						await this.plugin.repositoryManager?.refreshRepository(this.repoId);
						this.plugin.updateStatusBar();
						await this.render();
					} catch (error) {
						new Notice(`Failed to revert: ${error instanceof Error ? error.message : 'Unknown error'}`);
					}
				});
			}
		}
	}

	/**
	 * Get relative time string
	 */
	private getRelativeTime(date: Date): string {
		const now = Date.now();
		const diff = now - date.getTime();
		const seconds = Math.floor(diff / 1000);
		const minutes = Math.floor(seconds / 60);
		const hours = Math.floor(minutes / 60);
		const days = Math.floor(hours / 24);
		const weeks = Math.floor(days / 7);
		const months = Math.floor(days / 30);

		if (seconds < 60) return 'just now';
		if (minutes < 60) return `${minutes}m ago`;
		if (hours < 24) return `${hours}h ago`;
		if (days < 7) return `${days}d ago`;
		if (weeks < 5) return `${weeks}w ago`;
		if (months < 12) return `${months}mo ago`;
		return date.toLocaleDateString();
	}
}
