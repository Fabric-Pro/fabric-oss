/**
 * fabric instructions
 *
 *   fabric instructions check --project <id>   Is the local copy current?
 *   fabric instructions doctor --project <id>  Is this machine set up the way the
 *                                             instructions expect? Reads only; runs nothing.
 *   fabric instructions sync  --project <id>   Make it current.
 *   fabric instructions push  --project <id>   Suggest the local edits back.
 *   fabric instructions init  --project <id> --tool claude-code|codex
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
import type {
	FabricClient,
	ProposalPullRequest,
	ProposalPullRequestFailure,
	PublishedInstructions,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import {
	asCliFailure,
	CliFailure,
	describeError,
	type OutputFormat,
	outputFormatFor,
	withDeadline,
} from "../../lib/command-boundary.js";
import { getApiKey, getConfigPath } from "../../lib/config.js";
import { applyPlan } from "../../lib/instructions/apply.js";
import { extractBundle, fetchBundle } from "../../lib/instructions/bundle.js";
import {
	buildFabricCommand,
	formatDoctorText,
	runDoctor,
} from "../../lib/instructions/doctor.js";
import {
	assertKeyStaysOutside,
	buildHookCommand,
	buildLessonPromptCommand,
	CLAUDE_SETTINGS_RELATIVE_PATH,
	CODEX_HOOKS_RELATIVE_PATH,
	type InstructionsHookTool,
	mergeCommandHook,
	mergeSessionStartHook,
	removeCommandHook,
} from "../../lib/instructions/hook.js";
import {
	readAllStdin,
	runLessonPrompt,
} from "../../lib/instructions/lesson-prompt.js";
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
	describeLedgerDrift,
	findLedgerDrift,
	type LedgerDrift,
	nextLock,
	reconcileKeptInLock,
	type SyncPlan,
} from "../../lib/instructions/plan.js";
import {
	type PullRequestWait,
	splitMessage,
	waitForPullRequest,
} from "../../lib/instructions/pull-request-wait.js";
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
			await run(opts, "check", () =>
				runCheck(opts, outputFormatFor(this)),
			);
		});

	instructions
		.command("doctor")
		.description(
			"Check whether this machine is set up the way the project's coding instructions expect",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--probe-network",
			"Also send one HTTP GET to each url server in .mcp.json to see whether it answers",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & { probeNetwork?: boolean },
		) {
			// Never hook mode: doctor is run by a person (or an agent acting
			// for one), and a failed check is a real exit code.
			await run({ ...opts, hook: false }, "doctor", () =>
				runDoctorCommand(opts, outputFormatFor(this)),
			);
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
			"--repair",
			"Replace local edits to synced files with the published version; without it, sync keeps them",
		)
		.option(
			"--hook",
			"Session-hook mode: plain text, never fails, never blocks a session",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & { dryRun?: boolean; repair?: boolean },
		) {
			await run(opts, "sync", () => runSync(opts, outputFormatFor(this)));
		});

	instructions
		.command("push")
		.description(
			"Propose this checkout's edits to the project's coding instructions, or publish them with --publish",
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
		.option(
			"--publish",
			"Publish the change as a new version instead of proposing it (needs a key with instructions:publish)",
		)
		.option(
			"--message <text>",
			"Title (first line) and description of the suggested change",
		)
		.option(
			"--no-wait",
			"Return as soon as the suggestion is accepted, without waiting for its pull request",
		)
		.option("--dry-run", "Print the change set and send nothing")
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & {
				add?: string[];
				publish?: boolean;
				message?: string;
				wait?: boolean;
				dryRun?: boolean;
			},
		) {
			// Never hook mode: a session start does not push. Stated rather
			// than inherited, because `run`'s never-fail branch exists for
			// commands a hook runs and this is not one.
			await run({ ...opts, hook: false }, "push", () =>
				runPush(opts, outputFormatFor(this)),
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
			"Coding tool to configure: claude-code|codex",
		)
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--apply",
			"Let the hook apply changes instead of only reporting them",
		)
		.option(
			"--lessons",
			"Also install a Stop hook that asks, once per session after the assistant has edited files, whether a mistake from the session should become a team lesson",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: CommonOptions & {
				tool: string;
				apply?: boolean;
				lessons?: boolean;
			},
		) {
			// Never hook mode: `init` is run by a person, so its failures
			// are real failures with real exit codes.
			await run({ ...opts, hook: false }, "init", () =>
				runInit(opts, outputFormatFor(this)),
			);
		});

	instructions
		.command("lesson-prompt", { hidden: true })
		.description(
			"Stop hook: ask, once per session, whether a mistake should become a team lesson",
		)
		.option("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option(
			"--hook",
			"Stop-hook mode: reads JSON from stdin, never fails, never prints unless it is asking",
		)
		.action(
			async (opts: {
				project?: string;
				org?: string;
				hook?: boolean;
			}) => {
				await runLessonPromptCommand(opts);
			},
		);

	return instructions;
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
			// The deadline's signal is published for the bundle download
			// (`activeDeadline`) and withdrawn the moment the race settles,
			// whichever side won it.
			await withDeadline(HOOK_DEADLINE_MS, (signal) => {
				activeDeadline = signal;
				return body();
			}).finally(() => {
				activeDeadline = undefined;
			});
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
 * The deadline signal in force, if any, so the bundle download can be
 * cancelled by the same clock that bounds the command. Module state rather
 * than a threaded parameter because every command body is single-shot within
 * one process.
 */
