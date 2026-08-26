import path from "node:path";
import { SessionValidationError } from "./errors";

/**
 * Security utilities for coding execution providers
 */

// Valid git branch name characters (simplified subset)
// Based on git-check-ref-format: alphanumeric, hyphen, underscore, dot, forward slash
const VALID_BRANCH_CHARS = /^[a-zA-Z0-9_\-./]+$/;

// Reserved branch names that could cause issues
const RESERVED_BRANCH_NAMES = new Set([
	"HEAD",
	"FETCH_HEAD",
	"ORIG_HEAD",
	"MERGE_HEAD",
	"CHERRY_PICK_HEAD",
	"REVERT_HEAD",
	"-",
]);

/**
 * Sanitizes a git branch name to prevent command injection
 * @param branch - The branch name to sanitize
 * @param provider - Provider name for error context
 * @returns Sanitized branch name
 * @throws {SessionValidationError} If branch name is invalid
 */
export function sanitizeBranchName(
	branch: string,
	provider: "KANBAN_LOCAL" | "BACKGROUND_AGENTS",
): string {
	const trimmed = branch.trim();

	// Check for empty string
	if (!trimmed) {
		throw new SessionValidationError(
			provider,
			"Branch name cannot be empty",
		);
	}

	// Check length (git has a 255 byte limit for ref names)
	if (trimmed.length > 255) {
		throw new SessionValidationError(
			provider,
			`Branch name too long: ${trimmed.length} characters (max 255)`,
		);
	}

	// Check for reserved names
	if (RESERVED_BRANCH_NAMES.has(trimmed)) {
		throw new SessionValidationError(
			provider,
			`Branch name '${trimmed}' is reserved`,
		);
	}

	// Check for shell metacharacters and other dangerous characters
	// This is a whitelist approach - only allow known safe characters
	if (!VALID_BRANCH_CHARS.test(trimmed)) {
		const invalidChars = trimmed
			.split("")
			.filter((c) => !VALID_BRANCH_CHARS.test(c))
			.join("");
		throw new SessionValidationError(
			provider,
			`Branch name contains invalid characters: '${invalidChars}'. Only alphanumeric, hyphen, underscore, dot, and forward slash are allowed.`,
		);
	}

	// Check for double dots (..) which could be used for directory traversal in some contexts
	if (trimmed.includes("..")) {
		throw new SessionValidationError(
			provider,
			"Branch name cannot contain double dots (..)",
		);
	}

	// Check for leading/trailing special characters
	if (
		trimmed.startsWith("/") ||
		trimmed.endsWith("/") ||
		trimmed.startsWith(".") ||
		trimmed.endsWith(".")
	) {
		throw new SessionValidationError(
			provider,
			"Branch name cannot start or end with '/' or '.'",
		);
	}

	// Check for consecutive slashes
	if (trimmed.includes("//")) {
		throw new SessionValidationError(
			provider,
			"Branch name cannot contain consecutive slashes",
		);
	}

	return trimmed;
}

// Characters allowed in path components (very restrictive)
const _VALID_PATH_CHARS = /^[a-zA-Z0-9_\-./\\:@]+$/;

/**
 * Validates and resolves a working directory path
 * Prevents path traversal attacks by ensuring the resolved path
 * is within an allowed base directory
 *
 * @param inputPath - The input path to validate
 * @param provider - Provider name for error context
 * @param allowedBaseDir - The base directory that must contain the path (defaults to PROJECTS_ROOT or cwd)
 * @returns Resolved absolute path
 * @throws {SessionValidationError} If path is invalid or outside allowed base
 */
