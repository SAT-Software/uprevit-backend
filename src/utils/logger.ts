/**
 * Structured logging utility for Lambda functions
 */

export interface LogContext {
	[key: string]: unknown;
}

/**
 * Logs an error with structured context for CloudWatch
 * @param {string} message - Human-readable error message
 * @param {unknown} error - The error object to log
 * @param {LogContext} context - Additional context (userId, workspaceId, etc.)
 */
export function logError(message: string, error: unknown, context?: LogContext): void {
	const logEntry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level: 'ERROR',
		message,
		...context,
	};

	// Parse error object
	if (error instanceof Error) {
		logEntry.error = {
			name: error.name,
			message: error.message,
			stack: error.stack,
		};
	} else {
		logEntry.error = String(error);
	}

	console.error(JSON.stringify(logEntry));
}

/**
 * Logs an info message with structured context
 * @param {string} message - Human-readable message
 * @param {LogContext} context - Additional context
 */
export function logInfo(message: string, context?: LogContext): void {
	const logEntry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level: 'INFO',
		message,
		...context,
	};

	console.log(JSON.stringify(logEntry));
}

/**
 * Logs a warning with structured context
 * @param {string} message - Human-readable warning message
 * @param {LogContext} context - Additional context
 */
export function logWarn(message: string, context?: LogContext): void {
	const logEntry: Record<string, unknown> = {
		timestamp: new Date().toISOString(),
		level: 'WARN',
		message,
		...context,
	};

	console.warn(JSON.stringify(logEntry));
}