let activeDeadline: AbortSignal | undefined;

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
	const drift =
		opts.verify && lock !== null
			? await findLedgerDrift({ root, lock })
			: [];

	if (format === "json") {
		printOutput(
			{
				projectId: opts.project,
				destination,
				synced: lock !== null,
				localDigest: lock?.digest ?? null,
				verified: Boolean(opts.verify),
				drifted: drift.map(describeLedgerDrift),
				// Spec §6.4: the edits an earlier sync saw and kept.
				keptEdited: drift
					.filter((entry) => entry.reason === "edited" && entry.kept)
					.map((entry) => entry.path),
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
		reportDrift(opts, destination, drift);
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
	drift: LedgerDrift[],
): void {
	if (drift.length === 0) {
		line(`Every file in ${destination} matches the lock.`);
		return;
	}
	line(`${drift.length} local file(s) no longer match the lock:`);
	listPaths("drifted", drift.map(describeLedgerDrift));
	// Spec §6.4: `sync` puts back what is missing or chmod-ed, and keeps an
	// edit unless it is given `--repair`.
	const edits = drift.filter((entry) => entry.reason === "edited").length;
	if (edits < drift.length) {
		line(
			`Run \`fabric instructions sync --project ${opts.project}\` to put ${edits === 0 ? "them" : "the others"} back.`,
		);
	}
	if (edits > 0) {
		line(
			`Sync keeps local edits. Run ${repairInstruction(opts)} to replace them with the published version.`,
		);
	}
}

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

/**
 * Nine checks, one report, exit 1 when any of them fails.
 *
 * Informational like `check`: nothing is written, the destination is not
 * created, and every failure inside a check becomes that check's verdict
 * rather than an exception — so a missing key produces a report whose `auth`
 * check fails, not a stack trace. The only thrown failure is the one that
 * turns "a check failed" into exit code 1, AFTER the report is printed.
 *
 * The same context-free clients `check` and `sync` use: an ambient
 * `FABRIC_ORG` must not turn a project the key can read into a refusal.
 */
async function runDoctorCommand(
	opts: CommonOptions & { probeNetwork?: boolean },
	format: OutputFormat,
): Promise<void> {
	const destination = destinationOf(opts);
	const root = await resolveExistingRoot(destination);
	const report = await runDoctor({
		projectId: opts.project,
		org: orgSlugFor(opts),
		destination,
		root,
		commandDest: opts.dest === undefined ? undefined : destination,
		probeNetwork: Boolean(opts.probeNetwork),
		env: process.env,
		platform: process.platform,
		apiKeyPresent: Boolean(getApiKey()),
		client: () => instructionsClient({ hook: false }, CHECK_TIMEOUT_MS),
		createDownloadUrl: (projectId, options) =>
			downloadUrlClient({ hook: false }).instructions.createDownloadUrl(
				projectId,
				options,
			),
		fetchArchive: (url, maxBytes) =>
			fetchBundle(url, { timeoutMs: BUNDLE_TIMEOUT_MS, maxBytes }),
	});

	if (format === "json") {
		printOutput(report, { format: "json" });
	} else {
		process.stdout.write(formatDoctorText(report, destination));
	}

	if (!report.ok) {
		throw new CliFailure(
			`${report.summary.fail} check${report.summary.fail === 1 ? "" : "s"} failed; the report above lists a proposed fix for each`,
			1,
		);
	}
}

// ---------------------------------------------------------------------------
// sync
// ---------------------------------------------------------------------------

async function runSync(
	opts: CommonOptions & { dryRun?: boolean; repair?: boolean },
	format: OutputFormat,
): Promise<void> {
	const result = await syncOnce(opts);
	if (format === "json") {
		printOutput(result, { format: "json" });
	} else {
		reportSync(result, opts);
	}
	// Spec §6.4: a session start must not bury the one thing the developer
	// needs to know, that their edits were kept rather than replaced. One
	// line on stderr, the channel the hook boundary already uses.
	if (opts.hook && result.keptEdited.length > 0) {
		process.stderr.write(
			`fabric: ${result.keptEdited.length} local edit(s) kept; run ${repairInstruction(opts)} to replace them. Keep notes meant only for this machine in CLAUDE.local.md or .claude/settings.local.json.\n`,
		);
	}
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
	/**
	 * Still-published paths whose local edits this run left in place (spec
	 * §6.4). Always empty under `--repair`, which reports them as `replaced`.
	 */
	keptEdited: string[];
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
		keptEdited: [],
		verified: 0,
		lockPath: lockPath(destination),
	};
}

async function syncOnce(
	opts: CommonOptions & {
		dryRun?: boolean;
		repair?: boolean;
		rejectRepository?: boolean;
	},
): Promise<SyncOutcome> {
	// Canonical from here on: every write resolves against this, so a
	// symlinked `--dest` (or `/tmp` on macOS) is decided once rather than at
	// each write.
	const root = await resolveDestinationRoot(destinationOf(opts));
	const outcome = emptyOutcome(opts, root);
	// Spec §6.4: a local edit to a synced file is the developer's, and only
	// `--repair` replaces it. `init`'s first sync keeps too: it never passes
	// `repair`.
	const keepLocalEdits = !opts.repair;

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
		const drift =
			lock === null ? [] : await findLedgerDrift({ root, lock });
		const edits = drift.filter((entry) => entry.reason === "edited");
		// Spec §6.4: without `--repair` an edit is kept, so a tree whose only
		// differences are edits needs no manifest and no download. Recording
		// the keep in the lock is what lets `check --verify` and doctor say so.
		if (
			drift.length === 0 ||
			(keepLocalEdits && edits.length === drift.length)
		) {
			outcome.unchanged = true;
			outcome.keptEdited = edits.map((entry) => entry.path);
			if (lock !== null && !opts.dryRun) {
				// Decision 41: mark what is kept now, and drop a marker whose
				// file was put back by hand, so the lock says what is true. A
				// run that finds the same edits again writes nothing.
				const reconciled = reconcileKeptInLock(
					lock,
					outcome.keptEdited,
				);
				if (reconciled.changed) {
					await writeLock(root, reconciled.lock);
				}
			}
			return outcome;
		}

		outcome.drifted = drift.map(describeLedgerDrift);
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

	const plan = await computeSyncPlan(
		{ destination: root, manifest, lock },
		{ keepLocalEdits },
	);
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

	const applied = await applyPlan({ root, plan, contents, keepLocalEdits });
	// What actually happened, not what was planned: a delete whose file was
	// edited between planning and the unlink is reported as kept, because that
	// is what it is. So is a write whose file was saved after planning
	// (Decision 37): it is a kept edit, not an add or an update.
	outcome.removed = applied.deleted;
	if (applied.keptEdited.length > 0) {
		const late = new Set(applied.keptEdited);
		outcome.added = outcome.added.filter((p) => !late.has(p));
		outcome.updated = outcome.updated.filter((p) => !late.has(p));
		outcome.keptEdited = [
			...outcome.keptEdited,
			...applied.keptEdited,
		].sort();
	}
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
		// Published hash plus `kept: true`: `push` diffs the edit against the
		// version everyone else has, and the next run still knows it was kept.
		kept: outcome.keptEdited,
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
	outcome.keptEdited = plan.keptEdited.map((entry) => entry.path);
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
		reportKeptEdits(outcome, opts);
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
		outcome.keptRenamed.length === 0 &&
		outcome.keptEdited.length === 0
	) {
		line(`Everything in ${outcome.destination} already matched.`);
	}
	reportKeptEdits(outcome, opts);
}

