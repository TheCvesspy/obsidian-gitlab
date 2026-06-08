import { execFile } from 'child_process';
import * as path from 'path';

export interface GitExecOptions {
	cwd?: string;
	env?: Record<string, string>;
	timeout?: number;
	/** Pipe this data to stdin */
	stdin?: Buffer | string;
}

export interface GitExecResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

export class GitCliError extends Error {
	constructor(
		public readonly command: string[],
		public readonly exitCode: number,
		public readonly stderr: string,
		public readonly stdout: string,
	) {
		super(`git ${command[0]} failed (exit ${exitCode}): ${stderr.trim() || stdout.trim()}`);
		this.name = 'GitCliError';
	}

	get isAuthError(): boolean {
		return this.stderr.includes('Authentication failed') ||
			this.stderr.includes('could not read Username') ||
			this.stderr.includes('terminal prompts disabled') ||
			this.exitCode === 128 && this.stderr.includes('fatal:');
	}

	get isNetworkError(): boolean {
		return this.stderr.includes('Could not resolve host') ||
			this.stderr.includes('unable to access') ||
			this.stderr.includes('Connection refused') ||
			this.stderr.includes('SSL certificate problem');
	}

	get isMergeConflict(): boolean {
		return this.stderr.includes('CONFLICT') ||
			this.stderr.includes('Automatic merge failed') ||
			this.stdout.includes('CONFLICT');
	}

	get isNotARepo(): boolean {
		return this.stderr.includes('not a git repository');
	}
}

export class GitNotFoundError extends Error {
	constructor() {
		super(
			'Git CLI not found. Install Git and ensure it is on your PATH, ' +
			'or set a custom path in the plugin settings.',
		);
		this.name = 'GitNotFoundError';
	}
}

export class UnsupportedOperationError extends Error {
	constructor(operation: string) {
		super(`${operation} is not supported by the current Git backend`);
		this.name = 'UnsupportedOperationError';
	}
}

const DEFAULT_TIMEOUT = 60_000;

export class GitCliExecutor {
	private gitPath: string;
	private defaultCwd: string;
	private disableSsl: boolean;

	constructor(opts: {
		gitPath?: string;
		cwd: string;
		disableSsl?: boolean;
	}) {
		this.gitPath = opts.gitPath || 'git';
		this.defaultCwd = opts.cwd;
		this.disableSsl = opts.disableSsl ?? false;
	}

	/**
	 * Build a remote URL with the PAT token embedded for network operations.
	 * Input:  https://gitlab.example.com/group/repo.git
	 * Output: https://oauth2:<token>@gitlab.example.com/group/repo.git
	 */
	static buildAuthUrl(remoteUrl: string, token: string): string {
		try {
			const url = new URL(remoteUrl);
			url.username = 'oauth2';
			url.password = token;
			return url.toString();
		} catch {
			return remoteUrl;
		}
	}

	/**
	 * Strip any embedded credentials from a URL (for logging / display).
	 */
	static sanitizeUrl(url: string): string {
		try {
			const parsed = new URL(url);
			if (parsed.username || parsed.password) {
				parsed.username = '';
				parsed.password = '';
			}
			return parsed.toString();
		} catch {
			return url;
		}
	}

	async exec(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
		const cwd = opts?.cwd ?? this.defaultCwd;
		const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			GIT_TERMINAL_PROMPT: '0',
			...(this.disableSsl ? { GIT_SSL_NO_VERIFY: 'true' } : {}),
			...opts?.env,
		};

		// Disable core.quotepath so git emits paths as raw UTF-8 instead of
		// C-style quoted form (`"..."` with `\NNN` octal escapes). Without this,
		// paths with non-ASCII characters round-trip as literal quoted strings
		// and break `git add` / `git restore` pathspec matching.
		const finalArgs = ['-c', 'core.quotepath=false', ...args];

		return new Promise<GitExecResult>((resolve, reject) => {
			const child = execFile(
				this.gitPath,
				finalArgs,
				{
					cwd,
					env,
					timeout,
					maxBuffer: 50 * 1024 * 1024,
					windowsHide: true,
					encoding: 'utf8',
				},
				(error, stdout, stderr) => {
					const exitCode = error && 'code' in error ? (error as any).code as number : 0;

					if (error && typeof exitCode !== 'number') {
						reject(error);
						return;
					}

					const out = String(stdout ?? '');
					const err = String(stderr ?? '');

					if (exitCode !== 0) {
						reject(new GitCliError(args, exitCode, err, out));
						return;
					}

					resolve({ stdout: out, stderr: err, exitCode: 0 });
				},
			);

			if (opts?.stdin && child.stdin) {
				child.stdin.write(opts.stdin);
				child.stdin.end();
			}
		});
	}

	/**
	 * Run a git command, returning stdout trimmed. Throws GitCliError on
	 * non-zero exit. Convenience wrapper over exec().
	 */
	async run(args: string[], opts?: GitExecOptions): Promise<string> {
		const result = await this.exec(args, opts);
		return result.stdout.trimEnd();
	}

	/**
	 * Run a git command that may legitimately exit non-zero (e.g. merge-base
	 * --is-ancestor). Returns the full result without throwing.
	 */
	async runRaw(args: string[], opts?: GitExecOptions): Promise<GitExecResult> {
		const cwd = opts?.cwd ?? this.defaultCwd;
		const timeout = opts?.timeout ?? DEFAULT_TIMEOUT;

		const env: Record<string, string> = {
			...process.env as Record<string, string>,
			GIT_TERMINAL_PROMPT: '0',
			...(this.disableSsl ? { GIT_SSL_NO_VERIFY: 'true' } : {}),
			...opts?.env,
		};

		const finalArgs = ['-c', 'core.quotepath=false', ...args];

		return new Promise<GitExecResult>((resolve, reject) => {
			const child = execFile(
				this.gitPath,
				finalArgs,
				{
					cwd,
					env,
					timeout,
					maxBuffer: 50 * 1024 * 1024,
					windowsHide: true,
					encoding: 'utf8',
				},
				(error, stdout, stderr) => {
					const exitCode = error && 'code' in error ? (error as any).code as number : 0;

					if (error && typeof exitCode !== 'number') {
						reject(error);
						return;
					}

					resolve({
						stdout: String(stdout ?? ''),
						stderr: String(stderr ?? ''),
						exitCode: typeof exitCode === 'number' ? exitCode : 0,
					});
				},
			);

			if (opts?.stdin && child.stdin) {
				child.stdin.write(opts.stdin);
				child.stdin.end();
			}
		});
	}

	/**
	 * Detect Git CLI and return its version string, or null if not found.
	 */
	static async detect(gitPath?: string): Promise<{ path: string; version: string } | null> {
		const tryPath = gitPath || 'git';
		try {
			const result = await new Promise<string>((resolve, reject) => {
				execFile(
					tryPath,
					['--version'],
					{ timeout: 5_000, windowsHide: true, encoding: 'utf8' },
					(error, stdout) => {
						if (error) reject(error);
						else resolve(String(stdout ?? ''));
					},
				);
			});

			const match = result.match(/git version ([\d.]+)/);
			if (match) {
				return { path: tryPath, version: match[1] };
			}
			return { path: tryPath, version: result.trim() };
		} catch {
			return null;
		}
	}
}
