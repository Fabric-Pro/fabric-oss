/**
 * Timeout Configuration
 *
 * Activity timeouts and heartbeat intervals for the orchestrator.
 */

/**
 * Activity timeouts in milliseconds.
 */
export const ACTIVITY_TIMEOUTS = {
	/** Default activity timeout */
	DEFAULT: 60_000, // 1 minute
	/** Extended timeout for complex operations */
	EXTENDED: 120_000, // 2 minutes
	/** Short timeout for simple operations */
	SHORT: 30_000, // 30 seconds
	/** Tool execution timeout */
	TOOL_EXECUTION: 60_000, // 1 minute
	/** Agent delegation timeout */
	AGENT_DELEGATION: 120_000, // 2 minutes
	/** LLM generation timeout */
	LLM_GENERATION: 90_000, // 1.5 minutes
	/** MCP client connection timeout */
	MCP_CONNECTION: 30_000, // 30 seconds
	/** Approval wait timeout (max time to wait for user approval) */
	APPROVAL_WAIT: 24 * 60 * 60_000, // 24 hours
} as const;

/**
 * Heartbeat intervals in milliseconds.
 */
export const HEARTBEAT_INTERVALS = {
	/** Default heartbeat interval for long-running activities */
	DEFAULT: 10_000, // 10 seconds
	/** Frequent heartbeat for critical operations */
	FREQUENT: 5_000, // 5 seconds
	/** Infrequent heartbeat for stable operations */
	INFREQUENT: 30_000, // 30 seconds
} as const;