/**
 * Spec §6.4: what was kept, the command that replaces it, and where notes
 * meant only for this machine belong.
 */
function reportKeptEdits(outcome: SyncOutcome, opts: CommonOptions): void {
	if (outcome.keptEdited.length === 0) {
		return;
	}
	listPaths("kept local edits", outcome.keptEdited);
	line(
		`Sync keeps local edits to synced files. Run ${repairInstruction(opts)} to replace them with the published version. Keep notes meant only for this machine in CLAUDE.local.md or .claude/settings.local.json instead.`,
	);
}

/**
 * The command that replaces kept edits. It carries the `--org` and the
 * resolved `--dest` this run was given, so a pasted copy acts on the same
 * project, context and checkout: the rule doctor's generated fixes follow,
 * through the same guarded builder (Decision 42). `undefined` when a word
 * cannot be pasted safely, such as a `--dest` holding a newline.
 */
function repairCommand(opts: CommonOptions): string | undefined {
	return buildFabricCommand([
		"instructions",
		"sync",
		"--project",
		opts.project,
		...(opts.org !== undefined ? ["--org", opts.org] : []),
		...(opts.dest !== undefined ? ["--dest", destinationOf(opts)] : []),
		"--repair",
	]);
}

/** The repair command in backticks, or what to run when none can be printed. */
function repairInstruction(opts: CommonOptions): string {
	const command = repairCommand(opts);
	return command !== undefined
		? `\`${command}\``
		: "`fabric instructions sync --repair` with this run's --project and --dest";
}

