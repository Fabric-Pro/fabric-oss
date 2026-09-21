/**
 * fabric instructions
 *
 *   fabric instructions check --project <id>   Is the local copy current?
 *   fabric instructions sync  --project <id>   Make it current.
 *   fabric instructions push  --project <id>   Suggest the local edits back.
 *   fabric instructions init  --project <id> --tool claude-code
 *                                             Take the first copy, then write the session hook.
 *
 * The first file-writing commands in this CLI. Everything that touches the
 * filesystem lives in `lib/instructions/` as small testable modules; this
 * file is argument parsing, the sequence, and the words a developer reads.
 *
 * `--hook` is the contract that makes this safe to run at session start: it
 * NEVER exits non-zero, it has ONE absolute deadline covering every request
 * it makes, and it never prints more than it has to. A coding session that
 * cannot start because Fabric is unreachable would be a far worse failure
 * than instructions that are one version stale.
 */
import path from "node:path";
import type { FabricClient, PublishedInstructions } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { getApiKey, getConfigPath } from "../../lib/config.js";
import { applyPlan } from "../../lib/instructions/apply.js";
import { extractBundle, fetchBundle } from "../../lib/instructions/bundle.js";
import {
	assertKeyStaysOutside,
	buildHookCommand,
	CLAUDE_SETTINGS_RELATIVE_PATH,
	mergeSessionStartHook,
} from "../../lib/instructions/hook.js";
import {
	type InstructionsLock,
	LOCK_DIRECTORY,
	lockPath,
	readLock,
	writeLock,
} from "../../lib/instructions/lock.js";
import {
	assertValidManifest,
	maxArchiveBytes,
} from "../../lib/instructions/manifest.js";
import {
	computeSyncPlan,
	nextLock,
	type SyncPlan,
	verifyLedger,
} from "../../lib/instructions/plan.js";
import {
	computePushPlan,
	MAX_PUSH_CHANGES,
} from "../../lib/instructions/push.js";
import {
	resolveDestinationRoot,
	resolveExistingRoot,
} from "../../lib/instructions/safe-write.js";
import { printOutput } from "../../lib/output.js";

/**
 * The whole of hook mode, end to end, including the bundle download.
 *
 * One ABSOLUTE deadline rather than one per request. The SDK's timeout is
 * per attempt and it retries twice by default, so three "5 second" calls
 * plus backoff is about 15.75 seconds — past the point where Claude Code
 * kills the hook itself, possibly mid-write. Retries are off in hook mode
 * and this bound covers everything.
 */
const HOOK_DEADLINE_MS = 10_000;

/** A manual check: no writes, so one short request and no more. */
const CHECK_TIMEOUT_MS = 5_000;

/** A manual sync may wait longer for the manifest, but not indefinitely. */
const SYNC_TIMEOUT_MS = 15_000;

/**
 * The archive, when a person is waiting rather than a session start — and the
 * request that ASKS for the archive, not just the transfer that follows it.
 *
 * `createDownloadUrl` is normally sub-second, because publishing a version
 * pre-builds its archive. When the pre-build did not happen (it failed, or
 * the object was swept) the server builds the zip inside that request, which
 * on a large tree takes far longer than any manifest read — and under the
 * manifest's 15-second budget the call timed out, retried, and each retry
 * started ANOTHER full build on the server rather than waiting for the first.
 * So the download-link call gets this budget and no retries.
 */
const BUNDLE_TIMEOUT_MS = 60_000;

/**
 * A push carries file bytes up and starts a validation run, so it waits longer
 * than the manifest calls do — and it gets ONE attempt, so the timeout is the
 * whole budget rather than a third of it.
 */
const PUSH_TIMEOUT_MS = 60_000;

/**
 * Commander's accumulator for a repeatable `--add`.
 *
 * Declared with an initial `[]`, so `previous` is always an array and this
 * never has to guess.
 */
function collectAdded(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/**
 * A failure that already knows which documented exit code it is
 * (`src/bin/fabric.ts`). Errors from the SDK are translated into one of
 * these at the boundary so the command bodies can just throw.
 */
class CliFailure extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
	) {
		super(message);
		this.name = "CliFailure";
	}
}

interface CommonOptions {
	project: string;
	dest?: string;
	org?: string;
	hook?: boolean;
	/**
	 * Declared for `--help` and read through `optsWithGlobals()`, never off
	 * this object: Commander stores a flag both a parent and a subcommand
	 * declare on the parent.
	 */
	format?: string;
}

type OutputFormat = "text" | "json";

