/**
 * Debug logging utility for GitLab plugin
 */

export class DebugLogger {
	private static enabled = true;
	private static logHistory: string[] = [];
	private static maxHistorySize = 1000;

	/**
	 * Enable or disable debug logging
	 */
	static setEnabled(enabled: boolean): void {
		this.enabled = enabled;
	}

	/**
	 * Log a debug message
	 */
	static log(category: string, message: string, data?: any): void {
		const timestamp = new Date().toISOString();
		const logMessage = `[${timestamp}] [${category}] ${message}`;
		
		if (this.enabled) {
			console.log(logMessage, data || '');
		}

		// Store in history
		this.logHistory.push(logMessage + (data ? ` | ${JSON.stringify(data)}` : ''));
		
		// Trim history if too large
		if (this.logHistory.length > this.maxHistorySize) {
			this.logHistory = this.logHistory.slice(-this.maxHistorySize);
		}
	}

	/**
	 * Log an error
	 */
	static error(category: string, message: string, error?: any): void {
		const timestamp = new Date().toISOString();
		const errorDetails = error ? {
			message: error.message,
			stack: error.stack,
			name: error.name,
			...error
		} : undefined;

		const logMessage = `[${timestamp}] [${category}] ERROR: ${message}`;
		
		console.error(logMessage, errorDetails || '');

		// Store in history
		this.logHistory.push(logMessage + (errorDetails ? ` | ${JSON.stringify(errorDetails)}` : ''));
		
		// Trim history if too large
		if (this.logHistory.length > this.maxHistorySize) {
			this.logHistory = this.logHistory.slice(-this.maxHistorySize);
		}
	}

	/**
	 * Log a warning
	 */
	static warn(category: string, message: string, data?: any): void {
		const timestamp = new Date().toISOString();
		const logMessage = `[${timestamp}] [${category}] WARNING: ${message}`;
		
		console.warn(logMessage, data || '');

		// Store in history
		this.logHistory.push(logMessage + (data ? ` | ${JSON.stringify(data)}` : ''));
		
		// Trim history if too large
		if (this.logHistory.length > this.maxHistorySize) {
			this.logHistory = this.logHistory.slice(-this.maxHistorySize);
		}
	}

	/**
	 * Get recent log history
	 */
	static getHistory(count?: number): string[] {
		if (count) {
			return this.logHistory.slice(-count);
		}
		return [...this.logHistory];
	}

	/**
	 * Clear log history
	 */
	static clearHistory(): void {
		this.logHistory = [];
	}

	/**
	 * Export logs to a string
	 */
	static exportLogs(): string {
		return this.logHistory.join('\n');
	}

	/**
	 * Download logs as a file
	 */
	static downloadLogs(): void {
		const logs = this.exportLogs();
		const blob = new Blob([logs], { type: 'text/plain' });
		const url = URL.createObjectURL(blob);
		const a = document.createElement('a');
		a.href = url;
		a.download = `gitlab-plugin-logs-${new Date().toISOString()}.txt`;
		a.click();
		URL.revokeObjectURL(url);
	}
}