// ---------------------------------------------------------------------------
// push
// ---------------------------------------------------------------------------

interface PushOutcome {
	projectId: string;
	destination: string;
	dryRun: boolean;
	/** `--publish`: what this push ASKED for, known before anything is sent. */
	publish: boolean;
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
	/**
	 * Whether this version has been observed published at least once. Null on
	 * a dry run. `status === "READY"` does NOT imply this — see the SDK's
	 * `SubmittedInstructionChange.published` doc — so `pushVerdict` reads this
	 * field rather than inferring publication from `status`. `false` means
	 * "not yet confirmed", never "refused": a publish this call started can
	 * still land after the command has already returned.
	 */
	published: boolean | null;
	/**
	 * A repository-backed project's suggestion becomes a pull request in the
	 * repository (Fizzy #2563 spec §12): where it stood when the command
	 * stopped waiting. `timedOut` means the 60 s wait ended first. Null for a
	 * suggestion Fabric reviews itself, a publish and a dry run.
	 */
	pullRequest: {
		operationId: string;
		state: string;
		url: string | null;
		failure: ProposalPullRequestFailure | null;
		timedOut: boolean;
	} | null;
}

/**
 * Suggest the checkout's edits back to the project, or publish them.
 *
 * Without `--publish` it opens a PROPOSAL, which is what the key the Connect
 * dialog mints can do: that key carries `instructions:write`, a scope offered
 * to read-only roles and described as review-gated.
 *
 * `--publish` is a DIFFERENT authority, not a mode of the same one. It calls a
 * different route, gated on `instructions:publish` — a scope the Connect
 * dialog never mints, that a read-only role cannot be granted, and that has to
 * be put on a key deliberately in the organization's API-key settings. The
 * server then re-checks, on that call, that the key's creator still holds the
 * permission the Coding Instructions tab requires to publish. Both halves are
 * needed: neither the flag nor the scope alone publishes anything.
 *
 * Everything else is identical in both modes — the same local diff, the same
 * lock rules, the same `PULL_FIRST` refusal for a stale base — because a
 * publish is a fast-forward on the published pointer just as a proposal is a
 * claim on it.
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
 * The lock is NOT rewritten, on any outcome, `--publish` included. A proposal
 * changes nothing about what is published, so a lock claiming otherwise would
 * make the next `sync` believe this checkout already held a version nobody has
 * approved. A publish changes it only once the server's validation run passes,
 * which is after this command has returned — and what it publishes is the
 * SERVER's manifest, inherited files and all, not the local tree. Writing a
 * lock for a version that may never exist, from a file list this side cannot
 * compute, would be a guess; `fabric instructions sync` is how the checkout
 * catches up, and it is what the command says to run.
 */
