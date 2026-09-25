/**
 * `fabric instructions doctor` — is this machine set up the way the project's
 * coding instructions expect?
 *
 * Nine checks, in `CHECK_IDS` order, each one a finding with at most one
 * proposed remedy. The shape is the one the MCP `fabric_instruction_checks`
 * tool returns (`checks.ts`), so an agent reads either surface the same way.
 *
 * What this module will not do, and why each line matters:
 *
 *   - It never EXECUTES anything. Tools named by the published
 *     `fabric.environment.json` and commands named by a repository's
 *     `.mcp.json` are checked by PATH lookup (`stat`) only. Running
 *     `<tool> --version` would be code execution chosen by whoever can
 *     publish the instruction set or commit to the repository.
 *   - It never reads, prints or sends a DECLARED environment variable's
 *     VALUE. A declaration names variables; presence is `Object.keys(env)`.
 *     The only values this module reads are `PATH` and `PATHEXT`, for the
 *     lookup, and it never prints them.
 *   - It never repeats an exception message, an input excerpt, or a URL.
 *     Every detail is either fixed text, a number, a validated identifier, or
 *     published/repository text passed through `sanitizeDisplayText` with a
 *     bound. An unexpected exception inside a check becomes that check's
 *     `fail` with the error's class name, and the next check runs.
 *   - Its fixes are PROPOSALS. A generated `fix.command` is built only from
 *     validated, shell-quoted arguments the person gave doctor (project id,
 *     `--org`, `--dest`) — never from declaration or repository text — and
 *     nothing here acts on one. Installing software, changing credentials
 *     and overwriting files are a person's decisions.
 *   - It touches the network for three reasons only: the key check, the
 *     published manifest, and — when the published declaration is not
 *     already on disk and current — the bundle that carries it. `.mcp.json`
 *     `url` servers are probed only under `--probe-network`, with no headers
 *     from the config, no redirects followed, and the body never read.
 */
import { createHash } from "node:crypto";
import path from "node:path";
import type {
	InstructionDownload,
	InstructionManifestEntry,
	PublishedInstructionRepository,
	PublishedInstructionSnapshot,
	PublishedInstructionSource,
	PublishedInstructions,
	WhoamiResult,
} from "@fabricorg/sdk";
import { extractBundle } from "./bundle.js";
import {
	buildChecksReport,
	CHECK_TITLES,
	type CheckEvidence,
	type CheckFix,
	type CheckId,
	type CheckItem,
	type CheckStatus,
	evaluateDeclaredVariables,
	INSTRUCTION_ENVIRONMENT_FILE,
	INSTRUCTION_ENVIRONMENT_MAX_BYTES,
	type InstructionCheck,
	type InstructionChecksReport,
	type InstructionEnvironment,
	parseInstructionEnvironment,
	sanitizeDisplayText,
	TOOL_NAME,
} from "./checks.js";
import {
	buildHookCommand,
	findSessionStartHooks,
	type InstructionsHookTool,
} from "./hook.js";
import {
	type InstructionsLock,
	LockReadRefusedError,
	lockPath,
	readLockSafely,
} from "./lock.js";
import { maxArchiveBytes } from "./manifest.js";
import {
	isTooLarge,
	MCP_CONFIG_FILE,
	type McpServerEntry,
	readMcpConfig,
} from "./mcp-config.js";
import {
	isExecutableFile,
	isOnPath,
	type PathLookupEnvironment,
} from "./path-lookup.js";
import { findLedgerDrift, type LedgerDriftReason } from "./plan.js";
import { readFileSafely } from "./safe-write.js";

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

/** The two server calls doctor makes on the manifest client. */
interface DoctorClient {
	auth: { whoami(): Promise<WhoamiResult> };
	instructions: {
		getPublished(
			projectId: string,
			options: { org?: string },
		): Promise<PublishedInstructions>;
	};
}

export interface DoctorInput {
	projectId: string;
	/** `--org` exactly as given, or undefined. Never an ambient default. */
	org?: string;
	/** The absolute destination, shown in details. */
	destination: string;
	/** The canonical root every guarded read resolves against. */
	root: string;
	/**
	 * `--dest` as generated fix commands should carry it, or undefined when
	 * doctor was not given one (the commands then run in the same cwd).
	 */
	commandDest?: string;
	probeNetwork: boolean;
	/** Names are read from here; values are read only for PATH and PATHEXT. */
	env: Readonly<Record<string, string | undefined>>;
	platform: NodeJS.Platform;
	/** Whether a key is configured at all. The key itself never reaches this module. */
	apiKeyPresent: boolean;
	/** Built lazily, and only once a key is known to exist. */
	client: () => DoctorClient;
	createDownloadUrl: (
		projectId: string,
		options: { org?: string },
	) => Promise<InstructionDownload>;
	/** Download the bundle, reading at most `maxBytes`. */
	fetchArchive: (url: string, maxBytes: number) => Promise<Uint8Array>;
	/** The fetch `--probe-network` uses; the global one when omitted. */
	fetchImpl?: typeof fetch;
}

// ---------------------------------------------------------------------------
// Limits and fixed wording
// ---------------------------------------------------------------------------

/** Items listed per check before the rest are summarised. */
const MAX_ITEMS = 50;
/** Names listed inside one fix description. */
const MAX_NAMES_IN_FIX = 20;
/** A 5000-file lock is about a megabyte; anything near this is not a lock. */
const MAX_LOCK_BYTES = 16 * 1024 * 1024;
/**
 * The largest archive a VALID snapshot can be (`manifest.ts`'s limits: 50 MiB
 * of content, 5000 entries of up to 1024-byte paths, plus framing). The
 * doctor caps the download at this whatever the manifest claims, because it
 * reads the manifest without `assertValidManifest`.
 */
const MAX_DOWNLOAD_BYTES = 52_428_800 + 1_048_576 + 5000 * (512 + 2 * 1024);

const PROBE_TIMEOUT_MS = 5_000;
const PROBE_BUDGET_MS = 15_000;
const MAX_PROBES = 20;
const PROBE_CONCURRENCY = 4;

const LOGIN_COMMAND = "fabric auth login --key <api-key>";
const CLI_INSTALL_COMMAND = "npm install -g @fabricorg/cli";
const REPOSITORY_SKIP =
	"repository-backed project: files and hooks are managed by git";
const SKIP_AFTER_AUTH = "not evaluated: the API key check failed";
const SKIP_AFTER_ACCESS = "not evaluated: the project could not be read";
const SKIP_AFTER_PUBLISHED =
	"not evaluated: the published version could not be read";
const NOTHING_PUBLISHED = "nothing published to compare against";
const HOOK_NOT_VERIFIED =
	"execution, trust and the coding tool's PATH are not verified";
const NETWORK_FIX =
	"check the network connection and the deployment URL (FABRIC_BASE_URL, or the profile's --base-url), then rerun doctor";
const DECLARATION_FORMAT_FIX = `fix ${INSTRUCTION_ENVIRONMENT_FILE} in the instruction set; its format is in docs/guides/coding-instructions-cli.md`;

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function makeCheck(
	id: CheckId,
	evidence: CheckEvidence,
	status: CheckStatus,
	detail: string,
	extra: {
		items?: CheckItem[];
		fix?: CheckFix;
		source?: PublishedInstructionSource;
		/**
		 * The project's CURRENT repository-sync configuration (Fizzy #2709) —
		 * a sibling of `source`, which is the per-snapshot provenance. `null`
		 * means the project is UPLOAD-sourced, or is REPOSITORY-sourced with
		 * no sync row; `undefined` (the field left out entirely) means the
		 * caller has nothing to report for this check.
		 */
		repository?: PublishedInstructionRepository | null;
	} = {},
): InstructionCheck {
	return {
		id,
		title: CHECK_TITLES[id],
		status,
		evidence,
		detail,
		...(extra.items !== undefined && extra.items.length > 0
			? { items: extra.items }
			: {}),
		...(extra.fix !== undefined ? { fix: extra.fix } : {}),
		...(extra.source !== undefined ? { source: extra.source } : {}),
		...(extra.repository !== undefined
			? { repository: extra.repository }
			: {}),
	};
}

function fixOf(description: string, command?: string): CheckFix {
	return command === undefined ? { description } : { command, description };
}

