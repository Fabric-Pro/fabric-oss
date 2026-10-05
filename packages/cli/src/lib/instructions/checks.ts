/**
 * The shared vocabulary of `fabric instructions doctor` and the MCP
 * `fabric_instruction_checks` tool, plus the `fabric.environment.json`
 * declaration format both of them read and the checkout verdict the MCP tool
 * computes from facts its caller reports.
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
	"checkout",
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
	checkout: "Checkout",
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

/**
 * Per-snapshot provenance for a published Coding Instructions snapshot
 * (Fizzy #2709) — distinct from the project setting `sourceOfTruth`, which
 * stays as it is. `current` is true only when this snapshot's repository and
 * branch still match the project's CURRENT sync configuration. Structurally
 * the same shape `@repo/database`'s `resolveInstructionSnapshotSource`
 * returns and the SDK's `PublishedInstructionSnapshot.source` carries;
 * repeated here rather than imported because this file has neither
 * dependency.
 */
export type PublishedInstructionSource =
	| { kind: "UPLOAD" }
	| {
			kind: "REPOSITORY";
			ref: string;
			commitSha: string;
			current: boolean;
	  };

/**
 * The project's CURRENT repository-sync configuration (Fizzy #2709),
 * independent of any one snapshot. Structurally the same shape
 * `@repo/database`'s `resolveCurrentInstructionRepository` returns and the
 * SDK's `PublishedInstructions.repository` carries; repeated here for the
 * same reason as `PublishedInstructionSource` above. `host` is a bare,
 * lowercased hostname — never the repository URL, never userinfo.
 *
 * `path` is `"<owner>/<name>"` for GitHub and GitLab (a GitLab owner may be
 * a subgroup path). For Azure DevOps it is the URL path as the provider
 * spells it, `_git` included — `<org>/<project>/_git/<repo>`, or
 * `<org>/_git/<repo>` when the URL names no project — and `host` is always
 * `dev.azure.com`, even for a repository stored under a
 * `<org>.visualstudio.com` URL, so a client maps every remote spelling of the
 * repository to that one pair and compares it case-insensitively.
 *
 * `cloneUrl` is the canonical credential-free HTTPS URL a developer's own git
 * clones from; `null` only for a legacy stored value that is not one. Fabric
 * never hands out a repository token with it.
 *
 * `sync` is the sync's own state, not part of the configuration's identity:
 * a client comparing two responses to see whether the configuration changed
 * leaves it out, because `lastRun` moves on every sync.
 *
 * `cloneUrl` and `sync` are optional because a client reads them from
 * whichever deployment it talks to, and one older than these fields leaves
 * them out. A server always sends both.
 */
export type PublishedInstructionRepositoryConfig = {
	provider: "GITHUB" | "GITLAB" | "AZURE_DEVOPS";
	host: string;
	path: string;
	ref: string;
	rootPath: string;
	generation: number;
	cloneUrl?: string | null;
	sync?: PublishedInstructionRepositorySync;
};

/**
 * The newest run of the CURRENT sync configuration. `status` and `finishedAt`
 * are `null` while it is still open. `trigger`, `status` and `error` are
 * closed vocabularies on the server (`error` is never free text, and
 * `TREE_REFUSED` is the secret scan refusing a tree), typed `string` here so a
 * value the server adds later does not break a client that only compares the
 * ones it knows. `commitSha` is the branch tip the run evaluated, `null` when
 * it never got that far.
 */
export type PublishedInstructionSyncRun = {
	trigger: string;
	status: string | null;
	error: string | null;
	commitSha: string | null;
	finishedAt: string | null;
};

/** `pausedReason` is `null` while automatic sync is not paused. */
export type PublishedInstructionRepositorySync = {
	automatic: boolean;
	pausedReason: string | null;
	lastRun: PublishedInstructionSyncRun | null;
};