async function runPush(
	opts: CommonOptions & {
		add?: string[];
		publish?: boolean;
		message?: string;
		wait?: boolean;
		dryRun?: boolean;
	},
	format: OutputFormat,
): Promise<void> {
	// A usage error, decided before anything is read: a publish makes a
	// version with nobody to review it, so it has no title or description to
	// carry, and dropping the message silently would lose what was written.
	if (opts.message !== undefined && opts.publish) {
		throw new CliFailure(
			"--message describes a suggestion for review; --publish makes a version directly, which carries no message. Drop one of them.",
			2,
		);
	}
	const note =
		opts.message !== undefined ? splitMessage(opts.message) : undefined;

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
		publish: Boolean(opts.publish),
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
		published: null,
		pullRequest: null,
	};

	if (!opts.dryRun) {
		try {
			// Two methods, not one method with a flag: they are two routes
			// behind two scopes, and choosing between them here is what makes
			// a key that cannot publish fail with a scope refusal rather than
			// quietly proposing instead.
			const submitted = opts.publish
				? await client.instructions.publishChange(
						opts.project,
						lock.snapshotId,
						plan.changes,
						{ org: orgSlugFor(opts) },
					)
				: await client.instructions.submitChange(
						opts.project,
						lock.snapshotId,
						plan.changes,
						{ org: orgSlugFor(opts), ...(note ? { note } : {}) },
					);
			outcome.snapshotId = submitted.snapshotId;
			outcome.version = submitted.version;
			outcome.proposalStatus = submitted.proposalStatus;
			outcome.status = submitted.status;
			outcome.published = submitted.published;
			outcome.pullRequest = submitted.pullRequest
				? pushPullRequest(submitted.pullRequest, false)
				: null;
		} catch (error) {
			throw asPushFailure(error);
		}
	}

	// The suggestion is accepted; for a repository-backed project it becomes
	// a pull request once its files pass their checks, and the push waits a
	// bounded while to say where it stands (spec §12). A failure to READ the
	// status does not undo the suggestion, so it is reported as that.
	if (outcome.pullRequest && outcome.snapshotId && opts.wait !== false) {
		let waited: PullRequestWait;
		try {
			waited = await waitForPullRequest(
				client,
				opts.project,
				outcome.snapshotId,
				{ org: orgSlugFor(opts) },
			);
		} catch (error) {
			const failure = asCliFailure(error);
			throw new CliFailure(
				`Suggested as version ${outcome.version}, but its pull request could not be checked (${failure.message}); see the project's Coding Instructions tab.`,
				failure.exitCode,
			);
		}
		if (waited.kind === "settled") {
			outcome.pullRequest = pushPullRequest(waited.pullRequest, false);
		} else if (waited.kind === "timed_out") {
			outcome.pullRequest = {
				...(waited.pullRequest
					? pushPullRequest(waited.pullRequest, true)
					: outcome.pullRequest),
				timedOut: true,
			};
		}
	}

	const verdict = outcome.pullRequest
		? pullRequestVerdict(outcome.pullRequest, opts.wait !== false)
		: null;
	if (format === "json") {
		printOutput(outcome, { format: "json" });
	} else {
		reportPush(outcome);
		if (verdict && !verdict.fails) {
			line(verdict.text);
		}
	}
	if (verdict?.fails) {
		throw new CliFailure(verdict.text, 7);
	}
}