/** The error's class name, and nothing it says about itself. */
function errorClassName(error: unknown): string {
	const name =
		error instanceof Error
			? error.name || error.constructor?.name
			: typeof error;
	return typeof name === "string" && /^[A-Za-z0-9_]{1,64}$/.test(name)
		? name
		: "Error";
}

/**
 * The fix for a check an exception stopped. Generic on purpose: the only
 * thing known about the failure is its class name, and a fix is promised for
 * every `fail`.
 */
const COULD_NOT_RUN_FIX =
	"rerun doctor; if this check keeps failing, report the failure class shown above";

function couldNotRun(
	id: CheckId,
	evidence: CheckEvidence,
	error: unknown,
): InstructionCheck {
	return makeCheck(
		id,
		evidence,
		"fail",
		`check could not run (${errorClassName(error)})`,
		{ fix: fixOf(COULD_NOT_RUN_FIX) },
	);
}

async function guarded(
	id: CheckId,
	evidence: CheckEvidence,
	body: () => Promise<InstructionCheck>,
): Promise<InstructionCheck> {
	try {
		return await body();
	} catch (error) {
		return couldNotRun(id, evidence, error);
	}
}

async function guardedWithState<T>(
	id: CheckId,
	evidence: CheckEvidence,
	fallback: T,
	body: () => Promise<[InstructionCheck, T]>,
): Promise<[InstructionCheck, T]> {
	try {
		return await body();
	} catch (error) {
		return [couldNotRun(id, evidence, error), fallback];
	}
}

function statusOf(error: unknown): number | undefined {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : undefined;
}

function codeOf(error: unknown): string | undefined {
	const code = (error as { code?: unknown } | null)?.code;
	return typeof code === "string" ? code : undefined;
}

/** An SDK failure as a class: never the server's or the runtime's message. */
function requestFailureClass(error: unknown): string {
	const code = codeOf(error);
	if (code === "TIMEOUT") {
		return "timed out";
	}
	if (code === "NETWORK_ERROR") {
		return "could not reach the server";
	}
	const status = statusOf(error);
	if (status !== undefined && status > 0) {
		return `HTTP ${status}`;
	}
	return `unexpected ${errorClassName(error)}`;
}

