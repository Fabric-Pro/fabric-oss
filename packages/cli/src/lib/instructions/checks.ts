/**
 * The shared vocabulary of `fabric instructions doctor` and the MCP
 * `fabric_instruction_checks` tool, plus the `fabric.environment.json`
 * declaration format both of them read.
 *
 * This file is deliberately dependency-free and has a byte-for-byte twin at
 * `apps/web/modules/saas/mcp/lib/gateway/instruction-checks.ts`. The CLI is a
 * published npm package and cannot depend on the private `@repo/*` workspace
 * packages, and the web app does not depend on the SDK, so the two surfaces
 * carry their own copy — the same arrangement as `paths.ts` and
 * `manifest.ts`. `packages/cli/__tests__/checks-agree-with-gateway.test.ts`
 * runs one fixture corpus through both copies and fails on any divergence.
 *
 * Everything named in a declaration is published content: a variable name, a
 * tool name, a version string, a description. Nothing here executes a tool,
 * reads a variable's value, or echoes untrusted text unbounded. The parser's
 * failure reasons refer to positions (`variables[3]`), never to the offending
 * value, so a malformed file cannot smuggle a secret into a diagnostic.
 */

// ---------------------------------------------------------------------------
// Declaration format
// ---------------------------------------------------------------------------

export const INSTRUCTION_ENVIRONMENT_FILE = "fabric.environment.json";
export const INSTRUCTION_ENVIRONMENT_VERSION = 1;
export const INSTRUCTION_ENVIRONMENT_MAX_BYTES = 65_536;
export const INSTRUCTION_ENVIRONMENT_MAX_VARIABLES = 200;
export const INSTRUCTION_ENVIRONMENT_MAX_TOOLS = 100;

/** POSIX identifier, capped so a name can never double as a payload. */
export const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;
/** A bare executable name: no separators, no whitespace, no leading dot. */
export const TOOL_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/;

const MAX_DESCRIPTION_CHARS = 200;
const MAX_VERSION_CHARS = 64;

export interface DeclaredVariable {
	name: string;
	required: boolean;
	description?: string;
}

export interface DeclaredTool {
	name: string;
	/** Free-form, informational only — never verified by execution. */
	version?: string;
	description?: string;
}

export interface InstructionEnvironment {
	version: typeof INSTRUCTION_ENVIRONMENT_VERSION;
	variables: DeclaredVariable[];
	tools: DeclaredTool[];
}

export type InstructionEnvironmentParse =
	| { ok: true; declaration: InstructionEnvironment }
	| { ok: false; reason: string };

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Strip control characters (including ANSI escape introducers) and cap the
 * length, so published text can be printed to a terminal or embedded in JSON
 * without carrying terminal controls or unbounded content.
 */
export function sanitizeDisplayText(value: string, maxChars: number): string {
	// Work in code points so truncation can never split a surrogate pair.
	const chars: string[] = [];
	let truncated = false;
	for (const ch of value) {
		if (chars.length >= maxChars) {
			truncated = true;
			break;
		}
		const code = ch.codePointAt(0) ?? 0;
		const isControl =
			code < 0x20 ||
			(code >= 0x7f && code <= 0x9f) ||
			code === 0x2028 ||
			code === 0x2029;
		chars.push(isControl ? " " : ch);
	}
	if (!truncated) {
		return chars.join("");
	}
	return `${chars.slice(0, Math.max(0, maxChars - 1)).join("")}…`;
}

function optionalText(
	value: unknown,
	maxChars: number,
	where: string,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
	if (value === undefined) {
		return { ok: true, value: undefined };
	}
	if (typeof value !== "string") {
		return { ok: false, reason: `${where} must be a string` };
	}
	if (value.length > maxChars) {
		return {
			ok: false,
			reason: `${where} is longer than ${maxChars} characters`,
		};
	}
	return { ok: true, value: sanitizeDisplayText(value, maxChars) };
}

/**
 * Parse the text of a `fabric.environment.json`. The caller is responsible
 * for reading at most `INSTRUCTION_ENVIRONMENT_MAX_BYTES` bytes with a
 * bounded, symlink-refusing read; the size check here is defence in depth.
 */