function pushPullRequest(
	pullRequest: ProposalPullRequest,
	timedOut: boolean,
): NonNullable<PushOutcome["pullRequest"]> {
	return {
		operationId: pullRequest.operationId,
		state: pullRequest.state,
		url: pullRequest.url,
		failure: pullRequest.failure,
		timedOut,
	};
}

/**
 * Why Fabric could not open the pull request, by the stored failure's code.
 * The codes are the server's (`INSTRUCTION_PULL_REQUEST_FAILURE_CODES`); an
 * unlisted one is named rather than guessed at.
 */
const BLOCKED_REASONS: Record<string, string> = {
	ATTRIBUTION_REJECTED:
		"the project's name or your display name looks like an address, a link or a credential, so the commit could not name you safely",
	PERMISSION_REVOKED:
		"you no longer have permission to suggest changes to this project's repository",
	CONFIGURATION_CHANGED:
		"the project's repository settings changed after you suggested this; push again",
	TARGET_BRANCH_MISSING:
		"the repository branch the project syncs from no longer exists",
	BASE_COMMIT_UNAVAILABLE:
		"the commit this suggestion was based on is no longer in the repository; sync and push again",
	TREE_CONFLICT:
		"the repository changed the same files since your last sync; sync and push again",
	AUTHENTICATION_FAILED:
		"the project's repository connection needs to be reconnected",
	REPOSITORY_UNAVAILABLE: "the repository could not be reached",
	BRANCH_WRITE_REFUSED: "the repository refused the new branch",
	PR_CREATION_REFUSED: "the repository refused to open the pull request",
	REMOTE_REF_CONFLICT:
		"a branch with the same name already exists in the repository",
	CREATE_OUTCOME_UNKNOWN:
		"Fabric could not confirm whether the pull request was created",
	VALIDATION_TIMEOUT: "the files' checks did not finish in time",
	LIMITS_EXCEEDED:
		"the change is larger than Fabric can open as a pull request",
	PROVIDER_RATE_LIMITED: "the repository's provider is limiting requests",
	PROVIDER_TEMPORARY: "the repository's provider had a temporary problem",
};

/**
 * The sentence a push ends on for its pull request, and whether it is a
 * failure. `OPEN`, `MERGED`, `CLOSED` and a wait that ran out exit 0;
 * `BLOCKED`, `CANCELED` and an earlier attempt's pending close exit 7.
 */