function hasControlCharacter(value: string): boolean {
	for (let index = 0; index < value.length; index++) {
		const code = value.charCodeAt(index);
		if (code < 0x20 || (code >= 0x7f && code <= 0x9f)) {
			return true;
		}
	}
	return false;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX single-quoting: safe to paste into sh, bash and zsh. */
function shellQuote(value: string): string {
	if (value.length > 0 && SHELL_SAFE.test(value)) {
		return value;
	}
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * `fabric <args>` as one pasteable POSIX command, or `undefined` when any
 * word carries a control character: a newline in a path cannot be quoted
 * into something a person can safely paste, so no command is offered at all.
 * Doctor's fixes and the sync report's repair command both come from here.
 */
export function buildFabricCommand(
	args: readonly string[],
): string | undefined {
	if (args.some(hasControlCharacter)) {
		return undefined;
	}
	return ["fabric", ...args].map(shellQuote).join(" ");
}

function sha256Hex(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

function listNames(names: readonly string[]): string {
	const shown = names.slice(0, MAX_NAMES_IN_FIX);
	const rest = names.length - shown.length;
	return rest > 0 ? `${shown.join(", ")} and ${rest} more` : shown.join(", ");
}

function capItems(items: CheckItem[], status: CheckStatus): CheckItem[] {
	if (items.length <= MAX_ITEMS) {
		return items;
	}
	return [
		...items.slice(0, MAX_ITEMS),
		{
			name: `${items.length - MAX_ITEMS} more`,
			status,
			detail: "not listed",
		},
	];
}

function plural(count: number, noun: string): string {
	return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// ---------------------------------------------------------------------------
// Generated commands
// ---------------------------------------------------------------------------

/**
 * The fix commands doctor proposes, built ONLY from arguments the person
 * gave it. Every one carries `--org` and `--dest` when doctor had them, so a
 * pasted command acts on the same project, context and checkout. A value with
 * a control character produces no command at all rather than one that would
 * not survive a paste.
 */
class Commands {
	constructor(private readonly input: DoctorInput) {}

	private context(): string[] {
		return [
			...(this.input.org !== undefined ? ["--org", this.input.org] : []),
			...(this.input.commandDest !== undefined
				? ["--dest", this.input.commandDest]
				: []),
		];
	}

	private build(args: string[]): string | undefined {
		return buildFabricCommand(args);
	}

	sync(): string | undefined {
		return this.build([
			"instructions",
			"sync",
			"--project",
			this.input.projectId,
			...this.context(),
		]);
	}

	repair(): string | undefined {
		return this.build([
			"instructions",
			"sync",
			"--project",
			this.input.projectId,
			...this.context(),
			"--repair",
		]);
	}

	push(): string | undefined {
		return this.build([
			"instructions",
			"push",
			"--project",
			this.input.projectId,
			...this.context(),
		]);
	}

	init(tool: InstructionsHookTool): string | undefined {
		return this.build([
			"instructions",
			"init",
			"--project",
			this.input.projectId,
			"--tool",
			tool,
			...this.context(),
		]);
	}

	doctor(): string | undefined {
		return this.build([
			"instructions",
			"doctor",
			"--project",
			this.input.projectId,
			...this.context(),
			...(this.input.probeNetwork ? ["--probe-network"] : []),
		]);
	}
}

// ---------------------------------------------------------------------------
// State carried between checks
// ---------------------------------------------------------------------------

type AccessState =
	| { kind: "unavailable"; reason: string }
	| { kind: "ok"; published: PublishedInstructions };

type SnapshotState =
	| { kind: "unavailable"; reason: string }
	| { kind: "unpublished"; repository: boolean }
	| {
			kind: "published";
			repository: boolean;
			snapshot: PublishedInstructionSnapshot;
			manifest: InstructionManifestEntry[];
	  };

type LockState =
	| { kind: "not-evaluated" }
	| { kind: "absent" }
	| { kind: "unreadable" }
	| { kind: "foreign" }
	/** `current`: the lock's digest is the published one. */
	| { kind: "usable"; lock: InstructionsLock; current: boolean };

/**
 * Where the declaration came from. `published`: the snapshot's own file.
 * `local-unpublished`: a file on disk the published snapshot does not carry.
 * `checkout`: a repository-backed project's file, read from the checkout.
 */
type Provenance = "published" | "local-unpublished" | "checkout";

type DeclarationState =
	| { kind: "skip"; detail: string }
	| {
			kind: "unreadable";
			status: "fail" | "warn";
			detail: string;
			/** Required: every `fail` in a report carries a proposed fix. */
			fix: CheckFix;
	  }
	| {
			kind: "ok";
			declaration: InstructionEnvironment;
			provenance: Provenance;
	  };

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

export async function runDoctor(
	input: DoctorInput,
): Promise<InstructionChecksReport> {
	let built: DoctorClient | undefined;
	const client = (): DoctorClient => {
		if (built === undefined) {
			built = input.client();
		}
		return built;
	};
	const commands = new Commands(input);

	const [auth, authOk] = await guardedWithState<boolean>(
		"auth",
		"server",
		false,
		() => checkAuth(input, client),
	);
	const [access, accessState] = await guardedWithState<AccessState>(
		"access",
		"server",
		{ kind: "unavailable", reason: SKIP_AFTER_ACCESS },
		() => checkAccess(input, client, authOk),
	);
	const [published, snapshot] = await guardedWithState<SnapshotState>(
		"published",
		"server",
		{ kind: "unavailable", reason: SKIP_AFTER_PUBLISHED },
		async () => checkPublished(accessState),
	);
	const [lock, lockState] = await guardedWithState<LockState>(
		"lock",
		"machine",
		{ kind: "not-evaluated" },
		() => checkLock(input, commands, snapshot),
	);
	const drift = await guarded("drift", "machine", () =>
		checkDrift(input, commands, snapshot, lockState),
	);
	const hook = await guarded("hook", "machine", () =>
		checkHook(input, commands, snapshot),
	);

	let declaration: DeclarationState;
	try {
		declaration = await resolveDeclaration(
			input,
			commands,
			client,
			snapshot,
			lockState,
		);
	} catch (error) {
		declaration = {
			kind: "unreadable",
			status: "fail",
			detail: `check could not run (${errorClassName(error)})`,
			fix: fixOf(COULD_NOT_RUN_FIX),
		};
	}
	const environment = await guarded("environment", "machine", async () =>
		checkEnvironment(input, declaration),
	);
	const tools = await guarded("tools", "machine", () =>
		checkTools(input, declaration),
	);
	const mcpServers = await guarded("mcp-servers", "machine", () =>
		checkMcpServers(input),
	);

	return buildChecksReport(input.projectId, "cli", [
		auth,
		access,
		published,
		lock,
		drift,
		hook,
		environment,
		tools,
		mcpServers,
	]);
}

// ---------------------------------------------------------------------------
// auth
// ---------------------------------------------------------------------------

async function checkAuth(
	input: DoctorInput,
	client: () => DoctorClient,
): Promise<[InstructionCheck, boolean]> {
	const id = "auth";
	if (!input.apiKeyPresent) {
		return [
			makeCheck(
				id,
				"server",
				"fail",
				"no API key: FABRIC_API_KEY is not set and the active profile stores none",
				{
					fix: fixOf(
						"log in with an organization API key that carries instructions:read (create one in the organization's Settings → API keys)",
						LOGIN_COMMAND,
					),
				},
			),
			false,
		];
	}

	let who: WhoamiResult;
	try {
		who = await client().auth.whoami();
	} catch (error) {
		if (statusOf(error) === 401) {
			return [
				makeCheck(
					id,
					"server",
					"fail",
					"the API key was refused (HTTP 401)",
					{
						fix: fixOf(
							"the key is invalid, revoked or expired: log in with a current organization API key that carries instructions:read",
							LOGIN_COMMAND,
						),
					},
				),
				false,
			];
		}
		return [
			makeCheck(
				id,
				"server",
				"fail",
				`the API key could not be checked (${requestFailureClass(error)})`,
				{ fix: fixOf(NETWORK_FIX) },
			),
			false,
		];
	}

	const keyType =
		who.keyType === "organization" || who.keyType === "personal"
			? who.keyType
			: "unknown";
	const prefix =
		typeof who.keyPrefix === "string" && who.keyPrefix.length > 0
			? sanitizeDisplayText(who.keyPrefix, 24)
			: "(no prefix)";
	const label = `${keyType} key ${prefix}`;

	if (!Array.isArray(who.scopes)) {
		// Not a refusal: the project read below is the real test.
		return [
			makeCheck(
				id,
				"server",
				"warn",
				`${label}; its scopes were not reported`,
			),
			true,
		];
	}
	const scopes = who.scopes.filter(
		(scope): scope is string => typeof scope === "string",
	);
	const satisfying = scopes.includes("*")
		? "*"
		: scopes.includes("instructions:read")
			? "instructions:read"
			: null;
	if (satisfying !== null) {
		return [
			makeCheck(id, "server", "pass", `${label} with ${satisfying}`),
			true,
		];
	}
	if (keyType === "personal") {
		return [
			makeCheck(
				id,
				"server",
				"fail",
				`${label} has no instructions:read scope`,
				{
					fix: fixOf(
						"personal API keys cannot carry instructions scopes: create an ORGANIZATION API key with instructions:read in the organization's Settings → API keys, then log in with it",
						LOGIN_COMMAND,
					),
				},
			),
			false,
		];
	}
	return [
		makeCheck(
			id,
			"server",
			"fail",
			`${label} is missing the instructions:read scope`,
			{
				fix: fixOf(
					`add instructions:read to this key in the organization's Settings → API keys, or create a new key with it and run \`${LOGIN_COMMAND}\``,
				),
			},
		),
		false,
	];
}

// ---------------------------------------------------------------------------
// access
// ---------------------------------------------------------------------------

async function checkAccess(
	input: DoctorInput,
	client: () => DoctorClient,
	authOk: boolean,
): Promise<[InstructionCheck, AccessState]> {
	const id = "access";
	if (!authOk) {
		return [
			makeCheck(id, "server", "skip", SKIP_AFTER_AUTH),
			{ kind: "unavailable", reason: SKIP_AFTER_AUTH },
		];
	}
	const displayId = sanitizeDisplayText(input.projectId, 128);
	try {
		const published = await client().instructions.getPublished(
			input.projectId,
			{ org: input.org },
		);
		return [
			makeCheck(
				id,
				"server",
				"pass",
				`this key can read project ${displayId}'s coding instructions`,
			),
			{ kind: "ok", published },
		];
	} catch (error) {
		return [
			accessFailure(displayId, error),
			{ kind: "unavailable", reason: SKIP_AFTER_ACCESS },
		];
	}
}

/**
 * The route's refusals, told apart by status and code
 * (`packages/api/modules/v1/instructions.ts`): a missing SCOPE is the
 * middleware's bare-string 403, which the SDK codes `MISSING_SCOPE`; any other
 * 403 is the live project permission; 404 is "no such project for this key".
 */
function accessFailure(displayId: string, error: unknown): InstructionCheck {
	const id = "access";
	const status = statusOf(error);
	if (status === 403 && codeOf(error) === "MISSING_SCOPE") {
		return makeCheck(
			id,
			"server",
			"fail",
			"the API key is missing the instructions:read scope (HTTP 403)",
			{
				fix: fixOf(
					"add instructions:read to the key in the organization's Settings → API keys, or log in with an organization API key that carries it",
					LOGIN_COMMAND,
				),
			},
		);
	}
	if (status === 403) {
		return makeCheck(
			id,
			"server",
			"fail",
			"the server refused this project's coding instructions to this key (HTTP 403)",
			{
				fix: fixOf(
					`ask a project maintainer to grant you access to project ${displayId}: reading coding instructions needs the project's read permission`,
				),
			},
		);
	}
	if (status === 404) {
		return makeCheck(
			id,
			"server",
			"fail",
			"project not found for this key (HTTP 404)",
			{
				fix: fixOf(
					"check the project id and --org: an organization key reaches only projects in its own organization, and --org must name the project's organization",
				),
			},
		);
	}
	if (status === 401) {
		return makeCheck(
			id,
			"server",
			"fail",
			"the API key was refused (HTTP 401)",
			{
				fix: fixOf(
					"log in with a current organization API key that carries instructions:read",
					LOGIN_COMMAND,
				),
			},
		);
	}
	return makeCheck(
		id,
		"server",
		"fail",
		`could not read the published instructions (${requestFailureClass(error)})`,
		{ fix: fixOf(NETWORK_FIX) },
	);
}

// ---------------------------------------------------------------------------
// published
// ---------------------------------------------------------------------------

function checkPublished(
	access: AccessState,
): [InstructionCheck, SnapshotState] {
	const id = "published";
	if (access.kind !== "ok") {
		return [
			makeCheck(id, "server", "skip", access.reason),
			{ kind: "unavailable", reason: access.reason },
		];
	}
	const answer = access.published;
	const repository = answer.sourceOfTruth === "REPOSITORY";
	// The project's CURRENT repository-sync configuration (Fizzy #2709); the
	// API returns it regardless of whether anything is published. Named
	// distinctly from the `repository` boolean above, which answers a
	// different question ("is this project repository-backed at all") and
	// flows into `SnapshotState`.
	const repositoryConfig: PublishedInstructionRepository | null =
		answer.repository ?? null;
	if (answer.published !== true) {
		return [
			makeCheck(
				id,
				"server",
				"warn",
				"nothing is published for this project yet",
				{
					fix: fixOf(
						"publish a version from the project's Coding Instructions tab",
					),
					repository: repositoryConfig,
				},
			),
			{ kind: "unpublished", repository },
		];
	}
	if (!answer.snapshot || !Array.isArray(answer.manifest)) {
		return [
			makeCheck(
				id,
				"server",
				"fail",
				"the server reported a published version without its file list",
				{ fix: fixOf("rerun doctor; if it persists, report it") },
			),
			{ kind: "unavailable", reason: SKIP_AFTER_PUBLISHED },
		];
	}
	const snapshot = answer.snapshot;
	const digest = sanitizeDisplayText(
		String(snapshot.digest).slice(0, 12),
		12,
	);
	const source = snapshot.source;
	const sourceDetail =
		source?.kind === "REPOSITORY"
			? `, from ${sanitizeDisplayText(String(source.commitSha).slice(0, 12), 12)}… on ${sanitizeDisplayText(String(source.ref), 200)}`
			: "";
	const detail = `version ${Number(snapshot.version)} (digest ${digest}…, ${plural(Number(snapshot.fileCount), "file")})${repository ? ", mirrored from the project's repository" : ""}${sourceDetail}`;
	return [
		makeCheck(id, "server", "pass", detail, {
			...(source !== undefined ? { source } : {}),
			repository: repositoryConfig,
		}),
		{
			kind: "published",
			repository,
			snapshot,
			manifest: answer.manifest,
		},
	];
}

// ---------------------------------------------------------------------------
// lock
// ---------------------------------------------------------------------------

/**
 * Why the lock could not be used, as a class: `refused` — a symlinked
 * `.fabric` or lock, or not a regular file, so nothing was read; `too-large`
 * — a regular file over `MAX_LOCK_BYTES`; `invalid` — read, and not a lock.
 */
type LockUnreadable = "refused" | "too-large" | "invalid";

/**
 * The lock, through `readLockSafely`: the guarded, bounded reader, so a
 * `.fabric -> elsewhere` link cannot make doctor report on a lock outside the
 * checkout, then `readLock`'s own validator.
 */
async function readLockBounded(
	root: string,
): Promise<
	| { kind: "absent" }
	| { kind: "unreadable"; reason: LockUnreadable }
	| { kind: "ok"; lock: InstructionsLock }
> {
	try {
		const lock = await readLockSafely(root, { maxBytes: MAX_LOCK_BYTES });
		return lock === null ? { kind: "absent" } : { kind: "ok", lock };
	} catch (error) {
		if (error instanceof LockReadRefusedError) {
			return {
				kind: "unreadable",
				reason: isTooLarge(error.cause) ? "too-large" : "refused",
			};
		}
		return { kind: "unreadable", reason: "invalid" };
	}
}

function unreadableLockCheck(
	input: DoctorInput,
	commands: Commands,
	reason: LockUnreadable,
): InstructionCheck {
	const where = lockPath(input.destination);
	if (reason === "refused") {
		// Never "remove it": through a symlinked `.fabric`, the path names a
		// file outside the checkout, which is exactly what was refused.
		return makeCheck(
			"lock",
			"machine",
			"fail",
			"the lock could not be read safely (a symlink, or not a regular file)",
			{
				fix: fixOf(
					`${where} or its .fabric directory is a symlink or not a regular file: remove that entry (for a symlink, the link itself, not what it points to), then run this sync to take a fresh copy`,
					commands.sync(),
				),
			},
		);
	}
	return makeCheck(
		"lock",
		"machine",
		"fail",
		reason === "too-large"
			? `the lock is larger than ${MAX_LOCK_BYTES} bytes`
			: "the lock is unreadable",
		{
			fix: fixOf(
				`the lock at ${where} is damaged: remove it, then run this sync to take a fresh copy`,
				commands.sync(),
			),
		},
	);
}

async function checkLock(
	input: DoctorInput,
	commands: Commands,
	snapshot: SnapshotState,
): Promise<[InstructionCheck, LockState]> {
	const id = "lock";
	const notEvaluated: LockState = { kind: "not-evaluated" };
	if (snapshot.kind === "unavailable") {
		return [
			makeCheck(id, "machine", "skip", snapshot.reason),
			notEvaluated,
		];
	}
	if (snapshot.repository) {
		return [
			makeCheck(id, "machine", "skip", REPOSITORY_SKIP),
			notEvaluated,
		];
	}
	if (snapshot.kind === "unpublished") {
		return [
			makeCheck(id, "machine", "skip", NOTHING_PUBLISHED),
			notEvaluated,
		];
	}

	const read = await readLockBounded(input.root);
	if (read.kind === "unreadable") {
		return [
			unreadableLockCheck(input, commands, read.reason),
			{ kind: "unreadable" },
		];
	}
	if (read.kind === "absent") {
		return [
			makeCheck(
				id,
				"machine",
				"fail",
				`no lock: ${input.destination} has not been synced`,
				{
					fix: fixOf(
						"takes a first copy of the published version and writes the lock",
						commands.sync(),
					),
				},
			),
			read,
		];
	}

	const lock = read.lock;
	if (lock.projectId !== input.projectId) {
		const other = sanitizeDisplayText(lock.projectId, 128);
		return [
			makeCheck(
				id,
				"machine",
				"fail",
				`the lock was written for project ${other}`,
				{
					// Not `sync`: sync refuses a lock that belongs to another
					// project, and it is right to.
					fix: fixOf(
						`the lock in ${input.destination} was written for project ${other}; run doctor with the --dest that was synced for this project`,
					),
				},
			),
			{ kind: "foreign" },
		];
	}

	const published = snapshot.snapshot;
	if (lock.digest !== published.digest) {
		return [
			makeCheck(
				id,
				"machine",
				"fail",
				`lock is at version ${lock.snapshotVersion}, published is ${Number(published.version)}`,
				{
					fix: fixOf(
						"brings this checkout to the published version; a local edit to an instruction file is kept and listed, and `sync --repair` replaces it",
						commands.sync(),
					),
				},
			),
			{ kind: "usable", lock, current: false },
		];
	}

	const mismatches = compareLedger(lock, snapshot.manifest);
	if (mismatches.length > 0) {
		return [
			makeCheck(
				id,
				"machine",
				"fail",
				"lock ledger does not match the published manifest",
				{
					items: capItems(mismatches, "fail"),
					fix: fixOf(
						"rewrites the lock from the published manifest, restoring any file it names",
						commands.sync(),
					),
				},
			),
			{ kind: "usable", lock, current: true },
		];
	}
	return [
		makeCheck(
			id,
			"machine",
			"pass",
			`lock is at the published version ${Number(published.version)}`,
		),
		{ kind: "usable", lock, current: true },
	];
}

/**
 * The lock's ledger against the published manifest: same path set, same
 * hashes, and the same mode wherever either records one. A lock whose digest
 * matches but whose ledger does not was hand-edited or half-written, and the
 * next sync would decide deletions from it.
 */
function compareLedger(
	lock: InstructionsLock,
	manifest: readonly InstructionManifestEntry[],
): CheckItem[] {
	const published = new Map<string, InstructionManifestEntry>();
	for (const entry of manifest) {
		published.set(entry.path, entry);
	}
	const items: CheckItem[] = [];
	for (const [lockedPath, locked] of Object.entries(lock.files)) {
		const name = sanitizeDisplayText(lockedPath, 200);
		const entry = published.get(lockedPath);
		if (entry === undefined) {
			items.push({
				name,
				status: "fail",
				detail: "in the lock, not in the published manifest",
			});
		} else if (entry.sha256 !== locked.sha256) {
			items.push({
				name,
				status: "fail",
				detail: "hash differs from the published manifest",
			});
		} else if ((entry.mode ?? null) !== (locked.mode ?? null)) {
			items.push({
				name,
				status: "fail",
				detail: "mode differs from the published manifest",
			});
		}
	}
	for (const entry of manifest) {
		if (!Object.hasOwn(lock.files, entry.path)) {
			items.push({
				name: sanitizeDisplayText(String(entry.path), 200),
				status: "fail",
				detail: "published, not in the lock",
			});
		}
	}
	return items;
}

// ---------------------------------------------------------------------------
// drift
// ---------------------------------------------------------------------------

const DRIFT_DETAIL: Record<LedgerDriftReason, string> = {
	missing: "missing",
	edited: "edited",
	mode: "mode differs from the published mode",
	refused: "could not be read safely (a symlink, or not a regular file)",
};

async function checkDrift(
	input: DoctorInput,
	commands: Commands,
	snapshot: SnapshotState,
	lockState: LockState,
): Promise<InstructionCheck> {
	const id = "drift";
	if (snapshot.kind === "unavailable") {
		return makeCheck(id, "machine", "skip", snapshot.reason);
	}
	if (snapshot.repository) {
		return makeCheck(id, "machine", "skip", REPOSITORY_SKIP);
	}
	if (snapshot.kind === "unpublished") {
		return makeCheck(id, "machine", "skip", NOTHING_PUBLISHED);
	}
	if (lockState.kind !== "usable") {
		return makeCheck(
			id,
			"machine",
			"skip",
			"not evaluated: no usable lock for this project",
		);
	}

	let drift: Awaited<ReturnType<typeof findLedgerDrift>>;
	try {
		drift = await findLedgerDrift({
			root: input.root,
			lock: lockState.lock,
		});
	} catch {
		// `assertSafeLockPaths`: a traversal, a reserved path, or a collision.
		return makeCheck(
			id,
			"machine",
			"fail",
			"the lock names a path this tool will not touch",
			{
				fix: fixOf(
					`remove the lock at ${lockPath(input.destination)}, then run this sync to take a fresh copy`,
					commands.sync(),
				),
			},
		);
	}

	const total = Object.keys(lockState.lock.files).length;
	if (drift.length === 0) {
		return makeCheck(
			id,
			"machine",
			"pass",
			`all ${plural(total, "file")} the last sync wrote still match the lock`,
		);
	}
	const push = commands.push() ?? "fabric instructions push";
	const edits = drift.filter((entry) => entry.reason === "edited").length;
	// Spec §6.4: `sync` keeps a local edit unless it is given `--repair`, so
	// an edit is the intended state and only a warning. Anything else is
	// something `sync` puts back, and still fails.
	const status = edits === drift.length ? "warn" : "fail";
	const items = capItems(
		drift.map((entry) => ({
			name: sanitizeDisplayText(entry.path, 200),
			status:
				entry.reason === "edited"
					? ("warn" as const)
					: ("fail" as const),
			detail:
				entry.reason === "edited" && entry.kept
					? "edited (kept by sync)"
					: DRIFT_DETAIL[entry.reason],
		})),
		status,
	);
	if (status === "warn") {
		return makeCheck(
			id,
			"machine",
			"warn",
			`${drift.length} of ${plural(total, "file")} the last sync wrote carry local edits, which sync keeps`,
			{
				items,
				fix: fixOf(
					`replaces these local edits with the published bytes; to propose them instead, run \`${push}\``,
					commands.repair(),
				),
			},
		);
	}
	const repair = commands.repair() ?? "fabric instructions sync --repair";
	return makeCheck(
		id,
		"machine",
		"fail",
		`${drift.length} of ${plural(total, "file")} the last sync wrote no longer match the lock`,
		{
			items,
			fix: fixOf(
				edits === 0
					? `restores the published bytes over these local changes; to propose your edits instead, run \`${push}\``
					: `restores the files that are not local edits; sync keeps those, so run \`${repair}\` to replace them too, or \`${push}\` to propose them`,
				commands.sync(),
			),
		},
	);
}

// ---------------------------------------------------------------------------
// hook
// ---------------------------------------------------------------------------

const HOOK_TARGETS: ReadonlyArray<{
	tool: InstructionsHookTool;
	file: string;
}> = [
	{ tool: "claude-code", file: ".claude/settings.local.json" },
	{ tool: "codex", file: ".codex/hooks.json" },
];

/**
 * Template recognition, per target. The hook stores no binary path and no
 * CLI version, so "points at the current CLI" is verifiable in exactly one
 * sense: its command is one of the two strings this CLI would write today for
 * this project and this `--org`.
 */
async function checkHook(
	input: DoctorInput,
	commands: Commands,
	snapshot: SnapshotState,
): Promise<InstructionCheck> {
	const id = "hook";
	if (snapshot.kind === "unavailable") {
		return makeCheck(id, "machine", "skip", snapshot.reason);
	}
	if (snapshot.repository) {
		return makeCheck(id, "machine", "skip", REPOSITORY_SKIP);
	}

	const reportOnly = buildHookCommand(input.projectId, false, input.org);
	const applies = buildHookCommand(input.projectId, true, input.org);
	const items: CheckItem[] = [];
	const passing: InstructionsHookTool[] = [];
	const differing: InstructionsHookTool[] = [];
	const unreadable: InstructionsHookTool[] = [];

	for (const target of HOOK_TARGETS) {
		const name = `${target.tool} (${target.file})`;
		const scan = await findSessionStartHooks({
			root: input.root,
			projectId: input.projectId,
			tool: target.tool,
		});
		if (scan.state === "unreadable") {
			unreadable.push(target.tool);
			items.push({
				name,
				status: "warn",
				detail: "settings file could not be read or parsed",
			});
			continue;
		}
		if (scan.state === "absent" || scan.commands.length === 0) {
			items.push({ name, status: "skip", detail: "not configured" });
			continue;
		}
		if (scan.commands.includes(applies)) {
			passing.push(target.tool);
			items.push({
				name,
				status: "pass",
				detail: "canonical hook; applies changes at session start",
			});
			continue;
		}
		if (scan.commands.includes(reportOnly)) {
			passing.push(target.tool);
			items.push({
				name,
				status: "pass",
				detail: "canonical hook; reports changes at session start",
			});
			continue;
		}
		differing.push(target.tool);
		items.push({
			name,
			status: "warn",
			detail: "differs from the canonical command (different context or older syntax)",
		});
	}

	const lookup: PathLookupEnvironment = {
		env: input.env,
		platform: input.platform,
	};
	const fabricFound = await isOnPath("fabric", lookup);
	items.push({
		name: "fabric on PATH",
		status: fabricFound ? "pass" : "warn",
		detail: fabricFound
			? "found (not executed)"
			: `not found; install it with ${CLI_INSTALL_COMMAND}`,
	});

	if (passing.length > 0) {
		if (!fabricFound) {
			return makeCheck(
				id,
				"machine",
				"warn",
				`hook configured for ${passing.join(" and ")}, but fabric is not on this shell's PATH; ${HOOK_NOT_VERIFIED}`,
				{
					items,
					fix: fixOf(
						"the hook runs `fabric`; install the CLI globally so the coding tool can find it",
						CLI_INSTALL_COMMAND,
					),
				},
			);
		}
		return makeCheck(
			id,
			"machine",
			"pass",
			`hook configured for ${passing.join(" and ")}; ${HOOK_NOT_VERIFIED}`,
			{ items },
		);
	}
	if (differing.length > 0) {
		const tool = differing[0] as InstructionsHookTool;
		return makeCheck(
			id,
			"machine",
			"warn",
			`a hook for this project is not in the canonical form; ${HOOK_NOT_VERIFIED}`,
			{
				items,
				fix: fixOf(
					"rewrites this project's hook in the canonical form (init also syncs the published version first)",
					commands.init(tool),
				),
			},
		);
	}
	if (unreadable.length > 0) {
		const tool = unreadable[0] as InstructionsHookTool;
		return makeCheck(
			id,
			"machine",
			"warn",
			`a hook settings file could not be read; ${HOOK_NOT_VERIFIED}`,
			{
				items,
				fix: fixOf(
					"fix the settings file so it parses as JSON (init refuses to rewrite a file it cannot read), then run this",
					commands.init(tool),
				),
			},
		);
	}
	return makeCheck(
		id,
		"machine",
		"fail",
		"no hook configured for this project",
		{
			items,
			fix: fixOf(
				"installs the SessionStart hook for Claude Code and, when a version is published, takes a first sync; use --tool codex for Codex",
				commands.init("claude-code"),
			),
		},
	);
}

// ---------------------------------------------------------------------------
// The declaration: environment + tools
// ---------------------------------------------------------------------------

type LocalDeclarationRead =
	| { kind: "absent" }
	| { kind: "refused"; detail: string }
	| { kind: "ok"; bytes: Uint8Array };

async function readLocalDeclaration(
	root: string,
): Promise<LocalDeclarationRead> {
	try {
		const read = await readFileSafely(root, INSTRUCTION_ENVIRONMENT_FILE, {
			maxBytes: INSTRUCTION_ENVIRONMENT_MAX_BYTES,
		});
		return read === null
			? { kind: "absent" }
			: { kind: "ok", bytes: read.bytes };
	} catch (error) {
		return {
			kind: "refused",
			detail: isTooLarge(error)
				? `file is larger than ${INSTRUCTION_ENVIRONMENT_MAX_BYTES} bytes`
				: "file could not be read safely (a symlink, or not a regular file)",
		};
	}
}

const PROVENANCE_PREFIX: Record<Provenance, string> = {
	published: "published declaration: ",
	"local-unpublished": "local, unpublished declaration: ",
	checkout: "from the local checkout: ",
};

/** Hash-then-parse and parse-only both land here, on the same buffer. */
function parseDeclarationBytes(
	bytes: Uint8Array,
	provenance: Provenance,
): DeclarationState {
	let text: string;
	try {
		text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		return {
			kind: "unreadable",
			status: "fail",
			detail: `${PROVENANCE_PREFIX[provenance]}file is not valid UTF-8`,
			fix: fixOf(DECLARATION_FORMAT_FIX),
		};
	}
	const parsed = parseInstructionEnvironment(text);
	if (!parsed.ok) {
		return {
			kind: "unreadable",
			status: "fail",
			detail: `${PROVENANCE_PREFIX[provenance]}${parsed.reason}`,
			fix: fixOf(DECLARATION_FORMAT_FIX),
		};
	}
	return { kind: "ok", declaration: parsed.declaration, provenance };
}

async function declarationFromDisk(
	input: DoctorInput,
	provenance: "local-unpublished" | "checkout",
): Promise<DeclarationState> {
	const read = await readLocalDeclaration(input.root);
	if (read.kind === "absent") {
		return {
			kind: "skip",
			detail:
				provenance === "checkout"
					? `no environment declaration in the local checkout (add ${INSTRUCTION_ENVIRONMENT_FILE} to the repository's instruction set)`
					: `no environment declaration (add ${INSTRUCTION_ENVIRONMENT_FILE} to the instruction set)`,
		};
	}
	if (read.kind === "refused") {
		return {
			kind: "unreadable",
			status: "fail",
			detail: `${PROVENANCE_PREFIX[provenance]}${read.detail}`,
			fix: fixOf(DECLARATION_FORMAT_FIX),
		};
	}
	return parseDeclarationBytes(read.bytes, provenance);
}

function hasUsableSize(entry: { size: unknown }): entry is { size: number } {
	return (
		typeof entry.size === "number" &&
		Number.isSafeInteger(entry.size) &&
		entry.size >= 0
	);
}

async function resolveDeclaration(
	input: DoctorInput,
	commands: Commands,
	client: () => DoctorClient,
	snapshot: SnapshotState,
	lockState: LockState,
): Promise<DeclarationState> {
	if (snapshot.kind === "unavailable") {
		return { kind: "skip", detail: snapshot.reason };
	}
	if (snapshot.repository) {
		return declarationFromDisk(input, "checkout");
	}
	if (snapshot.kind === "published") {
		const entry = snapshot.manifest.find(
			(candidate) => candidate.path === INSTRUCTION_ENVIRONMENT_FILE,
		);
		if (entry !== undefined) {
			return declarationFromSnapshot(
				input,
				commands,
				client,
				snapshot,
				lockState,
				entry,
			);
		}
	}
	return declarationFromDisk(input, "local-unpublished");
}

async function declarationFromSnapshot(
	input: DoctorInput,
	commands: Commands,
	client: () => DoctorClient,
	snapshot: Extract<SnapshotState, { kind: "published" }>,
	lockState: LockState,
	entry: InstructionManifestEntry,
): Promise<DeclarationState> {
	const tooLarge = sizeRefusal(entry);
	if (tooLarge !== null) {
		return tooLarge;
	}

	// The local copy is the published one only when the lock names the
	// published digest AND the file's bytes hash to the manifest's entry.
	if (lockState.kind === "usable" && lockState.current) {
		const local = await readLocalDeclaration(input.root);
		if (local.kind === "ok" && sha256Hex(local.bytes) === entry.sha256) {
			return parseDeclarationBytes(local.bytes, "published");
		}
	}

	return downloadDeclaration(input, commands, client, snapshot, entry);
}

/** Refused before anything is downloaded. */
function sizeRefusal(entry: InstructionManifestEntry): DeclarationState | null {
	if (!hasUsableSize(entry)) {
		return {
			kind: "unreadable",
			status: "fail",
			detail: "published declaration has an invalid size in the manifest",
			fix: fixOf(
				"rerun doctor; if it persists, the published manifest is malformed and the project's maintainers should republish",
			),
		};
	}
	if (entry.size > INSTRUCTION_ENVIRONMENT_MAX_BYTES) {
		return {
			kind: "unreadable",
			status: "fail",
			detail: `published declaration is larger than ${INSTRUCTION_ENVIRONMENT_MAX_BYTES} bytes`,
			fix: fixOf(
				`shrink ${INSTRUCTION_ENVIRONMENT_FILE} in the instruction set below ${INSTRUCTION_ENVIRONMENT_MAX_BYTES} bytes`,
			),
		};
	}
	return null;
}

/**
 * The download endpoint re-resolves the CURRENT snapshot, so its answer is
 * compared with the manifest being checked. A publication that lands between
 * the two gets one retry of the pair; a second disagreement is reported
 * rather than guessed at.
 */
async function downloadDeclaration(
	input: DoctorInput,
	commands: Commands,
	client: () => DoctorClient,
	initial: Extract<SnapshotState, { kind: "published" }>,
	initialEntry: InstructionManifestEntry,
): Promise<DeclarationState> {
	let snapshot = initial.snapshot;
	let manifest = initial.manifest;
	let entry = initialEntry;

	for (let attempt = 0; attempt < 2; attempt++) {
		let download: InstructionDownload;
		try {
			download = await input.createDownloadUrl(input.projectId, {
				org: input.org,
			});
		} catch (error) {
			return {
				kind: "unreadable",
				status: "fail",
				detail: `could not download the published declaration (${requestFailureClass(error)})`,
				fix: fixOf(NETWORK_FIX),
			};
		}
		if (
			download.snapshotId === snapshot.id &&
			download.digest === snapshot.digest
		) {
			return fetchVerifiedDeclaration(
				input,
				download.url,
				manifest,
				entry,
			);
		}
		if (attempt > 0) {
			break;
		}

		let again: PublishedInstructions;
		try {
			again = await client().instructions.getPublished(input.projectId, {
				org: input.org,
			});
		} catch (error) {
			return {
				kind: "unreadable",
				status: "fail",
				detail: `could not re-read the published instructions (${requestFailureClass(error)})`,
				fix: fixOf(NETWORK_FIX),
			};
		}
		const nextEntry = Array.isArray(again.manifest)
			? again.manifest.find(
					(candidate) =>
						candidate.path === INSTRUCTION_ENVIRONMENT_FILE,
				)
			: undefined;
		if (
			again.published !== true ||
			!again.snapshot ||
			!Array.isArray(again.manifest) ||
			nextEntry === undefined
		) {
			break;
		}
		const refused = sizeRefusal(nextEntry);
		if (refused !== null) {
			return refused;
		}
		snapshot = again.snapshot;
		manifest = again.manifest;
		entry = nextEntry;
	}

	return {
		kind: "unreadable",
		status: "warn",
		detail: "publication changed while checking; rerun",
		fix: fixOf(
			"rerun doctor once publishing has settled",
			commands.doctor(),
		),
	};
}

async function fetchVerifiedDeclaration(
	input: DoctorInput,
	url: string,
	manifest: readonly InstructionManifestEntry[],
	entry: InstructionManifestEntry,
): Promise<DeclarationState> {
	const bound = Math.min(
		maxArchiveBytes(
			manifest.filter(
				(candidate) =>
					typeof candidate.path === "string" &&
					hasUsableSize(candidate),
			),
		),
		MAX_DOWNLOAD_BYTES,
	);
	let archive: Uint8Array;
	try {
		archive = await input.fetchArchive(url, bound);
	} catch {
		return {
			kind: "unreadable",
			status: "fail",
			detail: "could not download the published declaration",
			fix: fixOf(NETWORK_FIX),
		};
	}

	const integrity: DeclarationState = {
		kind: "unreadable",
		status: "fail",
		detail: "published declaration failed integrity check",
		fix: fixOf(
			"rerun doctor; if it persists, the published bundle does not match its manifest and the project's maintainers should republish",
		),
	};
	let files: Map<string, Uint8Array>;
	try {
		// Only this one path, within the manifest's size for it.
		files = extractBundle(archive, [
			{ path: INSTRUCTION_ENVIRONMENT_FILE, size: entry.size },
		]);
	} catch {
		return integrity;
	}
	const bytes = files.get(INSTRUCTION_ENVIRONMENT_FILE);
	if (bytes === undefined) {
		return {
			...integrity,
			detail: "published declaration is missing from the downloaded bundle",
		};
	}
	// Hash, then parse, the same buffer.
	if (sha256Hex(bytes) !== entry.sha256) {
		return integrity;
	}
	return parseDeclarationBytes(bytes, "published");
}

/** The provenance note, where the detail says where the declaration came from. */
function withProvenance(detail: string, provenance: Provenance): string {
	if (provenance === "checkout") {
		return `from the local checkout: ${detail}`;
	}
	if (provenance === "local-unpublished") {
		return `${detail}; declaration exists locally but is not published`;
	}
	return detail;
}

const PUBLISH_DECLARATION_FIX = `publish ${INSTRUCTION_ENVIRONMENT_FILE} with the instruction set so every checkout gets the same declaration`;

function checkEnvironment(
	input: DoctorInput,
	declaration: DeclarationState,
): InstructionCheck {
	const id = "environment";
	if (declaration.kind === "skip") {
		return makeCheck(id, "machine", "skip", declaration.detail);
	}
	if (declaration.kind === "unreadable") {
		return makeCheck(
			id,
			"machine",
			declaration.status,
			declaration.detail,
			{ fix: declaration.fix },
		);
	}

	const { provenance } = declaration;
	const variables = declaration.declaration.variables;
	if (variables.length === 0) {
		return makeCheck(
			id,
			"machine",
			"skip",
			withProvenance("the declaration names no variables", provenance),
		);
	}

	// NAMES only. `Object.keys` never touches a value.
	const evaluation = evaluateDeclaredVariables(
		declaration.declaration,
		Object.keys(input.env),
		{ ignoreCase: input.platform === "win32" },
	);
	const missing =
		evaluation.missingRequired.length + evaluation.missingOptional.length;
	let detail = `${variables.length - missing} of ${plural(variables.length, "declared variable")} present`;
	if (evaluation.missingRequired.length > 0) {
		detail += `; ${evaluation.missingRequired.length} required missing`;
	}
	if (evaluation.missingOptional.length > 0) {
		detail += `; ${evaluation.missingOptional.length} optional missing`;
	}

	let status = evaluation.status;
	let fix: CheckFix | undefined;
	if (evaluation.missingRequired.length > 0) {
		const optional =
			evaluation.missingOptional.length > 0
				? `; optional and unset: ${listNames(evaluation.missingOptional)}`
				: "";
		fix = fixOf(
			`set ${listNames(evaluation.missingRequired)} in your shell environment${optional} (values are never read by this tool)`,
		);
	} else if (evaluation.missingOptional.length > 0) {
		fix = fixOf(
			`optional and unset: ${listNames(evaluation.missingOptional)}; set them if you need what they enable (values are never read by this tool)`,
		);
	} else if (provenance === "local-unpublished") {
		fix = fixOf(PUBLISH_DECLARATION_FIX);
	}
	if (provenance === "local-unpublished" && status === "pass") {
		status = "warn";
	}

	return makeCheck(
		id,
		"machine",
		status,
		withProvenance(detail, provenance),
		{
			items: evaluation.items,
			...(fix !== undefined ? { fix } : {}),
		},
	);
}

async function checkTools(
	input: DoctorInput,
	declaration: DeclarationState,
): Promise<InstructionCheck> {
	const id = "tools";
	if (declaration.kind === "skip") {
		return makeCheck(id, "machine", "skip", declaration.detail);
	}
	if (declaration.kind === "unreadable") {
		return makeCheck(id, "machine", "skip", "declaration unreadable");
	}

	const { provenance } = declaration;
	const tools = declaration.declaration.tools;
	if (tools.length === 0) {
		return makeCheck(
			id,
			"machine",
			"skip",
			withProvenance("the declaration names no tools", provenance),
		);
	}

	const lookup: PathLookupEnvironment = {
		env: input.env,
		platform: input.platform,
	};
	const items: CheckItem[] = [];
	const missing: string[] = [];
	for (const tool of tools) {
		// The parser already enforced this; checked again because it is what
		// makes the name safe to join onto a PATH directory.
		const found =
			TOOL_NAME.test(tool.name) && (await isOnPath(tool.name, lookup));
		const declared =
			tool.version !== undefined
				? `; declared ${tool.version} (not verified)`
				: "";
		if (found) {
			items.push({
				name: tool.name,
				status: "pass",
				detail: `found on PATH${declared}`,
			});
		} else {
			missing.push(tool.name);
			items.push({
				name: tool.name,
				status: "fail",
				detail: `not found on PATH${tool.version !== undefined ? `; declared ${tool.version}` : ""}`,
			});
		}
	}

	const detail = withProvenance(
		`${tools.length - missing.length} of ${plural(tools.length, "declared tool")} found on PATH (presence only; nothing was run)`,
		provenance,
	);
	if (missing.length > 0) {
		return makeCheck(id, "machine", "fail", detail, {
			items,
			fix: fixOf(
				`install ${listNames(missing)} and make sure ${missing.length === 1 ? "it is" : "they are"} on PATH`,
			),
		});
	}
	if (provenance === "local-unpublished") {
		return makeCheck(id, "machine", "warn", detail, {
			items,
			fix: fixOf(PUBLISH_DECLARATION_FIX),
		});
	}
	return makeCheck(id, "machine", "pass", detail, { items });
}

// ---------------------------------------------------------------------------
// mcp-servers
// ---------------------------------------------------------------------------

async function checkMcpServers(input: DoctorInput): Promise<InstructionCheck> {
	const id = "mcp-servers";
	const config = await readMcpConfig(input.root);
	if (config.state === "absent") {
		return makeCheck(
			id,
			"machine",
			"skip",
			`no ${MCP_CONFIG_FILE} in ${input.destination}`,
		);
	}
	if (config.state === "invalid") {
		return makeCheck(
			id,
			"machine",
			"fail",
			`could not use ${MCP_CONFIG_FILE}: ${config.reason}`,
			{
				fix: fixOf(
					`fix ${MCP_CONFIG_FILE} so it is a JSON object with an "mcpServers" object of named servers`,
				),
			},
		);
	}
	if (config.servers.length === 0) {
		return makeCheck(
			id,
			"machine",
			"skip",
			`no servers configured in ${MCP_CONFIG_FILE}`,
		);
	}

	const lookup: PathLookupEnvironment = {
		env: input.env,
		platform: input.platform,
	};
	const items: CheckItem[] = [];
	const probes: Array<{ index: number; url: URL }> = [];
	for (const server of config.servers) {
		const index = items.length;
		items.push(await evaluateServer(input, lookup, server, probes, index));
	}
	if (probes.length > 0) {
		await runProbes(probes, items, input.fetchImpl ?? fetch);
	}

	const failing = config.servers
		.filter((_, index) => items[index]?.status === "fail")
		.map((server) => server.name);
	const anyUrl = config.servers.some((server) => server.kind === "url");
	const status: CheckStatus =
		failing.length > 0
			? "fail"
			: items.some((item) => item.status === "warn")
				? "warn"
				: items.some((item) => item.status === "pass")
					? "pass"
					: "skip";
	let detail = `${plural(config.servers.length, "server")} in ${MCP_CONFIG_FILE}`;
	if (anyUrl) {
		detail += input.probeNetwork
			? "; reachable means an HTTP response arrived, not that a working MCP server answered"
			: "; url servers not probed (rerun with --probe-network)";
	}
	return makeCheck(id, "machine", status, detail, {
		items,
		...(failing.length > 0
			? {
					fix: fixOf(
						`fix or remove the failing server${failing.length === 1 ? "" : "s"} in ${MCP_CONFIG_FILE}: ${listNames(failing)}`,
					),
				}
			: {}),
	});
}

async function evaluateServer(
	input: DoctorInput,
	lookup: PathLookupEnvironment,
	server: McpServerEntry,
	probes: Array<{ index: number; url: URL }>,
	index: number,
): Promise<CheckItem> {
	const name = server.name;
	if (server.kind === "invalid") {
		return { name, status: "fail", detail: server.reason };
	}
	if (server.kind === "command") {
		const found = await commandResolves(input, lookup, server.command);
		if (found === "unsupported") {
			return {
				name,
				status: "warn",
				detail: "command is not a bare executable name or a path; not checked",
			};
		}
		return found === "found"
			? { name, status: "pass", detail: "command found (not executed)" }
			: { name, status: "fail", detail: "command not found" };
	}

	if (!input.probeNetwork) {
		return {
			name,
			status: "skip",
			detail: "network probe disabled (rerun with --probe-network)",
		};
	}
	let url: URL;
	try {
		url = new URL(server.url);
	} catch {
		return { name, status: "fail", detail: "not a valid URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") {
		return { name, status: "fail", detail: "unsupported scheme" };
	}
	if (url.username !== "" || url.password !== "") {
		return {
			name,
			status: "warn",
			detail: "the URL embeds credentials; not probed",
		};
	}
	probes.push({ index, url });
	// Replaced by the probe's own verdict once it runs.
	return { name, status: "skip", detail: "probe budget exhausted" };
}

/**
 * Where an `.mcp.json` `command` would be found — by `stat`, never by running
 * it. A bare name is looked up on PATH; an absolute path is checked where it
 * is; a relative path is resolved against the checkout, where the coding tool
 * starts it.
 */
async function commandResolves(
	input: DoctorInput,
	lookup: PathLookupEnvironment,
	command: string,
): Promise<"found" | "missing" | "unsupported"> {
	if (hasControlCharacter(command) || /\s/.test(command)) {
		return "unsupported";
	}
	if (TOOL_NAME.test(command)) {
		return (await isOnPath(command, lookup)) ? "found" : "missing";
	}
	const api = input.platform === "win32" ? path.win32 : path.posix;
	if (api.isAbsolute(command)) {
		return (await isExecutableFile(command, input.platform))
			? "found"
			: "missing";
	}
	if (command.includes("/") || command.includes("\\")) {
		return (await isExecutableFile(
			path.resolve(input.root, command),
			input.platform,
		))
			? "found"
			: "missing";
	}
	return "unsupported";
}

/**
 * `--probe-network`: one GET per `url` server, bounded every way it can be.
 * At most `MAX_PROBES` requests, `PROBE_CONCURRENCY` at a time, each under
 * `PROBE_TIMEOUT_MS`, all under `PROBE_BUDGET_MS`. Whatever the budget does
 * not reach keeps its "probe budget exhausted" skip.
 */
async function runProbes(
	probes: Array<{ index: number; url: URL }>,
	items: CheckItem[],
	fetchImpl: typeof fetch,
): Promise<void> {
	const started = Date.now();
	let next = 0;
	let sent = 0;
	const worker = async (): Promise<void> => {
		while (next < probes.length) {
			const probe = probes[next++] as { index: number; url: URL };
			const remaining = PROBE_BUDGET_MS - (Date.now() - started);
			if (sent >= MAX_PROBES || remaining <= 0) {
				continue;
			}
			sent++;
			const item = items[probe.index] as CheckItem;
			const result = await probeUrl(
				probe.url,
				Math.min(PROBE_TIMEOUT_MS, remaining),
				fetchImpl,
			);
			items[probe.index] = result.ok
				? {
						name: item.name,
						status: "pass",
						detail: `reachable (${result.status === 0 ? "a redirect" : `HTTP ${result.status}`}); an HTTP response is not proof of a working MCP server`,
					}
				: { name: item.name, status: "fail", detail: result.failure };
		}
	};
	await Promise.all(
		Array.from({ length: Math.min(PROBE_CONCURRENCY, probes.length) }, () =>
			worker(),
		),
	);
}

async function probeUrl(
	url: URL,
	timeoutMs: number,
	fetchImpl: typeof fetch,
): Promise<{ ok: true; status: number } | { ok: false; failure: string }> {
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		// No headers from the config, no redirect followed, no body read: the
		// status line is the whole answer.
		const response = await fetchImpl(url.href, {
			method: "GET",
			redirect: "manual",
			signal: controller.signal,
		});
		await response.body?.cancel().catch(() => undefined);
		return { ok: true, status: response.status };
	} catch (error) {
		return {
			ok: false,
			failure: controller.signal.aborted
				? "timed out"
				: classifyNetworkFailure(error),
		};
	} finally {
		clearTimeout(timer);
	}
}

function errorCodes(error: unknown, depth = 0): string[] {
	if (depth > 4 || typeof error !== "object" || error === null) {
		return [];
	}
	const candidate = error as {
		code?: unknown;
		cause?: unknown;
		errors?: unknown;
	};
	const codes: string[] = [];
	if (typeof candidate.code === "string") {
		codes.push(candidate.code);
	}
	if (candidate.cause !== undefined) {
		codes.push(...errorCodes(candidate.cause, depth + 1));
	}
	if (Array.isArray(candidate.errors)) {
		for (const inner of candidate.errors.slice(0, 8)) {
			codes.push(...errorCodes(inner, depth + 1));
		}
	}
	return codes;
}

/** A failure CLASS, from error codes only — never an error's message. */
function classifyNetworkFailure(error: unknown): string {
	if (error instanceof Error && error.name === "AbortError") {
		return "timed out";
	}
	const codes = errorCodes(error);
	const any = (test: (code: string) => boolean) => codes.some(test);
	if (any((code) => code === "ECONNREFUSED")) {
		return "connection refused";
	}
	if (
		any((code) =>
			[
				"ENOTFOUND",
				"EAI_AGAIN",
				"EAI_NONAME",
				"EAI_NODATA",
				"EAI_FAIL",
			].includes(code),
		)
	) {
		return "DNS lookup failed";
	}
	if (
		any((code) =>
			[
				"ETIMEDOUT",
				"UND_ERR_CONNECT_TIMEOUT",
				"UND_ERR_HEADERS_TIMEOUT",
				"ABORT_ERR",
			].includes(code),
		)
	) {
		return "timed out";
	}
	if (
		any(
			(code) =>
				code.startsWith("ERR_TLS") ||
				code.startsWith("ERR_SSL") ||
				code.includes("CERT") ||
				code === "UNABLE_TO_VERIFY_LEAF_SIGNATURE" ||
				code === "EPROTO",
		)
	) {
		return "TLS error";
	}
	if (
		any((code) => ["ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code))
	) {
		return "connection reset";
	}
	if (any((code) => code === "EHOSTUNREACH" || code === "ENETUNREACH")) {
		return "host unreachable";
	}
	return "connection failed";
}

// ---------------------------------------------------------------------------
// Text output
// ---------------------------------------------------------------------------

const SYMBOL: Record<CheckStatus, string> = {
	pass: "✓",
	fail: "✗",
	warn: "!",
	skip: "-",
};

/** Items shown per check in text; `--format json` always carries them all. */
const MAX_TEXT_ITEMS = 20;

export function formatDoctorText(
	report: InstructionChecksReport,
	destination: string,
): string {
	const lines: string[] = [
		`Coding instructions doctor: project ${sanitizeDisplayText(report.projectId, 128)} in ${sanitizeDisplayText(destination, 1024)}`,
		"",
	];
	const titleWidth =
		Math.max(...report.checks.map((check) => check.title.length)) + 2;
	for (const check of report.checks) {
		lines.push(
			`${SYMBOL[check.status]} ${check.title.padEnd(titleWidth)}${check.detail}`,
		);
		const items = check.items ?? [];
		const shown = items.slice(0, MAX_TEXT_ITEMS);
		if (shown.length > 0) {
			const nameWidth =
				Math.min(
					Math.max(...shown.map((item) => item.name.length)),
					40,
				) + 2;
			for (const item of shown) {
				lines.push(
					`    ${SYMBOL[item.status]} ${item.name.padEnd(nameWidth)}${item.detail ?? ""}`.trimEnd(),
				);
			}
			if (items.length > shown.length) {
				lines.push(
					`    … ${items.length - shown.length} more (--format json lists every one)`,
				);
			}
		}
		if (check.fix !== undefined) {
			if (check.fix.command !== undefined) {
				lines.push(`    fix: ${check.fix.command}`);
				lines.push(`         ${check.fix.description}`);
			} else {
				lines.push(`    fix: ${check.fix.description}`);
			}
		}
	}
	const { pass, fail, warn, skip } = report.summary;
	lines.push(
		"",
		`${pass} passed, ${fail} failed, ${plural(warn, "warning")}, ${skip} skipped`,
		"Fixes are proposals: doctor installed nothing, changed no credentials and wrote no files.",
	);
	return `${lines.join("\n")}\n`;
}
