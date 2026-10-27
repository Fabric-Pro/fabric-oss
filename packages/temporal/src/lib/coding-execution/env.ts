import { z } from "zod";
import { RuntimeNotFoundError } from "./errors";
import { redactSensitiveData, validateBackgroundAgentsUrl } from "./security";

/**
 * Environment variable schema for coding execution
 * Validates at module load time to fail fast on misconfiguration
 */
export const CodingExecutionEnvSchema = z.object({
	// Background Agents Provider
	BACKGROUND_AGENTS_URL: z
		.string()
		.optional()
		.transform((val) => {
			if (!val) {
				return undefined;
			}
			// Validate URL format and security constraints
			validateBackgroundAgentsUrl(val);
			if (!process.env.BACKGROUND_AGENTS_INTERNAL_SECRET) {
				throw new Error(
					"BACKGROUND_AGENTS_INTERNAL_SECRET is required when BACKGROUND_AGENTS_URL is set",
				);
			}
			return val;
		}),
	BACKGROUND_AGENTS_INTERNAL_SECRET: z.string().min(32).optional(),
	FABRIC_AGENTS_DEFAULT_CONNECTION: z
		.string()
		.optional()
		.transform((val) =>
			val && val.trim().length > 0 ? val.trim() : undefined,
		),
	FABRIC_AGENTS_DEFAULT_MODEL: z
		.string()
		.optional()
		.transform((val) =>
			val && val.trim().length > 0 ? val.trim() : undefined,
		),

	// Port ranges for local providers
	KANBAN_RUNTIME_PORT_RANGE: z
		.string()
		.default("3484-65535")
		.transform((val) => {
			const [start, end] = val
				.split("-")
				.map((n) => Number.parseInt(n, 10));
			if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
				throw new Error(
					`Invalid KANBAN_RUNTIME_PORT_RANGE: ${val}. Expected format: START-END`,
				);
			}
			return { start, end };
		}),
	VIBE_RUNTIME_PORT_RANGE: z
		.string()
		.default("4284-65535")
		.transform((val) => {
			const [start, end] = val
				.split("-")
				.map((n) => Number.parseInt(n, 10));
			if (Number.isNaN(start) || Number.isNaN(end) || start >= end) {
				throw new Error(
					`Invalid VIBE_RUNTIME_PORT_RANGE: ${val}. Expected format: START-END`,
				);
			}
			return { start, end };
		}),

	// Timeouts (in milliseconds)
	KANBAN_RUNTIME_START_TIMEOUT_MS: z
		.string()
		.default("15000")
		.transform((val) => {
			const num = Number.parseInt(val, 10);
			if (Number.isNaN(num) || num < 1000) {
				throw new Error(
					`Invalid KANBAN_RUNTIME_START_TIMEOUT_MS: ${val}. Must be at least 1000ms`,
				);
			}
			return num;
		}),
	VIBE_RUNTIME_START_TIMEOUT_MS: z
		.string()
		.default("20000")
		.transform((val) => {
			const num = Number.parseInt(val, 10);
			if (Number.isNaN(num) || num < 1000) {
				throw new Error(
					`Invalid VIBE_RUNTIME_START_TIMEOUT_MS: ${val}. Must be at least 1000ms`,
				);
			}
			return num;
		}),

	// Rate limiting
	LOCAL_PROVIDER_RATE_LIMIT_PER_MINUTE: z
		.string()
		.default("10")
		.transform((val) => {
			const num = Number.parseInt(val, 10);
			if (Number.isNaN(num) || num < 1) {
				throw new Error(
					`Invalid LOCAL_PROVIDER_RATE_LIMIT_PER_MINUTE: ${val}. Must be at least 1`,
				);
			}
			return num;
		}),

	// Optional callback secret for external status callbacks
	FABRIC_CALLBACK_SECRET: z.string().min(16).optional(),

	// Debug mode
	CODING_EXECUTION_DEBUG: z
		.enum(["true", "false", "1", "0"])
		.default("false")
		.transform((val) => val === "true" || val === "1"),
});

/**
 * Parsed and validated environment variables
 * Throws at module load time if validation fails
 */
export const env = (() => {
	try {
		return CodingExecutionEnvSchema.parse(process.env);
	} catch (error) {
		if (error instanceof z.ZodError) {
			const issues = error.issues
				.map((i) => `  - ${i.path.join(".")}: ${i.message}`)
				.join("\n");
			throw new Error(
				`Coding execution environment validation failed:\n${issues}`,
			);
		}
		throw error;
	}
})();

/**
 * Gets the background agents URL or throws if not configured
 */
export function getBackgroundAgentsUrl(): string {
	const rawUrl =
		process.env.BACKGROUND_AGENTS_URL ?? env.BACKGROUND_AGENTS_URL;
	if (!rawUrl) {
		throw new RuntimeNotFoundError(
			"BACKGROUND_AGENTS",
			"BACKGROUND_AGENTS_URL environment variable",
		);
	}
	validateBackgroundAgentsUrl(rawUrl);
	return rawUrl;
}

/**
 * Gets the background agents secret or throws if not configured
 */
export function getBackgroundAgentsSecret(): string {
	const secret =
		process.env.BACKGROUND_AGENTS_INTERNAL_SECRET ??
		env.BACKGROUND_AGENTS_INTERNAL_SECRET;
	if (!secret) {
		throw new RuntimeNotFoundError(
			"BACKGROUND_AGENTS",
			"BACKGROUND_AGENTS_INTERNAL_SECRET environment variable",
		);
	}
	return secret;
}

/**
 * Gets the optional default Fabric Agents LLM connection slug (e.g. "claude-max", "codex", "cursor-cli", "antigravity", "droid")
 */
export function getFabricAgentsDefaultConnection(): string | undefined {
	const raw =
		process.env.FABRIC_AGENTS_DEFAULT_CONNECTION ??
		env.FABRIC_AGENTS_DEFAULT_CONNECTION;
	return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Gets the optional default Fabric Agents model identifier
 */
export function getFabricAgentsDefaultModel(): string | undefined {
	const raw =
		process.env.FABRIC_AGENTS_DEFAULT_MODEL ??
		env.FABRIC_AGENTS_DEFAULT_MODEL;
	return raw && raw.trim().length > 0 ? raw.trim() : undefined;
}

/**
 * Debug logging utility
 * Automatically redacts sensitive fields from logged data
 */
export function debugLog(
	message: string,
	data?: Record<string, unknown>,
): void {
	if (env.CODING_EXECUTION_DEBUG) {
		const sanitizedData = data ? redactSensitiveData(data) : undefined;
		// eslint-disable-next-line no-console
		console.log(
			`[coding-execution] ${message}`,
			sanitizedData ? JSON.stringify(sanitizedData) : "",
		);
	}
}