function pullRequestVerdict(
	pullRequest: NonNullable<PushOutcome["pullRequest"]>,
	waited: boolean,
): { text: string; fails: boolean } {
	const url = pullRequest.url ? `: ${pullRequest.url}` : "";
	if (!waited) {
		return {
			text: "Follow its pull request in the project's Coding Instructions tab.",
			fails: false,
		};
	}
	if (pullRequest.timedOut) {
		return {
			text: "The pull request is being opened; see the project's Coding Instructions tab.",
			fails: false,
		};
	}
	switch (pullRequest.state) {
		case "OPEN":
			return { text: `Pull request opened${url}`, fails: false };
		case "MERGED":
			return {
				text: `Its pull request was already merged${url}. Run \`fabric instructions sync\` once the project has synced it.`,
				fails: false,
			};
		case "CLOSED":
			return {
				text: `Its pull request was closed without merging${url}.`,
				fails: false,
			};
		case "CANCELED":
			return {
				text:
					pullRequest.failure?.code === "VALIDATION_REJECTED"
						? "The suggestion did not pass Fabric's checks, so no pull request was opened; see the project's Coding Instructions tab."
						: "The suggestion was withdrawn before a pull request was opened.",
				fails: true,
			};
		case "CLOSE_REQUESTED":
			return {
				text: "An earlier attempt at this change was withdrawn and its pull request is being closed; push again once it has closed.",
				fails: true,
			};
		case "BLOCKED": {
			const code = pullRequest.failure?.code;
			const reason =
				(code && BLOCKED_REASONS[code]) ??
				`it stopped with ${code ?? "an unknown failure"}`;
			const next = pullRequest.failure?.retryable
				? "Fabric will try again on its own; see"
				: "See";
			return {
				text: `Fabric could not open the pull request: ${reason}. ${next} the project's Coding Instructions tab.`,
				fails: true,
			};
		}
		default:
			return {
				text: "The pull request is being opened; see the project's Coding Instructions tab.",
				fails: false,
			};
	}
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
		// A repository-backed project's admission (Fizzy #2563 spec §5.3).
		case "REPOSITORY_UNAVAILABLE":
			return new CliFailure(
				`this project's repository connection needs attention before a change can be suggested to it (${message}); nothing was sent`,
				7,
			);
		case "REPOSITORY_BASE_UNAVAILABLE":
			return new CliFailure(
				"this project's published instructions are not a sync of its repository as it is configured now; sync the project from its Coding Instructions tab, run `fabric instructions sync`, then push again; nothing was sent",
				7,
			);
		case "NOTE_REJECTED":
			return new CliFailure(
				`${message} Change --message and push again; nothing was sent.`,
				7,
			);
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
	// A publish has no review state to read, so none of the proposal
	// branches below apply to it; what it has instead is a validation run
	// that has only just started. Saying "published version 9" here would be
	// a claim this command cannot make — the verify and secret-scan gate runs
	// after the response, and a change set that fails it publishes nothing.
	//
	// Branched on `outcome.published`, never on `outcome.status === "READY"`
	// alone: the auto-publish runs as its own step, normally AFTER this
	// command has already gotten its response — `READY` says the checks
	// passed, `published` is the server's own observation of whether the
	// publish had already happened by the time it answered. This command
	// classifies nothing further: it cannot know, at response time, whether
	// an unpublished READY version is still catching up or has genuinely lost
	// out to a concurrent edit — that is what the tab's history is for, and
	// this never guesses at it with words like "superseded" or "moved".
	if (outcome.publish) {
		if (outcome.published) {
			return `Published version ${outcome.version}. Run \`fabric instructions sync\` to bring this checkout onto it.`;
		}
		if (outcome.status === "FAILED" || outcome.status === "REJECTED") {
			return `Version ${outcome.version} did not pass its checks (${outcome.status}), so nothing was published; open the project's Coding Instructions tab to see why.`;
		}
		const sent = `Sent as version ${outcome.version}. It publishes on its own once its checks pass (${outcome.status}) — then run \`fabric instructions sync\` to bring this checkout onto it.`;
		// READY gets one more sentence: the checks are done, so what remains
		// unknown is only whether the publish step has landed, and the tab is
		// where that is answered — not a guess printed here.
		return outcome.status === "READY"
			? `${sent} It has passed its checks; its publication state is shown in the project's Coding Instructions tab.`
			: sent;
	}

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
		// A repository-backed project: reviewed as a pull request in the
		// repository, not in the tab (Fizzy #2563 spec §12).
		if (outcome.pullRequest) {
			return `Suggested as version ${outcome.version}. This project's coding instructions come from its repository, so Fabric opens a pull request there once the files pass their checks, and it is reviewed and merged in the repository.`;
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
			outcome.publish
				? "Nothing was sent. Without --dry-run this would create a new version that publishes on its own once its checks pass, with no review."
				: "Nothing was sent. Without --dry-run this would open a proposal for review.",
		);
		return;
	}

	line(pushVerdict(outcome));
	line(
		outcome.publish
			? `Your lock was not changed: it still names version ${outcome.baseVersion}, which is what \`fabric instructions sync\` compares against.`
			: "Your lock was not changed: it still names the published version, which is what `fabric instructions sync` compares against.",
	);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