export interface InstructionCheck {
	id: CheckId;
	title: string;
	status: CheckStatus;
	evidence: CheckEvidence;
	/** One line. Never a secret, a variable value, or unbounded published text. */
	detail: string;
	items?: CheckItem[];
	fix?: CheckFix;
	/** Set on the `published` check only, when the server reported one. */
	source?: PublishedInstructionSource;
	/** Set on the `published` check only, alongside `source`. `null` when not repository-backed. */
	repository?: PublishedInstructionRepositoryConfig | null;
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

// ---------------------------------------------------------------------------
// Checkout verdict
// ---------------------------------------------------------------------------

/**
 * What a caller reports about the git checkout it runs in, to compare with
 * the commit a repository-sourced project published. Every field is a claim:
 * the MCP surface compares what it is told and never sees the machine.
 */
export interface CheckoutFacts {
	/** The remote the checkout fetches from, as `git remote get-url` prints it. */
	remoteUrl: string;
	/** `HEAD`'s full object name. */
	headSha: string;
	/** The checked-out branch; `null` for a detached HEAD. */
	branch: string | null;
	/** The working tree has no uncommitted changes. */
	clean: boolean;
	/**
	 * Whether `HEAD`'s history contains the published commit (`git merge-base
	 * --is-ancestor <published> HEAD`); absent or `null` when the caller did
	 * not ask git. Only an ancestry answer separates "ahead" from "behind or
	 * diverged" once `HEAD` is not the published commit.
	 */
	containsPublished?: boolean | null;
}

export const CHECKOUT_REMOTE_URL_MAX_CHARS = 512;
export const CHECKOUT_BRANCH_MAX_CHARS = 255;
/** A full object name, SHA-1 or SHA-256, lowercase: the literal the CLI's git module accepts. */
export const CHECKOUT_COMMIT_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/**
 * The branch names the CLI's git module will pass to git or print as a
 * command: conservative, and never a revision expression such as `@{-1}`.
 */
export const CHECKOUT_BRANCH_LITERAL = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** A repository named the way a published response names it: `host` and `path`. */
export interface CanonicalRemote {
	/** Lowercased. */
	host: string;
	/** Every segment, `.git` stripped: `group/subgroup/repo` on GitLab. */
	path: string;
}

const REMOTE_HOST =
	/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)*$/;

/** `[user@]host` → the host, or null when what remains is not a bare hostname. */
function remoteHost(authority: string): string | null {
	const at = authority.lastIndexOf("@");
	const host = at === -1 ? authority : authority.slice(at + 1);
	// A `:` left in the authority is a port, and a port is never compared.
	return host.includes(":") || !REMOTE_HOST.test(host)
		? null
		: host.toLowerCase();
}