export function parseInstructionEnvironment(
	text: string,
): InstructionEnvironmentParse {
	if (byteLength(text) > INSTRUCTION_ENVIRONMENT_MAX_BYTES) {
		return {
			ok: false,
			reason: `file is larger than ${INSTRUCTION_ENVIRONMENT_MAX_BYTES} bytes`,
		};
	}
	let raw: unknown;
	try {
		raw = JSON.parse(text);
	} catch {
		// Never surface the parser's message: it quotes the input.
		return { ok: false, reason: "file is not valid JSON" };
	}
	if (!isRecord(raw)) {
		return { ok: false, reason: "top level must be an object" };
	}
	if (raw.version !== INSTRUCTION_ENVIRONMENT_VERSION) {
		return {
			ok: false,
			reason: `version must be the number ${INSTRUCTION_ENVIRONMENT_VERSION}`,
		};
	}

	const variables: DeclaredVariable[] = [];
	if (raw.variables !== undefined) {
		if (!Array.isArray(raw.variables)) {
			return { ok: false, reason: "variables must be an array" };
		}
		if (raw.variables.length > INSTRUCTION_ENVIRONMENT_MAX_VARIABLES) {
			return {
				ok: false,
				reason: `variables has more than ${INSTRUCTION_ENVIRONMENT_MAX_VARIABLES} entries`,
			};
		}
		const seen = new Set<string>();
		for (const [index, entry] of raw.variables.entries()) {
			const where = `variables[${index}]`;
			if (!isRecord(entry)) {
				return { ok: false, reason: `${where} must be an object` };
			}
			if (
				typeof entry.name !== "string" ||
				!ENVIRONMENT_VARIABLE_NAME.test(entry.name)
			) {
				return {
					ok: false,
					reason: `${where}.name must be an environment variable name (letters, digits, underscore; at most 128 characters)`,
				};
			}
			if (seen.has(entry.name)) {
				return {
					ok: false,
					reason: `${where}.name repeats an earlier entry`,
				};
			}
			seen.add(entry.name);
			if (
				entry.required !== undefined &&
				typeof entry.required !== "boolean"
			) {
				return {
					ok: false,
					reason: `${where}.required must be a boolean`,
				};
			}
			const description = optionalText(
				entry.description,
				MAX_DESCRIPTION_CHARS,
				`${where}.description`,
			);
			if (!description.ok) {
				return description;
			}
			variables.push({
				name: entry.name,
				required: entry.required ?? true,
				...(description.value !== undefined
					? { description: description.value }
					: {}),
			});
		}
	}

	const tools: DeclaredTool[] = [];
	if (raw.tools !== undefined) {
		if (!Array.isArray(raw.tools)) {
			return { ok: false, reason: "tools must be an array" };
		}
		if (raw.tools.length > INSTRUCTION_ENVIRONMENT_MAX_TOOLS) {
			return {
				ok: false,
				reason: `tools has more than ${INSTRUCTION_ENVIRONMENT_MAX_TOOLS} entries`,
			};
		}
		const seen = new Set<string>();
		for (const [index, entry] of raw.tools.entries()) {
			const where = `tools[${index}]`;
			if (!isRecord(entry)) {
				return { ok: false, reason: `${where} must be an object` };
			}
			if (typeof entry.name !== "string" || !TOOL_NAME.test(entry.name)) {
				return {
					ok: false,
					reason: `${where}.name must be a bare executable name (no path separators or whitespace; at most 64 characters)`,
				};
			}
			if (seen.has(entry.name)) {
				return {
					ok: false,
					reason: `${where}.name repeats an earlier entry`,
				};
			}
			seen.add(entry.name);
			const version = optionalText(
				entry.version,
				MAX_VERSION_CHARS,
				`${where}.version`,
			);
			if (!version.ok) {
				return version;
			}
			const description = optionalText(
				entry.description,
				MAX_DESCRIPTION_CHARS,
				`${where}.description`,
			);
			if (!description.ok) {
				return description;
			}
			tools.push({
				name: entry.name,
				...(version.value !== undefined
					? { version: version.value }
					: {}),
				...(description.value !== undefined
					? { description: description.value }
					: {}),
			});
		}
	}

	return {
		ok: true,
		declaration: {
			version: INSTRUCTION_ENVIRONMENT_VERSION,
			variables,
			tools,
		},
	};
}

function byteLength(text: string): number {
	if (typeof TextEncoder !== "undefined") {
		return new TextEncoder().encode(text).length;
	}
	return text.length;
}