export function validateWorkingDirectory(
	inputPath: string,
	provider: "KANBAN_LOCAL" | "BACKGROUND_AGENTS",
	allowedBaseDir?: string,
): string {
	const trimmed = inputPath.trim();

	if (!trimmed) {
		throw new SessionValidationError(
			provider,
			"Working directory cannot be empty",
		);
	}

	// Resolve to absolute path.
	//
	// turbopackIgnore: these dynamic path.resolve() calls are pure string
	// validation — nothing is read from the resolved paths here. Without the
	// hint, Next's file tracer can't statically scope them and traces the
	// ENTIRE monorepo into any serverless function that imports this module
	// (apps/web's /api/internal/weave-coding-run route), bloating the
	// function bundle and slowing every Vercel build's trace/packaging phase.
	const resolved = path.resolve(/*turbopackIgnore: true*/ trimmed);

	// Determine allowed base directory
	const baseDir = allowedBaseDir
		? path.resolve(/*turbopackIgnore: true*/ allowedBaseDir)
		: path.resolve(
				/*turbopackIgnore: true*/ process.env.PROJECTS_ROOT ||
					process.cwd(),
			);

	// Check for path traversal - resolved path must start with baseDir
	// Use path.sep to handle Windows vs Unix path separators
	const normalizedResolved = path.normalize(resolved);
	const normalizedBase = path.normalize(baseDir);

	// Ensure the path is within the allowed base (with trailing separator check)
	const isWithinBase =
		normalizedResolved === normalizedBase ||
		normalizedResolved.startsWith(normalizedBase + path.sep);

	if (!isWithinBase) {
		throw new SessionValidationError(
			provider,
			`Working directory '${trimmed}' is outside the allowed base directory`,
		);
	}

	// Additional check: path should not contain null bytes
	if (trimmed.includes("\0")) {
		throw new SessionValidationError(
			provider,
			"Working directory cannot contain null bytes",
		);
	}

	// Check for suspicious patterns
	const suspiciousPatterns = [
		{ pattern: /\.{3,}/, desc: "too many consecutive dots" },
		{ pattern: /[<>|&;$`]/, desc: "shell metacharacters" },
	];

	for (const { pattern, desc } of suspiciousPatterns) {
		if (pattern.test(trimmed)) {
			throw new SessionValidationError(
				provider,
				`Working directory contains ${desc}`,
			);
		}
	}

	return resolved;
}

// Fields that should be redacted from logs
const SENSITIVE_FIELD_PATTERNS = [
	/secret/i,
	/token/i,
	/password/i,
	/api[_-]?key/i,
	/auth/i,
	/credential/i,
	/private[_-]?key/i,
	/certificate/i,
	/session/i,
	/cookie/i,
];

/**
 * Redacts sensitive fields from an object for safe logging
 * @param data - Object to sanitize
 * @returns Sanitized copy of the object
 */
export function redactSensitiveData(
	data: Record<string, unknown>,
): Record<string, unknown> {
	const sanitized: Record<string, unknown> = {};

	for (const [key, value] of Object.entries(data)) {
		const isSensitive = SENSITIVE_FIELD_PATTERNS.some((pattern) =>
			pattern.test(key),
		);

		if (isSensitive) {
			sanitized[key] =
				typeof value === "string"
					? `[REDACTED:${value.length}chars]`
					: "[REDACTED]";
		} else if (
			value &&
			typeof value === "object" &&
			!Array.isArray(value)
		) {
			// Recursively sanitize nested objects (but not arrays)
			sanitized[key] = redactSensitiveData(
				value as Record<string, unknown>,
			);
		} else {
			sanitized[key] = value;
		}
	}

	return sanitized;
}

/**
 * Sanitizes an error message for external display
 * Removes potentially sensitive information like paths, IPs, etc.
 *
 * @param error - Error to sanitize
 * @param isProduction - Whether to apply full sanitization
 * @returns Sanitized error message
 */
export function sanitizeErrorMessage(
	error: Error,
	isProduction = process.env.NODE_ENV === "production",
): string {
	if (!isProduction) {
		// In development, return full message but redact obvious secrets
		return error.message.replace(
			/(secret|token|password|key)["']?\s*[:=]\s*["']?[^\s&]+/gi,
			"$1: [REDACTED]",
		);
	}

	// In production, return generic messages
	const genericMessages: Record<string, string> = {
		ENOENT: "Resource not found",
		EACCES: "Permission denied",
		ECONNREFUSED: "Connection refused",
		ETIMEDOUT: "Connection timed out",
		ENOTFOUND: "Host not found",
	};

	// Check for specific error codes
	const code = (error as { code?: string }).code;
	if (code && genericMessages[code]) {
		return genericMessages[code];
	}

	// Return a generic message based on error type
	if (error.name === "SessionValidationError") {
		return "Invalid request parameters";
	}
	if (error.name === "AuthError") {
		return "Authentication failed";
	}
	if (error.name === "NetworkError") {
		return "Network communication failed";
	}

	return "An error occurred while processing your request";
}

/**
 * Validates a URL for the background agents service
 * Prevents SSRF by restricting allowed URL patterns
 *
 * @param url - URL to validate
 * @throws {SessionValidationError} If URL is invalid
 */
export function validateBackgroundAgentsUrl(url: string): void {
	// Must use HTTPS in production
	const isProduction = process.env.NODE_ENV === "production";

	try {
		const parsed = new URL(url);

		// Protocol check
		if (isProduction && parsed.protocol !== "https:") {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"BACKGROUND_AGENTS_URL must use HTTPS in production",
			);
		}
		if (!isProduction && !["http:", "https:"].includes(parsed.protocol)) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"BACKGROUND_AGENTS_URL must use HTTP or HTTPS",
			);
		}

		// No credentials in URL
		if (parsed.username || parsed.password) {
			throw new SessionValidationError(
				"BACKGROUND_AGENTS",
				"BACKGROUND_AGENTS_URL must not contain credentials",
			);
		}

		// No private IP ranges in production
		if (isProduction) {
			const hostname = parsed.hostname;

			// Check for localhost
			if (
				hostname === "localhost" ||
				hostname === "127.0.0.1" ||
				hostname === "::1"
			) {
				throw new SessionValidationError(
					"BACKGROUND_AGENTS",
					"BACKGROUND_AGENTS_URL cannot point to localhost in production",
				);
			}

			// Check for private IP ranges
			const privateIpRanges = [
				/^10\./, // 10.0.0.0/8
				/^172\.(1[6-9]|2[0-9]|3[0-1])\./, // 172.16.0.0/12
				/^192\.168\./, // 192.168.0.0/16
				/^169\.254\./, // Link-local
			];

			for (const range of privateIpRanges) {
				if (range.test(hostname)) {
					throw new SessionValidationError(
						"BACKGROUND_AGENTS",
						"BACKGROUND_AGENTS_URL cannot point to private IP addresses in production",
					);
				}
			}
		}

		// Check for suspicious patterns
		const suspiciousPatterns = [
			{ pattern: /@/, desc: "URL contains @ symbol" },
			{ pattern: /\s/, desc: "URL contains whitespace" },
			// biome-ignore lint/suspicious/noControlCharactersInRegex: intentionally detecting null byte injection in URLs
			{ pattern: /\u0000/, desc: "URL contains null bytes" },
		];

		for (const { pattern, desc } of suspiciousPatterns) {
			if (pattern.test(url)) {
				throw new SessionValidationError(
					"BACKGROUND_AGENTS",
					`BACKGROUND_AGENTS_URL ${desc}`,
				);
			}
		}
	} catch (error) {
		if (error instanceof SessionValidationError) {
			throw error;
		}
		throw new SessionValidationError(
			"BACKGROUND_AGENTS",
			`Invalid BACKGROUND_AGENTS_URL: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}