async function runInit(
	opts: CommonOptions & { tool: string; apply?: boolean; lessons?: boolean },
	format: OutputFormat,
): Promise<void> {
	if (!isInstructionsHookTool(opts.tool)) {
		throw new CliFailure(
			`Unsupported tool "${opts.tool}". Use --tool claude-code or --tool codex.`,
			2,
		);
	}
	const tool = opts.tool;

	// Before any write: Codex has no wired Stop hook for lesson capture yet,
	// so a `--lessons` request against it is refused rather than silently
	// dropped or half-applied.
	if (opts.lessons && tool === "codex") {
		throw new CliFailure(
			"--lessons is not yet supported for codex; Codex hooks for lesson capture are not wired.",
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
		tool,
	});

	// The Stop hook for lesson capture describes the DESIRED state, same as
	// the SessionStart hook above: `--lessons` installs it, and its absence
	// uninstalls whatever an earlier `init` installed. Always after the
	// SessionStart write, so a failure here never leaves that one half-done,
	// and always attempted (even for a plain re-run with no lessons hook
	// ever installed) because the removal is a no-op — and writes nothing —
	// when there is nothing to remove.
	const lessonsHook = Boolean(opts.lessons);
	let lessonsHookLine: string | null = null;
	if (lessonsHook) {
		const installed = await mergeCommandHook({
			root,
			projectId: opts.project,
			command: buildLessonPromptCommand(opts.project, opts.org),
			tool,
			event: "Stop",
		});
		lessonsHookLine = `Added a Stop hook for lesson capture to ${installed.settingsPath}.`;
	} else {
		const removed = await removeCommandHook({
			root,
			projectId: opts.project,
			subcommand: "lesson-prompt",
			tool,
			event: "Stop",
		});
		if (removed.changed) {
			lessonsHookLine = `Removed the Stop hook for lesson capture from ${removed.settingsPath}.`;
		}
	}

	if (format === "json") {
		printOutput(
			{
				projectId: opts.project,
				destination: root,
				settingsPath: merged.settingsPath,
				hookCommand: merged.command,
				createdSettingsFile: merged.createdFile,
				replacedHooks: merged.replacedCount,
				lessonsHook,
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
	if (lessonsHookLine !== null) {
		line(lessonsHookLine);
	}
	if (tool === "codex") {
		line(
			"  Start Codex in this checkout, then use `/hooks` to review and trust the project hook.",
		);
	}

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
		`${hookPathFor(tool)} and ${LOCK_DIRECTORY}/ are local to this machine. If this repository does not ignore them already, add them to your own ignore rules — this command does not edit .gitignore.`,
	);
}

function isInstructionsHookTool(tool: string): tool is InstructionsHookTool {
	return tool === "claude-code" || tool === "codex";
}

function hookPathFor(tool: InstructionsHookTool): string {
	return tool === "codex"
		? CODEX_HOOKS_RELATIVE_PATH
		: CLAUDE_SETTINGS_RELATIVE_PATH;
}

// ---------------------------------------------------------------------------
// lesson-prompt
// ---------------------------------------------------------------------------

/**
 * The `fabric instructions lesson-prompt --hook` wiring: read stdin, ask
 * `runLessonPrompt` what to do, print its answer (if any), and stop.
 *
 * Deliberately outside the `run()` boundary every other command in this file
 * goes through: that boundary still prints one line to stderr and calls
 * `process.exit(0)` on a caught failure, and even that is more than this
 * command's contract allows. `runLessonPrompt` already turns every failure
 * mode — bad stdin, an unreadable transcript, a marker directory it cannot
 * create — into `{ output: null }`, so there is nothing left for this
 * wrapper to catch. It does not call `process.exit` at all: like every other
 * command in this package that does not need to force a specific exit code,
 * it simply returns and lets the process exit on its own once stdout has
 * flushed, which `process.exit` would risk cutting short.
 */
async function runLessonPromptCommand(opts: {
	project?: string;
	org?: string;
	hook?: boolean;
}): Promise<void> {
	let stdinText = "";
	try {
		stdinText = await readAllStdin(process.stdin);
	} catch {
		// An unreadable stdin behaves exactly like empty stdin:
		// `parseStopHookInput("")` already answers `null`, which
		// `runLessonPrompt` turns into a silent exit.
	}

	const markerDir = path.join(
		path.dirname(getConfigPath()),
		"lesson-prompts",
	);

	const result = await runLessonPrompt({
		stdinText,
		markerDir,
		now: new Date(),
		projectId: opts.project,
	});

	if (result.output !== null) {
		process.stdout.write(`${result.output}\n`);
	}
}
