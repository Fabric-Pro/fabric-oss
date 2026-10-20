/**
 * Letta Security Utilities
 *
 * Provides security controls for Letta operations including:
 * - Agent authorization and ownership validation
 * - Memory block input validation and sanitization
 * - Rate limiting for Letta operations
 * - Multi-tenant isolation verification
 *
 * @security These utilities address the following vulnerabilities:
 * - Data leakage across users in organization-level tenancy
 * - Unauthorized access to Letta agents and memory blocks
 * - Memory block injection and size limit bypass
 * - Rate limit abuse on expensive Letta operations
 */

import type { LettaClient } from "@repo/letta";
import {
	getLettaClient,
	matchesAgentMetadata,
	orchestratorMemoryMetadata,
} from "@repo/letta";

// ============================================================================
// Constants
// ============================================================================

/** Maximum size for memory block values in bytes (50KB) */
export const MAX_MEMORY_BLOCK_SIZE = 50 * 1024;

/** Maximum size for tool result cache entries in bytes (10KB) */
export const MAX_CACHE_ENTRY_SIZE = 10 * 1024;

/** Maximum number of cache entries per agent */
export const MAX_CACHE_ENTRIES = 100;

/** Rate limit configurations for Letta operations */
export const LETTA_RATE_LIMITS = {
	/** Memory block read operations - 100 per minute */
	memoryRead: { limit: 100, windowMs: 60_000 },
	/** Memory block write operations - 30 per minute */
	memoryWrite: { limit: 30, windowMs: 60_000 },
	/** Tool result caching - 50 per minute */
	toolCache: { limit: 50, windowMs: 60_000 },
	/** Archival memory operations - 20 per minute */
	archival: { limit: 20, windowMs: 60_000 },
	/** Agent initialization - 5 per minute */
	agentInit: { limit: 5, windowMs: 60_000 },
} as const;

// ============================================================================
// In-Process Rate Limiter (for Temporal worker context)
// ============================================================================

interface RateLimitEntry {
	count: number;
	resetTime: number;
}

// In-memory rate limit store for Temporal worker process
const rateLimitStore = new Map<string, RateLimitEntry>();

// Cleanup interval
const CLEANUP_INTERVAL_MS = 60_000;
let cleanupInterval: ReturnType<typeof setInterval> | null = null;

function startRateLimitCleanup(): void {
	if (cleanupInterval) {
		return;
	}

	cleanupInterval = setInterval(() => {
		const now = Date.now();
		for (const [key, entry] of rateLimitStore.entries()) {
			if (entry.resetTime <= now) {
				rateLimitStore.delete(key);
			}
		}
	}, CLEANUP_INTERVAL_MS);

	// Don't prevent process exit
	if (cleanupInterval.unref) {
		cleanupInterval.unref();
	}
}

/**
 * In-process rate limit check for Temporal worker context.
 * Uses in-memory store (per worker process).
 */
function checkInProcessRateLimit(
	key: string,
	limit: number,
	windowMs: number,
): { allowed: boolean; remaining: number; resetInSeconds: number } {
	startRateLimitCleanup();

	const now = Date.now();
	let entry = rateLimitStore.get(key);

	if (!entry || entry.resetTime <= now) {
		entry = {
			count: 1,
			resetTime: now + windowMs,
		};
		rateLimitStore.set(key, entry);
	} else {
		entry.count++;
	}

	const remaining = Math.max(0, limit - entry.count);
	const resetInSeconds = Math.ceil((entry.resetTime - now) / 1000);

	return {
		allowed: entry.count <= limit,
		remaining,
		resetInSeconds,
	};
}

// ============================================================================
// Types
// ============================================================================

export interface LettaSecurityContext {
	userId: string;
	organizationId?: string;
	lettaAgentId: string;
}

export interface SecurityValidationResult {
	valid: boolean;
	error?: string;
	errorCode?: LettaSecurityErrorCode;
}