function remoteSegments(raw: string): string[] | null {
	let value = raw;
	while (value.endsWith("/")) {
		value = value.slice(0, -1);
	}
	if (value.endsWith(".git")) {
		value = value.slice(0, -".git".length);
	}
	if (value === "" || value.startsWith("/")) {
		return null;
	}
	const segments = value.split("/");
	for (const segment of segments) {
		if (
			segment === "" ||
			segment === "." ||
			segment === ".." ||
			/[\s\\?#]/.test(segment) ||
			// biome-ignore lint/suspicious/noControlCharactersInRegex: rejecting them is the point
			/[\u0000-\u001f\u007f]/.test(segment)
		) {
			return null;
		}
	}
	return segments;
}

/**
 * The host and path segments of a remote written as `https://[user@]host/path`,
 * `ssh://[user@]host/path` or scp-like `[user@]host:path`. Userinfo is dropped
 * and never returned: it is where a credential lives in a URL. A port,
 * `file://`, `git://`, a local path and a Windows drive letter are all `null`.
 */
function parseRemote(url: string): { host: string; segments: string[] } | null {
	const value = url.trim();
	if (value === "" || value.startsWith("\\\\") || value.startsWith("//")) {
		return null;
	}
	const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(value);
	if (scheme) {
		const name = (scheme[1] ?? "").toLowerCase();
		if (name !== "https" && name !== "ssh") {
			return null;
		}
		const rest = value.slice(scheme[0].length);
		const slash = rest.indexOf("/");
		if (slash <= 0) {
			return null;
		}
		const host = remoteHost(rest.slice(0, slash));
		const segments = remoteSegments(rest.slice(slash + 1));
		return host && segments ? { host, segments } : null;
	}
	// scp-like. Only when no `/` comes before the first `:` (otherwise it is a
	// local path), and never a single letter before it (a Windows drive).
	const colon = value.indexOf(":");
	if (colon <= 0) {
		return null;
	}
	const authority = value.slice(0, colon);
	if (authority.includes("/") || authority.includes("\\")) {
		return null;
	}
	if (/^[A-Za-z]$/.test(authority.slice(authority.lastIndexOf("@") + 1))) {
		return null;
	}
	const host = remoteHost(authority);
	// `host:2222/x` is scp syntax for the PATH `2222/x`; scp-like URLs have no port.
	const segments = remoteSegments(value.slice(colon + 1));
	return host && segments ? { host, segments } : null;
}

const AZURE_DEVOPS_SSH_HOSTS: ReadonlySet<string> = new Set([
	"ssh.dev.azure.com",
	"vs-ssh.visualstudio.com",
]);
const VISUAL_STUDIO_HOST =
	/^([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.visualstudio\.com$/;

/** What follows the organization in an Azure DevOps path: `<project>/_git/<repo>` or `_git/<repo>`. */
function azureDevOpsRemote(
	organization: string,
	rest: readonly string[],
): CanonicalRemote | null {
	const project = rest.length === 3 ? rest[0] : undefined;
	const marker = rest.length === 3 ? rest[1] : rest[0];
	const repository = rest[rest.length - 1];
	if (
		(rest.length !== 2 && rest.length !== 3) ||
		marker?.toLowerCase() !== "_git" ||
		!repository
	) {
		return null;
	}
	return {
		host: "dev.azure.com",
		path: [
			organization,
			...(project ? [project] : []),
			"_git",
			repository,
		].join("/"),
	};
}

/**
 * A remote's repository, in the one form a published response names it, or
 * `null` when the remote is not a spelling this understands.
 *
 * GitHub and GitLab keep their own host and path (`owner/repo`,
 * `group/subgroup/repo`). Azure DevOps has five spellings of one repository,
 * and all of them become `dev.azure.com` with the path
 * `<org>/<project>/_git/<repo>` (`<org>/_git/<repo>` when no project is named):
 *
 *   https://dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>@dev.azure.com/<org>/<project>/_git/<repo>
 *   https://<org>.visualstudio.com/<project>/_git/<repo>
 *   git@ssh.dev.azure.com:v3/<org>/<project>/<repo>
 *   <org>@vs-ssh.visualstudio.com:v3/<org>/<project>/<repo>
 */
export function canonicalizeRepositoryRemote(
	url: string,
): CanonicalRemote | null {
	const parsed = parseRemote(url);
	if (!parsed) {
		return null;
	}
	const { host, segments } = parsed;
	if (host === "dev.azure.com") {
		const [organization, ...rest] = segments;
		return organization ? azureDevOpsRemote(organization, rest) : null;
	}
	if (AZURE_DEVOPS_SSH_HOSTS.has(host)) {
		const [version, organization, project, repository] = segments;
		return segments.length === 4 &&
			version === "v3" &&
			organization &&
			project &&
			repository
			? {
					host: "dev.azure.com",
					path: `${organization}/${project}/_git/${repository}`,
				}
			: null;
	}
	if (host.endsWith(".visualstudio.com")) {
		const organization = VISUAL_STUDIO_HOST.exec(host)?.[1];
		return organization ? azureDevOpsRemote(organization, segments) : null;
	}
	return { host, path: segments.join("/") };
}

/**
 * Whether a canonical remote is the project's repository. The host compares
 * case-insensitively; the path does on GitHub and Azure DevOps, whose names
 * are case-insensitive, and exactly on GitLab.
 */
export function remoteMatchesRepository(
	remote: CanonicalRemote,
	repository: Pick<
		PublishedInstructionRepositoryConfig,
		"provider" | "host" | "path"
	>,
): boolean {
	if (remote.host !== repository.host.toLowerCase()) {
		return false;
	}
	const expected = repository.path.replace(/^\/+|\/+$/g, "");
	return repository.provider === "GITLAB"
		? remote.path === expected
		: remote.path.toLowerCase() === expected.toLowerCase();
}

export const CHECKOUT_VERDICTS = [
	"foreign",
	"current",
	"dirty",
	"fabric-lags",
	"other-branch",
	"ahead",
	"behind-or-diverged",
] as const;
export type CheckoutVerdict = (typeof CHECKOUT_VERDICTS)[number];

export interface CheckoutDecision {
	verdict: CheckoutVerdict;
	status: CheckStatus;
	/** One line. Names branches and short commit ids, never the remote URL as given. */
	detail: string;
	/** A proposal for the developer, never authority for the caller. */
	fix?: CheckFix;
}

function shortSha(sha: string): string {
	return sanitizeDisplayText(sha.slice(0, 7), 7);
}

/** Why Fabric's copy is behind a branch tip the checkout has, from the sync's own state. */
function lagReason(sync: PublishedInstructionRepositorySync | undefined): {
	detail: string;
	fix: CheckFix;
} {
	const run = sync?.lastRun;
	if (run?.error === "TREE_REFUSED" || run?.status === "REJECTED") {
		return {
			detail: "a commit was refused by the secret scan",
			fix: {
				description:
					"open the project's Coding Instructions tab to see the findings, fix them in the repository and commit again. This checkout needs no change; nothing here entitles an agent to change the repository or the project's settings",
			},
		};
	}
	const fix: CheckFix = {
		description:
			"Fabric's copy follows the branch on its next sync; open the project's Coding Instructions tab to sync now or to see why it has not. This checkout needs no change",
	};
	if (run && run.status === null) {
		return { detail: "a sync is in progress", fix };
	}
	if (run?.status === "FAILED") {
		return { detail: "the last sync failed", fix };
	}
	if (sync && sync.pausedReason !== null) {
		return { detail: "automatic sync is paused", fix };
	}
	if (sync && !sync.automatic) {
		return { detail: "automatic sync is off", fix };
	}
	return { detail: "the next sync has not run yet", fix };
}

/**
 * Compares a caller-reported checkout with the commit a repository-sourced
 * project published. Pure: no I/O, and the answer depends only on what was
 * reported and on the published state.
 *
 * The server never sees the branch tip, only the commit it last published and
 * the tip its newest sync run evaluated, so the verdicts are what those two
 * numbers can establish:
 *
 * - `foreign`: the remote is not the project's repository. Nothing compared.
 * - `current`: HEAD is the published commit and the tree is clean.
 * - `dirty`: HEAD is the published commit but the tree has uncommitted changes.
 * - `fabric-lags`: HEAD is the tip Fabric's last run evaluated (or the sync
 *   now follows another branch), yet the published copy is older. The
 *   checkout is fine; the sync is not, and the reason is the sync's state.
 * - `other-branch`: HEAD differs from the published commit on a branch other
 *   than the synced one (or detached), so no comparison is possible.
 * - `behind-or-diverged`: HEAD differs on the synced branch. Without the
 *   history the server cannot tell behind from diverged; the ancestry answer
 *   comes from the check the session hook runs on the machine.
 *
 * Every `fix` is a proposal. None grants the caller the authority to pull,
 * reset, rebase, stash or overwrite anything.
 */
const DIRTY_FIX: CheckFix = {
	description:
		"commit or stash the uncommitted changes, or confirm they are intended; that is the developer's decision, not an agent's",
};

export function decideCheckoutVerdict(input: {
	checkout: CheckoutFacts;
	repository: PublishedInstructionRepositoryConfig;
	published: Extract<PublishedInstructionSource, { kind: "REPOSITORY" }>;
}): CheckoutDecision {
	const { checkout, repository, published } = input;
	const projectRepository = sanitizeDisplayText(
		`${repository.host}/${repository.path}`,
		200,
	);
	const ref = sanitizeDisplayText(repository.ref, 200);
	const remote = canonicalizeRepositoryRemote(checkout.remoteUrl);
	if (!remote || !remoteMatchesRepository(remote, repository)) {
		return {
			verdict: "foreign",
			status: "skip",
			detail: remote
				? `this checkout's remote is ${sanitizeDisplayText(`${remote.host}/${remote.path}`, 200)}, not ${projectRepository}; nothing was compared`
				: `this checkout's remote is not a repository URL that can be compared with ${projectRepository}; nothing was compared`,
		};
	}

	const head = shortSha(checkout.headSha);
	const publishedHead = shortSha(published.commitSha);
	if (!published.current) {
		return {
			verdict: "fabric-lags",
			status: "warn",
			detail: `the project now syncs ${ref} of ${projectRepository}; Fabric's published copy (commit ${publishedHead}) is from another branch or repository until the next sync takes it`,
			fix: lagReason(repository.sync).fix,
		};
	}

	const atPublished =
		checkout.headSha.toLowerCase() === published.commitSha.toLowerCase();
	if (atPublished) {
		return checkout.clean
			? {
					verdict: "current",
					status: "pass",
					detail: `this checkout is at the published commit ${publishedHead} of ${ref}`,
				}
			: {
					verdict: "dirty",
					status: "warn",
					detail: `this checkout is at the published commit ${publishedHead} of ${ref} but has uncommitted changes, so its instruction files may differ from the published ones`,
					fix: DIRTY_FIX,
				};
	}

	const tip = repository.sync?.lastRun?.commitSha ?? null;
	if (tip !== null && checkout.headSha.toLowerCase() === tip.toLowerCase()) {
		const reason = lagReason(repository.sync);
		return {
			verdict: "fabric-lags",
			status: "warn",
			detail: `this checkout is at ${head}, ahead of Fabric's published copy (commit ${publishedHead} of ${ref}): ${reason.detail}`,
			fix: reason.fix,
		};
	}

	if (checkout.branch !== repository.ref) {
		return {
			verdict: "other-branch",
			status: "skip",
			detail: `this checkout is at ${head} on ${checkout.branch === null ? "a detached HEAD" : sanitizeDisplayText(checkout.branch, 200)}, not ${ref}, so the published commit ${publishedHead} cannot be compared from here`,
		};
	}

	if (checkout.containsPublished === true) {
		return checkout.clean
			? {
					verdict: "ahead",
					status: "pass",
					detail: `this checkout is at ${head} on ${ref}, ahead of the published commit ${publishedHead}: its history contains it`,
				}
			: {
					verdict: "ahead",
					status: "warn",
					detail: `this checkout is at ${head} on ${ref}, ahead of the published commit ${publishedHead}, and has uncommitted changes, so its instruction files may differ from the committed ones`,
					fix: DIRTY_FIX,
				};
	}

	const knownBehind = checkout.containsPublished === false;
	return {
		verdict: "behind-or-diverged",
		status: "warn",
		detail: `this checkout is at ${head}, not the published commit ${publishedHead} of ${ref}: ${knownBehind ? "its history does not contain it" : "it is behind it or has diverged from it"}${checkout.clean ? "" : ", and has uncommitted changes"}`,
		fix: {
			description: `${knownBehind ? "" : "on the machine, the session hook settles which at each session start (to check now, run the setup line from the project's Connect dialog again), then "}pull ${ref} yourself or ask the developer to${checkout.clean ? "" : " (commit or stash the uncommitted changes first)"}; nothing here entitles an agent to pull, reset, rebase, stash or overwrite files`,
		},
	};
}