export function buildInstructionsCommand(): Command {
	const instructions = new Command("instructions").description(
		"Keep a checkout current with a project's published coding instructions",
	);

	instructions
		.command("check")
		.description(
			"Report whether the local copy is behind the published one",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--verify",
			"Also hash the local files against the lock and report any that drifted",
		)
		.option(
			"--hook",
			"Session-hook mode: plain text, never fails, never blocks a session",
		)
		// No default: a default here would shadow the program-level --format,
		// which is where `FABRIC_FORMAT` enters.
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & { verify?: boolean },
		) {
			await run(opts, "check", () => runCheck(opts, formatFor(this)));
		});

	instructions
		.command("sync")
		.description(
			"Write the published coding instructions into the checkout",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option("--dry-run", "Print the plan and write nothing")
		.option(
			"--hook",
			"Session-hook mode: plain text, never fails, never blocks a session",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & { dryRun?: boolean },
		) {
			await run(opts, "sync", () => runSync(opts, formatFor(this)));
		});

	instructions
		.command("push")
		.description(
			"Suggest this checkout's edits to the project's coding instructions",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--add <path>",
			"Also send a file the last sync did not write (repeatable)",
			collectAdded,
			[] as string[],
		)
		.option("--dry-run", "Print the change set and send nothing")
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & {
				add?: string[];
				dryRun?: boolean;
			},
		) {
			// Never hook mode: a session start does not push. Stated rather
			// than inherited, because `run`'s never-fail branch exists for
			// commands a hook runs and this is not one.
			await run({ ...opts, hook: false }, "push", () =>
				runPush(opts, formatFor(this)),
			);
		});

	instructions
		.command("init")
		.description(
			"Write a SessionStart hook for a coding tool and take the first copy",
		)
		.requiredOption("--project <id>", "Project ID")
		.requiredOption(
			"--tool <tool>",
			"Coding tool to configure: claude-code",
		)
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--apply",
			"Let the hook apply changes instead of only reporting them",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & { tool: string; apply?: boolean },
		) {
			// Never hook mode: `init` is run by a person, so its failures
			// are real failures with real exit codes.
			await run({ ...opts, hook: false }, "init", () =>
				runInit(opts, formatFor(this)),
			);
		});

	return instructions;
}

// ---------------------------------------------------------------------------
// Output format
// ---------------------------------------------------------------------------

/**
 * The format this invocation should print in: `json`, or text.
 *
 * One reader, `optsWithGlobals()`, because Commander has already done the
 * resolving. The root command declares `--format` with a default of
 * `FABRIC_FORMAT ?? "table"`, these commands declare their own, and
 * `optsWithGlobals` merges them with the command's own value winning. Reading
 * `FABRIC_FORMAT` again here undid that: `FABRIC_FORMAT=json fabric --format
 * table instructions check` printed JSON at the very moment the flag said not
 * to (review round 2, finding 10).
 *
 * Anything that is not `json` prints text. `table`, `yaml` and `csv` are real
 * values elsewhere in this CLI and these commands have no such shape — one
 * paragraph or one JSON object — so they degrade rather than fail. Refusing
 * them here would also be a promise this cannot keep: when a parent and a
 * subcommand declare the same flag, Commander stores the value on the ROOT,
 * so `fabric instructions check --format yaml` never arrives as a local
 * option at all.
 */
function formatFor(command: Command): OutputFormat {
	const resolved = command.optsWithGlobals() as { format?: string };
	return resolved.format === "json" ? "json" : "text";
}

// ---------------------------------------------------------------------------
// The never-fail boundary
// ---------------------------------------------------------------------------

/**
 * One place where every failure is turned into either an exit code or, under
 * `--hook`, a single line on stderr and a zero exit.
 *
 * "Every" is literal: network, auth, HTTP, timeout, a bad lock file, a
 * refused path, a retired context default. Nothing inside may call
 * `process.exit` itself — `printError` does, and `process.exit` cannot be
 * caught here, which is why these commands build their own client rather than
 * reaching for the exiting helpers the other commands use, and why they read
 * no stored context at all.
 */
async function run(
	opts: { hook?: boolean },
	verb: string,
	body: () => Promise<void>,
): Promise<void> {
	try {
		if (opts.hook) {
			await withDeadline(HOOK_DEADLINE_MS, body);
		} else {
			await body();
		}
	} catch (error) {
		const message = describeError(error);
		if (opts.hook) {
			process.stderr.write(
				`fabric: coding instructions ${verb} skipped: ${message}\n`,
			);
			process.exit(0);
		}
		process.stderr.write(`✗ ${message}\n`);
		process.exit(error instanceof CliFailure ? error.exitCode : 1);
	}
}

/**
 * The absolute bound on hook mode.
 *
 * A race rather than a chain of per-request timeouts: the guarantee has to
 * hold whatever the SDK, the runtime or a wedged socket does, and only the
 * caller can promise that. The losing work is abandoned rather than awaited,
 * which is safe because the boundary above exits the process immediately
 * afterwards.
 */
async function withDeadline(
	totalMs: number,
	body: () => Promise<void>,
): Promise<void> {
	const controller = new AbortController();
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_resolve, reject) => {
		timer = setTimeout(() => {
			controller.abort();
			reject(
				new Error(
					`gave up after ${totalMs}ms so the session is not held up`,
				),
			);
		}, totalMs);
	});
	activeDeadline = controller.signal;
	try {
		await Promise.race([body(), deadline]);
	} finally {
		activeDeadline = undefined;
		if (timer) {
			clearTimeout(timer);
		}
	}
}

/**
 * The deadline signal in force, if any, so the bundle download can be
 * cancelled by the same clock that bounds the command. Module state rather
 * than a threaded parameter because every command body is single-shot within
 * one process.
 */
let activeDeadline: AbortSignal | undefined;

function describeError(error: unknown): string {
	if (error instanceof Error) {
		// Collapsed to one line: under `--hook` this lands in a terminal
		// banner and, on Claude Code, in the agent's context.
		return error.message.replace(/\s*\n\s*/g, " ");
	}
	return String(error);
}

/**
 * SDK errors carry an HTTP status; the CLI's documented exit codes do not
 * come from it automatically. Mapped once, here.
 */