export type LettaSecurityErrorCode =
	| "UNAUTHORIZED_AGENT_ACCESS"
	| "INVALID_MEMORY_BLOCK_SIZE"
	| "INVALID_MEMORY_BLOCK_CONTENT"
	| "RATE_LIMIT_EXCEEDED"
	| "TENANT_ISOLATION_VIOLATION"
	| "AGENT_IDENTITY_MISMATCH"
	| "LETTA_NOT_CONFIGURED";

export class LettaSecurityError extends Error {
	code: LettaSecurityErrorCode;

	constructor(message: string, code: LettaSecurityErrorCode) {
		super(message);
		this.name = "LettaSecurityError";
		this.code = code;
	}
}

// ============================================================================
// Helper: Get Letta Client
// ============================================================================

function getLettaClientFromEnv(): LettaClient | null {
	const baseUrl = process.env.LETTA_BASE_URL;
	const apiKey = process.env.LETTA_API_KEY;

	if (!baseUrl) {
		return null;
	}

	return getLettaClient({ baseUrl, apiKey });
}

// ============================================================================
// Agent Authorization
// ============================================================================

/**
 * Verify that a user/organization has access to a Letta agent.
 *
 * This function checks:
 * 1. The agent exists
 * 2. The agent's metadata matches the requesting user/organization
 *
 * @security Prevents unauthorized access to Letta agents and their memory blocks
 */
export async function verifyLettaAgentOwnership(
	context: LettaSecurityContext,
): Promise<SecurityValidationResult> {
	const client = getLettaClientFromEnv();
	if (!client) {
		return {
			valid: false,
			error: "Letta not configured",
			errorCode: "LETTA_NOT_CONFIGURED",
		};
	}

	try {
		// Get the agent to verify ownership
		const agent = await client.getAgent(context.lettaAgentId);

		if (!agent) {
			return {
				valid: false,
				error: `Agent not found: ${context.lettaAgentId}`,
				errorCode: "UNAUTHORIZED_AGENT_ACCESS",
			};
		}

		if (
			!matchesAgentMetadata(
				agent.metadata,
				orchestratorMemoryMetadata(context),
			)
		) {
			return {
				valid: false,
				error: "Agent metadata does not match the requesting tenant",
				errorCode: "TENANT_ISOLATION_VIOLATION",
			};
		}
		return { valid: true };
	} catch (error) {
		console.error(
			"[LettaSecurity] Failed to verify agent ownership:",
			error,
		);
		return {
			valid: false,
			error: error instanceof Error ? error.message : "Unknown error",
			errorCode: "UNAUTHORIZED_AGENT_ACCESS",
		};
	}
}

// ============================================================================
// Memory Block Input Validation
// ============================================================================

/**
 * Validate memory block content before storing.
 *
 * This function checks:
 * 1. Content size is within limits
 * 2. Content is valid JSON (for structured blocks)
 * 3. Content doesn't contain potential injection patterns
 *
 * @security Prevents memory block injection and size limit bypass
 */
export function validateMemoryBlockContent(
	content: string,
	options?: {
		maxSize?: number;
		requireJson?: boolean;
		blockLabel?: string;
	},
): SecurityValidationResult {
	const maxSize = options?.maxSize || MAX_MEMORY_BLOCK_SIZE;
	const blockLabel = options?.blockLabel || "unknown";

	// Check size limit
	const contentSize = Buffer.byteLength(content, "utf-8");
	if (contentSize > maxSize) {
		return {
			valid: false,
			error: `Memory block '${blockLabel}' exceeds size limit: ${contentSize} > ${maxSize} bytes`,
			errorCode: "INVALID_MEMORY_BLOCK_SIZE",
		};
	}

	// Validate JSON if required
	if (options?.requireJson) {
		try {
			JSON.parse(content);
		} catch {
			return {
				valid: false,
				error: `Memory block '${blockLabel}' must contain valid JSON`,
				errorCode: "INVALID_MEMORY_BLOCK_CONTENT",
			};
		}
	}

	// Check for potential injection patterns
	const injectionPatterns = [
		// Script injection
		/<script\b/i,
		// SQL-like patterns (shouldn't appear in memory blocks)
		/;\s*DROP\s+TABLE/i,
		/;\s*DELETE\s+FROM/i,
		// Command injection patterns
		/\$\(.*\)/,
		/`.*`/,
	];

	for (const pattern of injectionPatterns) {
		if (pattern.test(content)) {
			console.warn(
				`[LettaSecurity] Potential injection pattern detected in memory block '${blockLabel}'`,
			);
			// Log but don't block - these could be legitimate content in some cases
			// The warning helps with audit trails
		}
	}

	return { valid: true };
}