// ---------------------------------------------------------------------------
// Check vocabulary
// ---------------------------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "warn" | "skip";

export const CHECK_IDS = [
	"auth",
	"access",
	"published",
	"lock",
	"drift",
	"hook",
	"environment",
	"tools",
	"mcp-servers",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_TITLES: Record<CheckId, string> = {
	auth: "API key",
	access: "Project access",
	published: "Published instructions",
	lock: "Lock",
	drift: "Local files",
	hook: "Hook configuration",
	environment: "Environment variables",
	tools: "Tools",
	"mcp-servers": "MCP servers",
};

/**
 * Where a check's verdict comes from. `server` means the surface verified it
 * against authoritative state; `machine` means the CLI observed it on the
 * developer's machine; `caller-reported` means the MCP caller asserted it and
 * the server only compared what it was told.
 */
export type CheckEvidence = "server" | "machine" | "caller-reported";

export interface CheckItem {
	name: string;
	status: CheckStatus;
	detail?: string;
}

export interface CheckFix {
	/** A copy-pasteable shell line, present only when one exists. */
	command?: string;
	description: string;
}

export interface InstructionCheck {
	id: CheckId;
	title: string;
	status: CheckStatus;
	evidence: CheckEvidence;
	/** One line. Never a secret, a variable value, or unbounded published text. */
	detail: string;
	items?: CheckItem[];
	fix?: CheckFix;
}

export interface InstructionChecksReport {
	projectId: string;
	surface: "cli" | "mcp";
	checks: InstructionCheck[];
	summary: Record<CheckStatus, number>;
	/** No `fail` among the checks that were evaluated. Not a readiness attestation. */
	ok: boolean;
}

export function summarizeChecks(
	checks: readonly InstructionCheck[],
): Record<CheckStatus, number> {
	const summary: Record<CheckStatus, number> = {
		pass: 0,
		fail: 0,
		warn: 0,
		skip: 0,
	};
	for (const check of checks) {
		summary[check.status] += 1;
	}
	return summary;
}

export function buildChecksReport(
	projectId: string,
	surface: InstructionChecksReport["surface"],
	checks: readonly InstructionCheck[],
): InstructionChecksReport {
	const ordered = [...checks].sort(
		(a, b) => CHECK_IDS.indexOf(a.id) - CHECK_IDS.indexOf(b.id),
	);
	const summary = summarizeChecks(ordered);
	return {
		projectId,
		surface,
		checks: ordered,
		summary,
		ok: summary.fail === 0,
	};
}

// ---------------------------------------------------------------------------
// Evaluation shared by both surfaces
// ---------------------------------------------------------------------------

export interface VariableEvaluation {
	status: CheckStatus;
	items: CheckItem[];
	missingRequired: string[];
	missingOptional: string[];
}

/**
 * Compare declared variable NAMES against the set of names present. Values
 * are never involved. `ignoreCase` is for Windows, where the environment is
 * case-insensitive; the caller normalises nothing — this does.
 */
export function evaluateDeclaredVariables(
	declaration: InstructionEnvironment,
	presentNames: Iterable<string>,
	options: { ignoreCase?: boolean } = {},
): VariableEvaluation {
	const fold = (name: string) =>
		options.ignoreCase ? name.toUpperCase() : name;
	const present = new Set<string>();
	for (const name of presentNames) {
		present.add(fold(name));
	}
	const items: CheckItem[] = [];
	const missingRequired: string[] = [];
	const missingOptional: string[] = [];
	for (const variable of declaration.variables) {
		if (present.has(fold(variable.name))) {
			items.push({
				name: variable.name,
				status: "pass",
				detail: "present",
			});
		} else if (variable.required) {
			items.push({
				name: variable.name,
				status: "fail",
				detail: "missing (required)",
			});
			missingRequired.push(variable.name);
		} else {
			items.push({
				name: variable.name,
				status: "warn",
				detail: "missing (optional)",
			});
			missingOptional.push(variable.name);
		}
	}
	const status: CheckStatus =
		declaration.variables.length === 0
			? "skip"
			: missingRequired.length > 0
				? "fail"
				: missingOptional.length > 0
					? "warn"
					: "pass";
	return { status, items, missingRequired, missingOptional };
}