function asCliFailure(error: unknown): CliFailure {
	if (error instanceof CliFailure) {
		return error;
	}
	const status = (error as { status?: number }).status;
	const message = error instanceof Error ? error.message : String(error);
	switch (status) {
		case 401:
			return new CliFailure(message, 3);
		case 403:
			return new CliFailure(message, 5);
		case 404:
			return new CliFailure(message, 4);
		case 429:
			return new CliFailure(message, 6);
		case 400:
		case 422:
			return new CliFailure(message, 7);
		default:
			return new CliFailure(message, 1);
	}
}

// ---------------------------------------------------------------------------
// Shared steps
// ---------------------------------------------------------------------------

function destinationOf(opts: { dest?: string }): string {
	return path.resolve(opts.dest ?? process.cwd());
}

/**
 * A client that throws instead of exiting, and that never retries in hook
 * mode.
 *
 * `getClient` calls `printError`, which exits with code 3 — correct for every
 * other command and fatal to the `--hook` contract, which must never exit
 * non-zero for any reason.
 */
function instructionsClient(
	opts: { hook?: boolean },
	timeoutMs: number,
	{ neverRetry = false }: { neverRetry?: boolean } = {},
): FabricClient {
	if (!getApiKey()) {
		throw new CliFailure(
			"Not authenticated. Run: fabric auth login --key <api-key>",
			3,
		);
	}
	// `withoutContext()`: the SDK constructor adopts `FABRIC_ORG` /
	// `FABRIC_PERSONAL` and injects them into every URL that does not name a
	// context. On a project-authoritative surface that ambient default is not
	// a default, it is a contradiction waiting to be refused — see
	// `orgSlugFor`.
	return getClient(
		opts.hook
			? {
					// Hook mode has ONE absolute deadline covering every
					// call it makes, so it cannot spend it on retries: a
					// session that will not start is worse than instructions
					// one version stale.
					timeoutMs: Math.min(timeoutMs, HOOK_DEADLINE_MS),
					retry: { maxRetries: 0 },
				}
			: neverRetry
				? { timeoutMs, retry: { maxRetries: 0 } }
				: { timeoutMs },
	).withoutContext();
}

/**
 * A separate client for `createDownloadUrl`, because that one call is not a
 * manifest read.
 *
 * It gets the BUNDLE budget. Publishing a version pre-builds its archive, so
 * this is normally sub-second — but when the archive is not there the server
 * builds it inside this request, which on a large tree runs well past the
 * manifest timeout. Sharing the manifest client meant a sync of a brand-new
 * version failed with "Request timed out after 15000ms".
 *
 * `neverRetry: true` is belt-and-suspenders here, not load-bearing: the SDK's
 * `createDownloadUrl` itself now sends `{ maxRetries: 0 }` on every call
 * (`packages/sdk/src/resources/instructions.ts`), because a retry of this
 * route does not wait for the build already running on the server — it starts
 * a second, and then a third, of the same archive. Kept here so this client
 * stays never-retry even if `createDownloadUrl` is ever swapped for a call
 * that does not make that guarantee itself.
 */
function downloadUrlClient(opts: { hook?: boolean }): FabricClient {
	return instructionsClient(
		opts,
		opts.hook ? HOOK_DEADLINE_MS : BUNDLE_TIMEOUT_MS,
		{ neverRetry: true },
	);
}

/**
 * The org slug to send: the one on the command line, or none at all.
 *
 * These commands are PROJECT-AUTHORITATIVE — the project decides which
 * organization it is in, and the route resolves that from the project itself.
 * Sending a stored default context (or `FABRIC_ORG`) turned that resolution
 * into a contradiction for anyone whose default is not the project's host
 * organization, and the clearest case is the one the route exists to support:
 * an invited guest, whose own default organization is never the one hosting a
 * project they were invited to. Their request carried `?org=<their own org>`,
 * the route compared it with the project's, and refused.
 *
 * So the ambient default is not consulted here and the client is built
 * without one. `--org` remains available for the caller who wants the request
 * bound explicitly; an explicit slug that disagrees with the project is still
 * a 404, which is the point of passing it.
 */
function orgSlugFor(opts: CommonOptions): string | undefined {
	return opts.org;
}

async function fetchPublished(
	client: FabricClient,
	opts: CommonOptions,
	sinceDigest?: string,
): Promise<PublishedInstructions> {
	const org = orgSlugFor(opts);
	let published: PublishedInstructions;
	try {
		published = await client.instructions.getPublished(opts.project, {
			org,
			sinceDigest,
		});
	} catch (error) {
		throw asCliFailure(error);
	}
	assertHookMayAct(opts, published);
	return published;
}

/**
 * A hook may not act on a project whose instructions come from git.
 *
 * Asserted on EVERY response rather than on the first one, because a command
 * can make two calls: a delta answer, and then — when the local tree has
 * drifted — a full refetch. Checking only the first meant a project switched
 * to `REPOSITORY` between the two was planned, downloaded and applied by a
 * hook, which is the second writer `init` refuses to create.
 *
 * `init` refuses such a project outright; a person running `sync` or `check`
 * by hand is unaffected, because for someone without access to that
 * repository a download is the only way to read the instructions at all.
 */
function assertHookMayAct(
	opts: { hook?: boolean },
	published: PublishedInstructions,
): void {
	if (opts.hook && published.sourceOfTruth === "REPOSITORY") {
		throw new CliFailure(
			"this project's instructions now come from a git repository; run `fabric instructions init` again or remove the hook",
			4,
		);
	}
}