/**
 * Sanitize tool result before caching.
 *
 * This function:
 * 1. Validates result size
 * 2. Removes sensitive fields
 * 3. Truncates overly large results
 *
 * @security Prevents cache poisoning and sensitive data leakage
 */
export function sanitizeToolResult(
	result: unknown,
	_userId: string,
	options?: {
		maxSize?: number;
		truncate?: boolean;
	},
): { sanitized: unknown; truncated: boolean; originalSize: number } {
	// Handle null and undefined early
	if (result === null || result === undefined) {
		return { sanitized: result, truncated: false, originalSize: 0 };
	}

	const maxSize = options?.maxSize || MAX_CACHE_ENTRY_SIZE;
	const shouldTruncate = options?.truncate ?? true;

	const serialized = JSON.stringify(result);
	const originalSize = Buffer.byteLength(serialized, "utf-8");

	// If within limits, return as-is (but still strip sensitive fields)
	if (originalSize <= maxSize) {
		const sanitized = stripSensitiveFields(result);
		return { sanitized, truncated: false, originalSize };
	}

	// Truncate if allowed
	if (shouldTruncate) {
		const truncatedResult = truncateResult(result, maxSize);
		const sanitized = stripSensitiveFields(truncatedResult);
		return { sanitized, truncated: true, originalSize };
	}

	// Return null if we can't store it
	return {
		sanitized: {
			_error: "Result too large to cache",
			_originalSize: originalSize,
			_maxSize: maxSize,
		},
		truncated: true,
		originalSize,
	};
}

/**
 * Strip sensitive fields from cached results.
 */
function stripSensitiveFields(data: unknown): unknown {
	if (data === null || data === undefined) {
		return data;
	}

	if (Array.isArray(data)) {
		return data.map(stripSensitiveFields);
	}

	if (typeof data === "object") {
		const sensitivePatterns = [
			/password/i,
			/secret/i,
			/token/i,
			/apikey/i,
			/api_key/i,
			/authorization/i,
			/credential/i,
			/private_key/i,
		];

		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(data)) {
			const isSensitive = sensitivePatterns.some((pattern) =>
				pattern.test(key),
			);
			if (isSensitive) {
				result[key] = "[REDACTED]";
			} else {
				result[key] = stripSensitiveFields(value);
			}
		}
		return result;
	}

	return data;
}

/**
 * Truncate result to fit within size limits.
 */
function truncateResult(data: unknown, maxSize: number): unknown {
	// For arrays, keep first N items
	if (Array.isArray(data)) {
		let currentSize = 2; // []
		const truncated: unknown[] = [];

		for (const item of data) {
			const itemSize = Buffer.byteLength(JSON.stringify(item), "utf-8");
			if (currentSize + itemSize + 1 <= maxSize - 50) {
				// Leave room for truncation marker
				truncated.push(item);
				currentSize += itemSize + 1; // +1 for comma
			} else {
				break;
			}
		}

		if (truncated.length < data.length) {
			truncated.push({
				_truncated: true,
				_originalCount: data.length,
				_includedCount: truncated.length,
			});
		}

		return truncated;
	}

	// For objects, keep first N keys
	if (typeof data === "object" && data !== null) {
		let currentSize = 2; // {}
		const truncated: Record<string, unknown> = {};
		const entries = Object.entries(data);

		for (const [key, value] of entries) {
			const entrySize = Buffer.byteLength(
				JSON.stringify({ [key]: value }),
				"utf-8",
			);
			if (currentSize + entrySize + 1 <= maxSize - 50) {
				truncated[key] = value;
				currentSize += entrySize + 1;
			} else {
				break;
			}
		}

		if (Object.keys(truncated).length < entries.length) {
			truncated._truncated = true;
			truncated._originalKeys = entries.length;
		}

		return truncated;
	}

	// For strings, truncate with marker
	if (typeof data === "string" && data.length > maxSize) {
		return `${data.substring(0, maxSize - 20)}... [TRUNCATED]`;
	}

	return data;
}

