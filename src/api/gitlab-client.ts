/**
 * GitLab REST API client
 * Lightweight client using fetch directly (no @gitbeaker dependency)
 * Handles merge request creation and project info retrieval
 */

import { Notice } from 'obsidian';
import { MergeRequestParams, MergeRequestResult, MergeRequestNote, MergeRequestApproval, Pipeline, PipelineJob } from '../types';
import { DebugLogger } from '../utils/debug-logger';

export interface GitLabClientConfig {
	host: string;
	token: string;
	disableSslVerification?: boolean;
}

export class GitLabClient {
	private config: GitLabClientConfig;

	constructor(config: GitLabClientConfig) {
		this.config = config;
	}

	/**
	 * Extract project path from repository URL
	 */
	static extractProjectPath(repositoryUrl: string): string | null {
		try {
			const url = new URL(repositoryUrl);
			let path = url.pathname;
			path = path.replace(/^\//, '');
			path = path.replace(/\.git$/, '');
			return path;
		} catch {
			return null;
		}
	}

	/**
	 * Extract GitLab host from repository URL
	 */
	static extractHost(repositoryUrl: string): string | null {
		try {
			const url = new URL(repositoryUrl);
			return `${url.protocol}//${url.host}`;
		} catch {
			return null;
		}
	}

	/**
	 * Make an authenticated API request to GitLab
	 */
	private async apiRequest<T>(method: string, endpoint: string, body?: any): Promise<T> {
		const url = `${this.config.host}/api/v4${endpoint}`;
		
		DebugLogger.log('GitLabAPI', `${method} ${endpoint}`);

		// Handle SSL for corporate instances
		const originalTls = process.env.NODE_TLS_REJECT_UNAUTHORIZED;
		if (this.config.disableSslVerification) {
			process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
		}

		try {
			const headers: Record<string, string> = {
				'PRIVATE-TOKEN': this.config.token,
				'Content-Type': 'application/json',
			};

			const options: RequestInit = { method, headers };
			if (body) {
				options.body = JSON.stringify(body);
			}

			const response = await fetch(url, options);

			if (!response.ok) {
				const errorBody = await response.text();
				DebugLogger.error('GitLabAPI', `Request failed`, {
					status: response.status,
					statusText: response.statusText,
					body: errorBody,
				});
				throw new Error(`GitLab API error ${response.status}: ${response.statusText} — ${errorBody}`);
			}

			const data = await response.json();
			return data as T;
		} finally {
			if (this.config.disableSslVerification) {
				if (originalTls !== undefined) {
					process.env.NODE_TLS_REJECT_UNAUTHORIZED = originalTls;
				} else {
					delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
				}
			}
		}
	}

	/**
	 * Test connection to GitLab
	 */
	async testConnection(): Promise<boolean> {
		try {
			await this.apiRequest<any>('GET', '/user');
			return true;
		} catch {
			return false;
		}
	}

	/**
	 * Get the current authenticated user
	 */
	async getCurrentUser(): Promise<{ id: number; name: string; username: string; email: string }> {
		return this.apiRequest('GET', '/user');
	}

	/**
	 * Resolve a project's numeric ID from its path
	 */
	async getProjectId(projectPath: string): Promise<number> {
		const encoded = encodeURIComponent(projectPath);
		const project = await this.apiRequest<{ id: number }>('GET', `/projects/${encoded}`);
		return project.id;
	}

	/**
	 * Get project info
	 */
	async getProject(projectPath: string): Promise<{ id: number; name: string; default_branch: string; web_url: string }> {
		const encoded = encodeURIComponent(projectPath);
		return this.apiRequest('GET', `/projects/${encoded}`);
	}

	/**
	 * List branches for a project
	 */
	async getBranches(projectId: number): Promise<Array<{ name: string; default: boolean }>> {
		return this.apiRequest('GET', `/projects/${projectId}/repository/branches`);
	}

	/**
	 * List all directories in the repository at a given ref using the
	 * GitLab Tree API. Paginates through all results. Recursive walk —
	 * returns POSIX paths of every directory in the repo.
	 */
	async listRepositoryFolders(
		projectId: number,
		ref?: string,
	): Promise<string[]> {
		const folders = new Set<string>();
		let page = 1;
		const perPage = 100;

		while (true) {
			const refQuery = ref ? `&ref=${encodeURIComponent(ref)}` : '';
			const endpoint = `/projects/${projectId}/repository/tree?recursive=true&per_page=${perPage}&page=${page}${refQuery}&pagination=keyset`;
			const entries = await this.apiRequest<Array<{
				type: 'tree' | 'blob';
				path: string;
				name: string;
			}>>('GET', endpoint);

			if (!Array.isArray(entries) || entries.length === 0) break;

			for (const entry of entries) {
				if (entry.type === 'tree') {
					folders.add(entry.path);
				}
			}

			if (entries.length < perPage) break;
			page++;
			if (page > 100) break; // safety cap (10,000 entries)
		}

		return Array.from(folders).sort();
	}

	/**
	 * Create a merge request
	 */
	async createMergeRequest(projectId: number, params: MergeRequestParams): Promise<MergeRequestResult> {
		const body = {
			source_branch: params.sourceBranch,
			target_branch: params.targetBranch,
			title: params.title,
			description: params.description,
		};

		const result = await this.apiRequest<any>('POST', `/projects/${projectId}/merge_requests`, body);

		return {
			iid: result.iid,
			title: result.title,
			webUrl: result.web_url,
			state: result.state,
			sourceBranch: result.source_branch,
			targetBranch: result.target_branch,
		};
	}

	/**
	 * List merge requests for a project
	 */
	async listMergeRequests(projectId: number, state: string = 'opened'): Promise<MergeRequestResult[]> {
		const results = await this.apiRequest<any[]>('GET', `/projects/${projectId}/merge_requests?state=${state}&per_page=20`);

		return results.map(mr => ({
			iid: mr.iid,
			title: mr.title,
			webUrl: mr.web_url,
			state: mr.state,
			sourceBranch: mr.source_branch,
			targetBranch: mr.target_branch,
		}));
	}

	/**
	 * Get notes/comments on a merge request
	 */
	async getMergeRequestNotes(projectId: number, mrIid: number): Promise<MergeRequestNote[]> {
		const results = await this.apiRequest<any[]>('GET', `/projects/${projectId}/merge_requests/${mrIid}/notes?sort=asc&per_page=100`);
		return results.map(note => ({
			id: note.id,
			body: note.body,
			author: { name: note.author.name, username: note.author.username },
			created_at: note.created_at,
			system: note.system,
		}));
	}

	/**
	 * Add a comment to a merge request
	 */
	async createMergeRequestNote(projectId: number, mrIid: number, body: string): Promise<MergeRequestNote> {
		const result = await this.apiRequest<any>('POST', `/projects/${projectId}/merge_requests/${mrIid}/notes`, { body });
		return {
			id: result.id,
			body: result.body,
			author: { name: result.author.name, username: result.author.username },
			created_at: result.created_at,
			system: result.system,
		};
	}

	/**
	 * Get approval status for a merge request
	 */
	async getMergeRequestApprovals(projectId: number, mrIid: number): Promise<MergeRequestApproval> {
		const result = await this.apiRequest<any>('GET', `/projects/${projectId}/merge_requests/${mrIid}/approvals`);
		return {
			approved: result.approved,
			approvals_required: result.approvals_required,
			approvals_left: result.approvals_left,
			approved_by: (result.approved_by || []).map((a: any) => ({
				user: { name: a.user.name, username: a.user.username },
			})),
		};
	}

	/**
	 * Approve a merge request
	 */
	async approveMergeRequest(projectId: number, mrIid: number): Promise<void> {
		await this.apiRequest('POST', `/projects/${projectId}/merge_requests/${mrIid}/approve`);
	}

	/**
	 * Unapprove a merge request
	 */
	async unapproveMergeRequest(projectId: number, mrIid: number): Promise<void> {
		await this.apiRequest('POST', `/projects/${projectId}/merge_requests/${mrIid}/unapprove`);
	}

	/**
	 * Get pipelines for a project, optionally filtered by branch ref
	 */
	async getPipelines(projectId: number, ref?: string): Promise<Pipeline[]> {
		const query = ref ? `?ref=${encodeURIComponent(ref)}&per_page=5` : '?per_page=5';
		const results = await this.apiRequest<any[]>('GET', `/projects/${projectId}/pipelines${query}`);
		return results.map(p => ({
			id: p.id,
			status: p.status,
			ref: p.ref,
			sha: p.sha,
			web_url: p.web_url,
			created_at: p.created_at,
		}));
	}

	/**
	 * Get jobs for a specific pipeline
	 */
	async getPipelineJobs(projectId: number, pipelineId: number): Promise<PipelineJob[]> {
		const results = await this.apiRequest<any[]>('GET', `/projects/${projectId}/pipelines/${pipelineId}/jobs`);
		return results.map(j => ({
			id: j.id,
			name: j.name,
			stage: j.stage,
			status: j.status,
		}));
	}

	/**
	 * Build a web URL for a file or branch on GitLab
	 */
	static buildWebUrl(repositoryUrl: string, branch: string, filePath?: string): string | null {
		const host = GitLabClient.extractHost(repositoryUrl);
		const projectPath = GitLabClient.extractProjectPath(repositoryUrl);
		if (!host || !projectPath) return null;

		if (filePath) {
			return `${host}/${projectPath}/-/blob/${encodeURIComponent(branch)}/${filePath}`;
		}
		return `${host}/${projectPath}/-/tree/${encodeURIComponent(branch)}`;
	}
}