/**
 * The lock, refused when it belongs to a different project.
 *
 * A lock is a per-destination file and a destination holds one project's
 * tree. `sync --project B` in a directory synced from project A would
 * otherwise send A's digest, receive B's manifest, and then use A's ledger to
 * decide what to delete — classifying every A-only file as "the sync wrote
 * this, remove it". Equal digests across the two could even report "up to
 * date" for a tree that holds the wrong project's instructions entirely.
 */
async function readLockForProject(
	destination: string,
	projectId: string,
): Promise<InstructionsLock | null> {
	const lock = await readLock(destination);
	if (lock !== null && lock.projectId !== projectId) {
		throw new CliFailure(
			`${lockPath(destination)} belongs to project ${lock.projectId}, not ${projectId}. Use a different --dest, or remove that lock if this directory should now follow ${projectId}.`,
			7,
		);
	}
	return lock;
}

function line(text: string): void {
	process.stdout.write(`${text}\n`);
}

function listPaths(label: string, paths: string[]): void {
	if (paths.length === 0) {
		return;
	}
	line(`  ${label}:`);
	for (const p of paths) {
		line(`    ${p}`);
	}
}

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

async function runCheck(
	opts: CommonOptions & { verify?: boolean },
	format: OutputFormat,
): Promise<void> {
	const destination = destinationOf(opts);
	// Canonical, but NOT created: `check` is informational and must not make a
	// directory as a side effect. Every guarded read resolves against this,
	// and a literal path would refuse legitimately — `/tmp` is a symlink on
	// macOS, so the string a user passes and the directory they mean differ.
	const root = await resolveExistingRoot(destination);
	const lock = await readLockForProject(destination, opts.project);
	const client = instructionsClient(opts, CHECK_TIMEOUT_MS);
	const published = await fetchPublished(client, opts, lock?.digest);

	// Deliberately NOT validated against `assertValidManifest`: `check`
	// writes nothing, so a skewed manifest here can only produce a less
	// useful report, and refusing would make the informational command the
	// fragile one. `sync` validates before it can act on it.

	// Off by default, and that is the trade rather than an oversight: this is
	// the command a session start runs, one request and no local reads. With
	// `--verify` it also hashes every file the lock names, which is what
	// answers "is my checkout still what was published" as opposed to "has
	// the published version moved". `sync` always does this.
	const drifted =
		opts.verify && lock !== null ? await verifyLedger({ root, lock }) : [];

	if (format === "json") {
		printOutput(
			{
				projectId: opts.project,
				destination,
				synced: lock !== null,
				localDigest: lock?.digest ?? null,
				verified: Boolean(opts.verify),
				drifted,
				...published,
			},
			{ format: "json" },
		);
		return;
	}

	reportPublishedState(opts, destination, lock, published);

	// The common tail. Every text-mode branch returns through here, because
	// `--verify` promises to report local drift and three of those branches
	// used to return before saying a word about it.
	if (opts.verify) {
		reportDrift(opts, destination, drifted);
	}
}

/** What the server said about the published snapshot, in text. */
function reportPublishedState(
	opts: CommonOptions,
	destination: string,
	lock: InstructionsLock | null,
	published: PublishedInstructions,
): void {
	if (!published.published) {
		line("This project has no published coding instructions yet.");
		return;
	}

	const version = published.snapshot?.version;

	if (!lock) {
		line(
			`Coding instructions have not been synced into ${destination} yet (published version ${version}, ${published.snapshot?.fileCount} files).`,
		);
		line(
			`Run \`fabric instructions sync --project ${opts.project}\` to take a copy.`,
		);
		return;
	}

	if (published.unchanged) {
		// "the published version has not moved" — NOT "your files are
		// correct". Without `--verify` nothing local has been read at all, and
		// saying "up to date" invited exactly the wrong conclusion.
		line(`Published coding instructions unchanged (version ${version}).`);
		return;
	}

	if (published.changes === null || published.changes === undefined) {
		line(
			`Coding instructions changed, and the version in ${destination} is not one the server still recognises, so what changed cannot be listed. A full sync is needed (published version ${version}).`,
		);
		line(
			`Run \`fabric instructions sync --project ${opts.project}\` to apply.`,
		);
		return;
	}

	const { added, changed, removed } = published.changes;
	line(
		`Coding instructions updated: ${added.length} added, ${changed.length} changed, ${removed.length} removed (version ${version}).`,
	);
	listPaths("added", added);
	listPaths("changed", changed);
	listPaths("removed", removed);
	line(
		`Run \`fabric instructions sync --project ${opts.project}\` to apply.`,
	);
}