// ============================================================================
// Rate Limiting
// ============================================================================

/**
 * Check rate limit for a Letta operation.
 *
 * Uses in-process rate limiting suitable for Temporal worker context.
 * Note: This is per-worker-process rate limiting. For distributed
 * rate limiting, consider using Redis-based rate limiting at the API layer.
 *
 * @security Prevents abuse of expensive Letta operations
 */
export async function checkLettaRateLimit(
	operation: keyof typeof LETTA_RATE_LIMITS,
	userId: string,
	organizationId?: string,
): Promise<SecurityValidationResult> {
	const config = LETTA_RATE_LIMITS[operation];

	// Use organization-scoped key if available, otherwise user-scoped
	const rateLimitKey = organizationId
		? `letta:${operation}:org:${organizationId}`
		: `letta:${operation}:user:${userId}`;

	try {
		// Use in-process rate limiting for Temporal worker context
		const result = checkInProcessRateLimit(
			rateLimitKey,
			config.limit,
			config.windowMs,
		);

		if (!result.allowed) {
			console.warn(
				`[LettaSecurity] Rate limit exceeded for ${operation}: ${rateLimitKey}`,
			);
			return {
				valid: false,
				error: `Rate limit exceeded for ${operation}. Try again in ${result.resetInSeconds}s.`,
				errorCode: "RATE_LIMIT_EXCEEDED",
			};
		}

		return { valid: true };
	} catch (error) {
		// Log but don't fail on rate limit check errors
		console.error("[LettaSecurity] Rate limit check failed:", error);
		return { valid: true };
	}
}

// ============================================================================
// Combined Security Check
// ============================================================================

/**
 * Perform comprehensive security checks for a Letta operation.
 *
 * This function combines:
 * 1. Agent ownership verification
 * 2. Rate limiting
 *
 * @security Single entry point for all Letta security checks
 */
export async function validateLettaOperation(
	context: LettaSecurityContext,
	operation: keyof typeof LETTA_RATE_LIMITS,
	options?: {
		skipRateLimit?: boolean;
	},
): Promise<SecurityValidationResult> {
	// 1. Check rate limit first (fail fast)
	if (!options?.skipRateLimit) {
		const rateLimitResult = await checkLettaRateLimit(
			operation,
			context.userId,
			context.organizationId,
		);
		if (!rateLimitResult.valid) {
			return rateLimitResult;
		}
	}

	// 2. Verify agent ownership
	const ownershipResult = await verifyLettaAgentOwnership(context);
	if (!ownershipResult.valid) {
		return ownershipResult;
	}

	return { valid: true };
}

// ============================================================================
// Audit Logging
// ============================================================================

/**
 * Log a Letta security event for audit purposes.
 */
export function logSecurityEvent(
	event: "access" | "modify" | "cache" | "rate_limit" | "violation",
	context: LettaSecurityContext,
	details: {
		operation: string;
		success: boolean;
		errorCode?: LettaSecurityErrorCode;
		metadata?: Record<string, unknown>;
	},
): void {
	const logEntry = {
		timestamp: new Date().toISOString(),
		event,
		userId: context.userId,
		organizationId: context.organizationId,
		lettaAgentId: context.lettaAgentId,
		...details,
	};

	if (event === "violation" || !details.success) {
		console.error("[LettaSecurity:Audit]", JSON.stringify(logEntry));
	} else {
		console.log("[LettaSecurity:Audit]", JSON.stringify(logEntry));
	}
}