/** What `--verify` found, in the two places the report can end. */
function reportDrift(
	opts: CommonOptions,
	destination: string,
	drifted: string[],
): void {
	if (drifted.length === 0) {
		line(`Every file in ${destination} matches the lock.`);
		return;
	}
	line(`${drifted.length} local file(s) no longer match the lock:`);
	listPaths("drifted", drifted);
	line(
		`Run \`fabric instructions sync --project ${opts.project}\` to put them back.`,
	);
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function runSync(
	opts: CommonOptions & { dryRun?: boolean },
	format: OutputFormat,
): Promise<void> {
	const result = await syncOnce(opts);
	if (format === "json") {
		printOutput(result, { format: "json" });
		return;
	}
	reportSync(result, opts);
}

interface SyncOutcome {
	projectId: string;
	destination: string;
	published: boolean;
	unchanged: boolean;
	dryRun: boolean;
	version: number | null;
	digest: string | null;
	added: string[];
	updated: string[];
	replaced: string[];
	removed: string[];
	keptModified: string[];
	/**
	 * Paths the lock still names under an old spelling that the manifest now
	 * spells differently. Reported rather than removed: on a case-insensitive
	 * filesystem they ARE the file the sync just wrote.
	 */
	keptRenamed: string[];
	/**
	 * Paths the lock claimed that the working tree no longer matched, when the
	 * published snapshot itself had not moved. Non-empty means this run
	 * repaired local drift rather than applying a new version.
	 */
	drifted: string[];
	verified: number;
	lockPath: string;
}

function emptyOutcome(
	opts: CommonOptions & { dryRun?: boolean },
	destination: string,
): SyncOutcome {
	return {
		projectId: opts.project,
		destination,
		published: true,
		unchanged: false,
		dryRun: Boolean(opts.dryRun),
		version: null,
		digest: null,
		added: [],
		updated: [],
		replaced: [],
		removed: [],
		keptModified: [],
		keptRenamed: [],
		drifted: [],
		verified: 0,
		lockPath: lockPath(destination),
	};
}

async function syncOnce(
	opts: CommonOptions & { dryRun?: boolean; rejectRepository?: boolean },
): Promise<SyncOutcome> {
	// Canonical from here on: every write resolves against this, so a
	// symlinked `--dest` (or `/tmp` on macOS) is decided once rather than at
	// each write.
	const root = await resolveDestinationRoot(destinationOf(opts));
	const outcome = emptyOutcome(opts, root);

	const lock = await readLockForProject(root, opts.project);
	const client = instructionsClient(opts, SYNC_TIMEOUT_MS);
	let published = await fetchPublished(client, opts, lock?.digest);
	assertInitSyncMayAct(opts, published);

	// Hook mode rejects repository-backed instructions in `fetchPublished`;
	// init's first sync performs the same check above so its drift refetch does
	// not trust only the first response.

	if (!published.published || !published.snapshot) {
		// A real failure for a person who asked for a copy; the `--hook`
		// boundary turns it into one quiet line for a session start.
		throw new CliFailure(
			"This project has no published coding instructions yet.",
			4,
		);
	}

	outcome.version = published.snapshot.version;
	outcome.digest = published.snapshot.digest;

	if (published.unchanged) {
		// "Unchanged" is the SERVER's answer about the SNAPSHOT, and it says
		// nothing about the checkout. Accepting it as "nothing to do" let an
		// edited, deleted or chmod-ed instruction file stay that way until
		// some later publication happened to move the digest — so a tampered
		// tree reported success indefinitely. The ledger is the local half of
		// the question, and hashing it is the price of a command that applies
		// things.
		const drifted = lock === null ? [] : await verifyLedger({ root, lock });
		if (drifted.length === 0) {
			outcome.unchanged = true;
			return outcome;
		}

		outcome.drifted = drifted;
		// The first call answered with a delta and therefore carries no
		// manifest. Ask again without a base digest: the plan needs the whole
		// published list to put the tree back.
		published = await fetchPublished(client, opts);
		assertInitSyncMayAct(opts, published);
		if (!published.published || !published.snapshot) {
			throw new CliFailure(
				"This project has no published coding instructions yet.",
				4,
			);
		}
		outcome.version = published.snapshot.version;
		outcome.digest = published.snapshot.digest;
	}

	// An absent manifest is a refusal, never an empty one. `[]` means
	// "delete everything the lock names", so a version-skewed or truncated
	// response was one step from emptying the tree and writing a ledger that
	// agreed with it.
	const manifest = assertValidManifest({
		manifest: published.manifest,
		snapshot: published.snapshot,
	});

	const plan = await computeSyncPlan({ destination: root, manifest, lock });
	fillPlanPaths(outcome, plan);

	if (opts.dryRun) {
		// The plan is computable from the manifest alone, so a dry run
		// downloads nothing at all.
		return outcome;
	}

	let contents = new Map<string, Uint8Array>();
	if (plan.writes.length > 0) {
		const org = orgSlugFor(opts);
		let download: { url: string };
		try {
			download = await downloadUrlClient(
				opts,
			).instructions.createDownloadUrl(opts.project, { org });
		} catch (error) {
			throw asCliFailure(error);
		}
		const sizes = new Map(
			manifest.map((entry) => [entry.path, entry.size] as const),
		);
		const archive = await fetchBundle(download.url, {
			timeoutMs: opts.hook ? HOOK_DEADLINE_MS : BUNDLE_TIMEOUT_MS,
			// Bounded by what this manifest says it holds, not by what the
			// response claims. The manifest has already been checked against
			// the published snapshot limits, so this is a number the client
			// decided.
			maxBytes: maxArchiveBytes(manifest),
			// In hook mode the same clock that bounds the command bounds the
			// download, rather than a second independent budget after it.
			signal: activeDeadline,
		});
		contents = extractBundle(
			archive,
			plan.writes.map((entry) => ({
				path: entry.path,
				size: sizes.get(entry.path) ?? -1,
			})),
		);
	}

	const applied = await applyPlan({ root, plan, contents });
	// What actually happened, not what was planned: a delete whose file was
	// edited between planning and the unlink is reported as kept, because that
	// is what it is.
	outcome.removed = applied.deleted;
	outcome.keptModified = [
		...outcome.keptModified,
		...applied.keptModified,
	].sort();

	// Last, and only now: a lock written before the files would claim
	// ownership of paths that are not there, and the next run would delete
	// whatever the developer had in their place.
	const lockToWrite: InstructionsLock = nextLock({
		projectId: opts.project,
		snapshot: {
			id: published.snapshot.id,
			version: published.snapshot.version,
			digest: published.snapshot.digest,
		},
		manifest,
	});
	await writeLock(root, lockToWrite);

	return outcome;
}

/**
 * `init` uses a manual sync for its first copy, but it must still reject a
 * project that switches to repository-backed instructions during that sync.
 * Keeping this distinct from hook mode preserves manual `sync` behavior.
 */
function assertInitSyncMayAct(
	opts: { rejectRepository?: boolean },
	published: PublishedInstructions,
): void {
	if (opts.rejectRepository && published.sourceOfTruth === "REPOSITORY") {
		throw new CliFailure(
			"This project's coding instructions come from its repository, so they arrive with `git pull`. A session hook would fight it; nothing was written.",
			7,
		);
	}
}

function fillPlanPaths(outcome: SyncOutcome, plan: SyncPlan): void {
	outcome.added = plan.entries
		.filter((entry) => entry.action === "added")
		.map((entry) => entry.path);
	outcome.updated = plan.entries
		.filter((entry) => entry.action === "updated")
		.map((entry) => entry.path);
	outcome.replaced = plan.entries
		.filter((entry) => entry.action === "replaced")
		.map((entry) => entry.path);
	outcome.removed = plan.deletes.map((entry) => entry.path);
	outcome.keptModified = plan.keptModified.map((entry) => entry.path);
	outcome.keptRenamed = plan.keptRenamed.map((entry) => entry.path);
	outcome.verified = plan.verified.length;
}

function reportSync(
	outcome: SyncOutcome,
	opts: CommonOptions & { dryRun?: boolean },
): void {
	if (outcome.unchanged) {
		line(
			`Coding instructions are up to date (version ${outcome.version}).`,
		);
		return;
	}

	const total =
		outcome.added.length +
		outcome.updated.length +
		outcome.replaced.length +
		outcome.removed.length;
	if (outcome.drifted.length > 0) {
		line(
			`Coding instructions version ${outcome.version} is still the published one, but ${outcome.drifted.length} local file(s) no longer match it:`,
		);
		listPaths("drifted", outcome.drifted);
	}

	const prefix = opts.dryRun ? "Would apply" : "Applied";
	line(
		`${prefix} coding instructions version ${outcome.version}: ${outcome.added.length} added, ${outcome.updated.length} updated, ${outcome.replaced.length} replaced, ${outcome.removed.length} removed (${outcome.verified} already current).`,
	);
	listPaths("added", outcome.added);
	listPaths("updated", outcome.updated);
	listPaths("replaced local edits", outcome.replaced);
	listPaths("removed", outcome.removed);
	listPaths("kept, modified locally", outcome.keptModified);
	listPaths("kept, renamed in the published snapshot", outcome.keptRenamed);
	if (!opts.dryRun) {
		line(`Lock: ${outcome.lockPath}`);
	}
	if (
		total === 0 &&
		outcome.keptModified.length === 0 &&
		outcome.keptRenamed.length === 0
	) {
		line(`Everything in ${outcome.destination} already matched.`);
	}
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

interface PushOutcome {
	projectId: string;
	destination: string;
	dryRun: boolean;
	/** The snapshot the change set was stated against — the lock's. */
	baseSnapshotId: string;
	baseVersion: number;
	put: string[];
	deleted: string[];
	unchanged: number;
	/** Null on a dry run; otherwise what the server made of it. */
	snapshotId: string | null;
	version: number | null;
	proposalStatus: string | null;
	status: string | null;
}

/**
 * Suggest the checkout's edits back to the project.
 *
 * It always opens a PROPOSAL. There is no `--publish`: the key this command
 * uses carries `instructions:write`, which is offered to read-only roles and
 * described as review-gated, and a publish flag would make that description
 * false for anyone whose account happens to hold the publishing permission.
 * Publishing from a terminal needs a scope of its own.
 *
 * The diff is computed against `.fabric/instructions.lock` — the snapshot the
 * last sync applied — and that snapshot id is sent as the base. A push whose
 * base is no longer the published version is REFUSED rather than rebased: the
 * spec's `PULL_FIRST` rule (§6.12), and the reason there is no server-side
 * merge in any version.
 *
 * The published manifest is fetched FIRST, and it decides two things before a
 * file is opened: whether the lock still names the published version, and
 * whether the lock's ledger is that version. The lock is a plain JSON file in
 * the checkout, so anything that can write to the working tree can add a path
 * to it — and a command that read its ledger on trust would read and upload
 * whatever was added. See `computePushPlan`.
 *
 * The lock is NOT rewritten, on any outcome. A proposal changes nothing about
 * what is published, so a lock claiming otherwise would make the next `sync`
 * believe this checkout already held a version nobody has approved.
 */
async function runPush(
	opts: CommonOptions & {
		add?: string[];
		dryRun?: boolean;
	},
	format: OutputFormat,
): Promise<void> {
	// Canonical but NOT created: push reads the tree, and a command that makes
	// a directory in order to discover it is empty is doing the wrong thing.
	const destination = destinationOf(opts);
	const root = await resolveExistingRoot(destination);
	const lock = await readLockForProject(root, opts.project);
	if (lock === null) {
		throw new CliFailure(
			`No coding-instructions lock in ${destination}. Run \`fabric instructions sync --project ${opts.project}\` first: a push is a diff against the version that was last applied here, and without that ledger there is nothing to diff against.`,
			7,
		);
	}

	// The SDK's ordinary retry policy. Retries used to be off here: the change
	// route wrote a snapshot row per POST, so a push whose response was lost
	// opened a second proposal for one edit. The route now recognises a change
	// set it has already admitted and answers with the proposal it opened, so
	// a retry repairs a dropped response instead of duplicating it.
	const client = instructionsClient(
		{ ...opts, hook: false },
		PUSH_TIMEOUT_MS,
	);

	// BEFORE any file is read. Two questions, both answered by this one call:
	// is the lock still the published version, and is its ledger actually
	// that version's manifest.
	const published = await fetchPublished(client, opts);
	if (!published.published || !published.snapshot) {
		throw new CliFailure(
			"this project has no published coding instructions to change yet; the first version is uploaded from the Coding Instructions tab",
			4,
		);
	}
	if (published.snapshot.id !== lock.snapshotId) {
		// Exactly what the server would answer, decided locally so nothing is
		// read or sent first.
		throw new CliFailure(
			"published instructions moved past your last sync; run `fabric instructions sync` then push again",
			7,
		);
	}

	const plan = await computePushPlan({
		root,
		lock,
		manifest: published.manifest ?? [],
		added: opts.add,
	});

	if (plan.changes.length === 0) {
		throw new CliFailure(
			`Nothing to push: every file the last sync wrote still matches version ${lock.snapshotVersion}. Add a new file with --add <path> if you meant to suggest one.`,
			7,
		);
	}
	if (plan.changes.length > MAX_PUSH_CHANGES) {
		throw new CliFailure(
			`Too many changes to push (${plan.changes.length} > ${MAX_PUSH_CHANGES}). A change set this large is a replacement rather than an edit — upload the folder from the project's Coding Instructions tab, which is also the only path that re-reads the project's exclusion rules.`,
			7,
		);
	}

	const outcome: PushOutcome = {
		projectId: opts.project,
		destination: root,
		dryRun: Boolean(opts.dryRun),
		baseSnapshotId: lock.snapshotId,
		baseVersion: lock.snapshotVersion,
		put: plan.entries
			.filter((entry) => entry.action === "put")
			.map((entry) => entry.path),
		deleted: plan.entries
			.filter((entry) => entry.action === "delete")
			.map((entry) => entry.path),
		unchanged: plan.unchanged.length,
		snapshotId: null,
		version: null,
		proposalStatus: null,
		status: null,
	};

	if (!opts.dryRun) {
		try {
			const submitted = await client.instructions.submitChange(
				opts.project,
				lock.snapshotId,
				plan.changes,
				{ org: orgSlugFor(opts) },
			);
			outcome.snapshotId = submitted.snapshotId;
			outcome.version = submitted.version;
			outcome.proposalStatus = submitted.proposalStatus;
			outcome.status = submitted.status;
		} catch (error) {
			throw asPushFailure(error);
		}
	}

	if (format === "json") {
		printOutput(outcome, { format: "json" });
		return;
	}
	reportPush(outcome);
}

/**
 * The refusals a push has to say something useful about, by the reason code
 * the route sends (`packages/api/modules/v1/instructions.ts`).
 *
 * Everything else falls through to `asCliFailure`'s status mapping, which is
 * already right for auth, permission and rate limits.
 */
function asPushFailure(error: unknown): CliFailure {
	const code = (error as { code?: string }).code;
	const message = error instanceof Error ? error.message : String(error);
	switch (code) {
		case "PULL_FIRST":
			return new CliFailure(
				"published instructions moved past your last sync; run `fabric instructions sync` then push again",
				7,
			);
		case "REPOSITORY_SOURCE_OF_TRUTH":
			return new CliFailure(
				"this project's coding instructions come from its repository, so they are changed there and mirrored into Fabric — commit and push to the repository instead; nothing was sent",
				7,
			);
		case "NOTHING_PUBLISHED":
			return new CliFailure(
				"this project has no published coding instructions to change yet; the first version is uploaded from the Coding Instructions tab",
				4,
			);
		case "PROPOSAL_PROPOSER_LIMIT":
		case "PROPOSAL_PROJECT_LIMIT":
			return new CliFailure(`${message} Nothing was sent.`, 7);
		default:
			return asCliFailure(error);
	}
}

/**
 * The one sentence a completed push ends on.
 *
 * A push that repeats an earlier one is answered with the proposal that one
 * opened, so this has to read every state that proposal can be in — not just
 * the fresh-proposal case. The rule each branch obeys: NEVER advise an action
 * the server's content dedup will swallow. A proposal still PENDING is exactly
 * what the next push would match, so those branches describe the state or name
 * the one thing that changes it, and "push again" appears only once the
 * proposal has stopped being PENDING.
 */
function pushVerdict(outcome: PushOutcome): string {
	// The row is still receiving bytes: an earlier attempt at this same change
	// is mid-flight. No push closes it out at any age — the browser tab opens
	// proposals through the same query and keeps its upload capabilities for
	// an hour, so a row that looks stalled from here may be one somebody is
	// still filling. What does move it: its proposer can cancel it in the tab
	// (a RECEIVING proposal is cancellable), and the reaper closes an
	// abandoned one after six hours.
	if (
		outcome.proposalStatus === "PENDING" &&
		outcome.status === "RECEIVING"
	) {
		return `An earlier attempt is still sending this change; if version ${outcome.version} stays unfinished, cancel it in the project's Coding Instructions tab, or leave it and it is closed out automatically after six hours.`;
	}
	// Its checks failed, and it stays PENDING — so the next push dedups
	// straight back onto it. The tab's "Try again" is the only thing that
	// moves it, which is why no push is offered here. Both of these branches
	// require PENDING: a row that vanished after the finalizer reports
	// `proposalStatus: null` beside the finalizer's last status, and telling
	// the user to retry or cancel a version that no longer exists would be
	// wrong — that case falls through to "push again", which is right.
	if (outcome.proposalStatus === "PENDING" && outcome.status === "FAILED") {
		return `This proposal did not pass its checks; retry version ${outcome.version} from the project's Coding Instructions tab.`;
	}
	if (outcome.proposalStatus === "PENDING") {
		// Unreachable in practice — the gate closes a rejected proposal's
		// review state in the same transaction — but a PENDING row is one the
		// dedup matches, so the advice has to be the thing that clears it.
		if (outcome.status === "REJECTED") {
			return `Version ${outcome.version} was rejected by its checks — cancel it in the project's Coding Instructions tab before proposing this change again.`;
		}
		return `Proposed as version ${outcome.version}. It is pending review — nothing is published until somebody who can edit this project's coding instructions approves it in the Coding Instructions tab.`;
	}
	if (outcome.proposalStatus === "APPROVED") {
		return `Version ${outcome.version} has already been approved and published — run \`fabric instructions sync\` to bring this checkout up to it.`;
	}
	return `Version ${outcome.version} is no longer open for review (${outcome.proposalStatus ?? outcome.status}): an earlier attempt at this same change was closed out, so push again.`;
}

function reportPush(outcome: PushOutcome): void {
	const prefix = outcome.dryRun ? "Would send" : "Sent";
	line(
		`${prefix} ${outcome.put.length} changed file(s) and ${outcome.deleted.length} deletion(s) against version ${outcome.baseVersion} (${outcome.unchanged} unchanged).`,
	);
	listPaths("changed", outcome.put);
	listPaths("deleted", outcome.deleted);

	if (outcome.dryRun) {
		line(
			"Nothing was sent. Without --dry-run this would open a proposal for review.",
		);
		return;
	}

	line(pushVerdict(outcome));
	line(
		"Your lock was not changed: it still names the published version, which is what `fabric instructions sync` compares against.",
	);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function runInit(
	opts: CommonOptions & { tool: string; apply?: boolean },
	format: OutputFormat,
): Promise<void> {
	if (opts.tool !== "claude-code") {
		throw new CliFailure(
			`Unsupported tool "${opts.tool}". Only --tool claude-code is supported today; other tools follow.`,
			2,
		);
	}

	const root = await resolveDestinationRoot(destinationOf(opts));

	// Two local preconditions, both answered before any network call: a lock
	// that belongs to another project, and a credential file that would end
	// up inside the checkout. Neither needs the server to decide, and making
	// a reader wait on a request to learn about them is backwards.
	await readLockForProject(root, opts.project);
	try {
		await assertKeyStaysOutside(root, getConfigPath());
	} catch (error) {
		throw new CliFailure(describeError(error), 7);
	}

	const client = instructionsClient(opts, SYNC_TIMEOUT_MS);
	const published = await fetchPublished(client, opts);

	if (published.sourceOfTruth === "REPOSITORY") {
		// A sync hook on a repository-backed project would fight `git pull`:
		// the files arrive through the repository, and two writers with no
		// merge between them is worse than one.
		throw new CliFailure(
			"This project's coding instructions come from its repository, so they arrive with `git pull`. A session hook would fight it; nothing was written.",
			7,
		);
	}

	const outcome = published.published
		? // A second manifest call, deliberately: the one above answered "may
			// a hook be installed for this project at all", and this one is the
			// sync's own. Do it before the hook write: a failed first copy must
			// not leave a new or updated hook behind.
			await syncOnce({ ...opts, hook: false, rejectRepository: true })
		: null;

	const command = buildHookCommand(
		opts.project,
		Boolean(opts.apply),
		opts.org,
	);
	const merged = await mergeSessionStartHook({
		root,
		projectId: opts.project,
		command,
	});

	if (format === "json") {
		printOutput(
			{
				projectId: opts.project,
				destination: root,
				settingsPath: merged.settingsPath,
				hookCommand: merged.command,
				createdSettingsFile: merged.createdFile,
				replacedHooks: merged.replacedCount,
				sync: outcome,
			},
			{ format: "json" },
		);
		return;
	}

	line(
		merged.replacedCount > 0
			? `Updated the SessionStart hook in ${merged.settingsPath}.`
			: `Added a SessionStart hook to ${merged.settingsPath}.`,
	);
	line(`  ${command}`);
	line(
		opts.apply
			? "  It applies changes at session start."
			: "  It only reports changes; add --apply to init to have it apply them.",
	);

	if (outcome === null) {
		line(
			"This project has nothing published yet, so there is nothing to copy — the hook will pick it up once there is.",
		);
	} else {
		line("");
		reportSync(outcome, opts);
	}

	line("");
	line(
		`${CLAUDE_SETTINGS_RELATIVE_PATH} and ${LOCK_DIRECTORY}/ are local to this machine. If this repository does not ignore them already, add them to your own ignore rules — this command does not edit .gitignore.`,
	);
}
