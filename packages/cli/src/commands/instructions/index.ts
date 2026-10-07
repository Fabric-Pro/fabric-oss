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
 * A repository-sourced project is the exception (Fizzy #2708): in a checkout
 * of its own repository `check`, `sync` and the hook only REPORT whether the
 * published commit is in HEAD's history, and `init` writes the hook without a
 * copy. `lib/instructions/checkout.ts` decides which directory is which.
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
import { readdir } from "node:fs/promises";
import path from "node:path";
import type {
	DirectInstructionRepositoryState,
	FabricClient,
	ProposalPullRequest,
	PublishedInstructionRepository,
	PublishedInstructionSource,
	PublishedInstructions,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import {
	CliFailure,
	describeError,
	type OutputFormat,
	outputFormatFor,
	withDeadline,
} from "../../lib/command-boundary.js";
import {
	getApiKey,
	getBaseUrl,
	getConfigPath,
	getOAuth,
	hasStoredApiKey,
} from "../../lib/config.js";
import { runningInCi } from "../../lib/environment.js";
import {
	adoptionFor,
	cloneUrlFor,
	folderForCommand,
	providerLoginCommand,
} from "../../lib/instructions/adoption.js";
import {
	agentMcpLines,
	agentRegistrationFacts,
	mcpAuthenticationPending,
	mcpRegistrationComplete,
	registerAgentMcp,
} from "../../lib/instructions/agent-mcp.js";
import { createAgentRunner } from "../../lib/instructions/agent-run.js";
import {
	type ApplyResult,
	applyPlan,
	type FileContents,
} from "../../lib/instructions/apply.js";
import { extractBundle, fetchBundle } from "../../lib/instructions/bundle.js";
import {
	type CheckoutClassification,
	type CheckoutJson,
	classifyCheckout,
	classLine,
	currentLine,
	downloadsIn,
	nothingPublishedLine,
	reportForClassification,
	repositoryName,
	shellQuote,
} from "../../lib/instructions/checkout.js";
import { sanitizeDisplayText } from "../../lib/instructions/checks.js";
import { resolveCloneFolder } from "../../lib/instructions/clone-target.js";
import {
	buildFabricCommand,
	formatDoctorText,
	runDoctor,
} from "../../lib/instructions/doctor.js";
import { dropOwnLock } from "../../lib/instructions/drop-lock.js";
import {
	asFixedFailure,
	scrubForOutput,
	UpgradeRequiredFailure,
} from "../../lib/instructions/failure.js";
import {
	type FastForwardResult,
	runFastForward,
} from "../../lib/instructions/fast-forward-run.js";
import {
	fetchFilesByUrl,
	PER_FILE_MAX_WRITES,
	PublishedChangedError,
} from "../../lib/instructions/file-downloads.js";
import * as git from "../../lib/instructions/git.js";
import { excludeLocalFiles } from "../../lib/instructions/git-exclude.js";
import {
	assertKeyStaysOutside,
	buildHookCommand,
	buildLessonPromptCommand,
	CLAUDE_SETTINGS_RELATIVE_PATH,
	CODEX_HOOKS_RELATIVE_PATH,
	type InstructionsHookTool,
} from "../../lib/instructions/hook.js";
import { resolveHookLauncher } from "../../lib/instructions/hook-launcher.js";
import { hookTiming } from "../../lib/instructions/hook-timing.js";
import { traceFile } from "../../lib/instructions/hook-trace.js";
import { isIdentifier } from "../../lib/instructions/identifiers.js";
import { installHooks } from "../../lib/instructions/init-hooks.js";
import {
	readAllStdin,
	runLessonPrompt,
} from "../../lib/instructions/lesson-prompt.js";
import {
	type InstructionsLock,
	LOCK_DIRECTORY,
	LOCK_FILENAME,
	lockPath,
	readLock,
	readLockSafely,
	writeLock,
} from "../../lib/instructions/lock.js";
import { machine } from "../../lib/instructions/machine.js";
import {
	assertValidManifest,
	maxArchiveBytes,
} from "../../lib/instructions/manifest.js";
import { runNativeInstructionPush } from "../../lib/instructions/native-push.js";
import { lookUpOpenProposals } from "../../lib/instructions/open-proposals.js";
import {
	HOOK_PREFIX,
	outcomeFailure,
	outcomeLine,
} from "../../lib/instructions/outcome.js";
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
	canPrompt,
	chooseProject,
	confirm,
} from "../../lib/instructions/prompt.js";
import {
	type PushPullRequestStatus,
	pullRequestVerdict,
	pushPullRequest,
} from "../../lib/instructions/pull-request-verdict.js";
import {
	type PullRequestWait,
	splitMessage,
	waitForPullRequest,
} from "../../lib/instructions/pull-request-wait.js";
import {
	type AlreadyProposed,
	computePushPlan,
	MAX_INLINE_PUSH_BYTES,
	MAX_PUSH_CHANGES,
	materializePushChanges,
	pushContentBytes,
	setAsideProposed,
} from "../../lib/instructions/push.js";
import { resolveProjectFromCheckout } from "../../lib/instructions/resolve-project.js";
import {
	resolveDestinationRoot,
	resolveExistingRoot,
} from "../../lib/instructions/safe-write.js";
import {
	refreshKeptCopy,
	selfUpdateLine,
} from "../../lib/instructions/self-update.js";
import {
	IN_MEMORY_SNAPSHOT_BYTES,
	type StagedFileContents,
	stageFilesByUrl,
} from "../../lib/instructions/staged-files.js";
import {
	type DetectedTools,
	detectTools,
} from "../../lib/instructions/tools.js";
import {
	bundleScriptPath,
	bundleTarballPath,
	fabricCommand,
	isServedBundle,
	launcherPathText,
	setLauncherOrigin,
} from "../../lib/launcher.js";
import { takeAuthFailure } from "../../lib/oauth/auth-failure.js";
import {
	REPOSITORY_TRANSPORT_SCOPE,
	REQUESTED_SCOPES,
} from "../../lib/oauth/flow.js";
import { projectAccessToken } from "../../lib/oauth/session.js";
import { signInWithBrowser } from "../../lib/oauth/sign-in.js";
import { DEFAULT_ORIGIN, normalizeOrigin } from "../../lib/origin.js";
import { printOutput } from "../../lib/output.js";
import { isPlainOrigin } from "../../lib/shell-words.js";
import { takeUpgradeNotice } from "../../lib/user-agent.js";

/**
 * The whole of hook mode, end to end, including the bundle download.
 *
 * One ABSOLUTE deadline rather than one per request. The SDK's timeout is
 * per attempt and it retries twice by default, so three "5 second" calls
 * plus backoff is about 15.75 seconds — past the point where Claude Code
 * kills the hook itself, possibly mid-write. Retries are off in hook mode
 * and this bound covers everything. The value lives in `hookTiming`
 * (`lib/instructions/hook-timing.ts`) so a test can shorten it.
 */
function hookDeadlineMs(): number {
	return hookTiming.deadlineMs;
}

/**
 * The read-only git commands a manual run makes to classify a checkout of a
 * repository-sourced project (Fizzy #2708), all together. Hook mode uses what
 * is left of the hook deadline, less `hookTiming.gitMarginMs`, instead.
 */
const GIT_BUDGET_MS = 10_000;

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

const PROJECT_HELP =
	"Project ID (default: the project this checkout's repository is connected to)";
const BASE_URL_HELP =
	"Deployment to talk to, such as https://example.com (default: the one you are signed in to)";
const REMOTE_HELP =
	"Use this remote of the checkout (default: whichever fetches from the project's repository)";

/** What a command is given, before the project is known. */
interface RawOptions {
	project?: string;
	dest?: string;
	org?: string;
	hook?: boolean;
	baseUrl?: string;
	remote?: string;
	format?: string;
}

interface CommonOptions {
	project: string;
	dest?: string;
	org?: string;
	hook?: boolean;
	/** The deployment, as an origin, when `--base-url` named one. */
	baseUrl?: string;
	/** The one remote to look at, when `--remote` named one. */
	remote?: string;
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
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--remote <name>", REMOTE_HELP)
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
			opts: RawOptions & { verify?: boolean },
		) {
			await run(opts, "check", async () =>
				runCheck(
					await withProject(opts, "check"),
					outputFormatFor(this),
				),
			);
		});

	instructions
		.command("doctor")
		.description(
			"Check whether this machine is set up the way the project's coding instructions expect",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--remote <name>", REMOTE_HELP)
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--probe-network",
			"Also send one HTTP GET to each url server in .mcp.json to see whether it answers",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & { probeNetwork?: boolean },
		) {
			// Never hook mode: doctor is run by a person (or an agent acting
			// for one), and a failed check is a real exit code.
			await run({ ...opts, hook: false }, "doctor", async () =>
				runDoctorCommand(
					await withProject({ ...opts, hook: false }, "doctor"),
					outputFormatFor(this),
				),
			);
		});

	instructions
		.command("sync")
		.description(
			"Write the published coding instructions into the checkout",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--remote <name>", REMOTE_HELP)
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option("--dry-run", "Print the plan and write nothing")
		.option(
			"--repair",
			"Replace local edits to synced files with the published version; without it, sync keeps them",
		)
		.option(
			"--no-fast-forward",
			"Under --hook in a checkout of a repository project: only report, never fetch or fast-forward",
		)
		.option(
			"--hook",
			"Session-hook mode: plain text, never fails, never blocks a session",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & {
				dryRun?: boolean;
				repair?: boolean;
				fastForward?: boolean;
			},
		) {
			await run(opts, "sync", async () =>
				runSync(await withProject(opts, "sync"), outputFormatFor(this)),
			);
		});

	instructions
		.command("push")
		.description(
			"Propose this checkout's edits to the project's coding instructions, or publish them with --publish",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--remote <name>", REMOTE_HELP)
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
		.option(
			"--include-proposed",
			"Also send changes your open proposals already carry (left out by default)",
		)
		.option("--dry-run", "Print the change set and send nothing")
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & {
				add?: string[];
				publish?: boolean;
				message?: string;
				wait?: boolean;
				includeProposed?: boolean;
				dryRun?: boolean;
			},
		) {
			// Never hook mode: a session start does not push. Stated rather
			// than inherited, because `run`'s never-fail branch exists for
			// commands a hook runs and this is not one.
			await run({ ...opts, hook: false }, "push", async () =>
				runPush(
					await withProject({ ...opts, hook: false }, "push"),
					outputFormatFor(this),
				),
			);
		});

	instructions
		.command("init")
		.description(
			"Set this checkout up for a project's coding instructions: clone its repository into an empty folder, and write the session hook for each coding tool found",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--remote <name>", REMOTE_HELP)
		.option(
			"--tool <tool>",
			"Coding tool to configure: claude-code|codex (default: every one found on this machine)",
		)
		.option(
			"--clone [folder]",
			"Clone the project's repository without asking: into this folder when it is empty, or into <folder> (made if missing, and not allowed to hold anything yet), then finish setting up inside it. <folder> needs --project",
		)
		.option("--dest <dir>", "Destination directory (default: cwd)")
		.option("--org <slug>", "Organization context")
		.option(
			"--apply",
			"Let the hook apply changes instead of only reporting them (an uploaded project; a repository project's hook already fast-forwards)",
		)
		.option(
			"--report-only",
			"Write a hook that only reports: never fetch, never fast-forward",
		)
		.option(
			"--lessons",
			"Also install a Stop hook that asks, once per session after the assistant has edited files, whether a mistake from the session should become a team lesson",
		)
		.option(
			"--no-mcp",
			"Do not register the project's MCP server with the coding tools found",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & {
				tool: string;
				apply?: boolean;
				reportOnly?: boolean;
				lessons?: boolean;
				clone?: boolean | string;
				mcp?: boolean;
			},
		) {
			// Never hook mode: `init` is run by a person, so its failures
			// are real failures with real exit codes.
			await run({ ...opts, hook: false }, "init", async () => {
				// A new folder has no checkout to find the project from.
				if (
					typeof opts.clone === "string" &&
					opts.project === undefined
				) {
					throw outcomeFailure("clone-needs-project", {});
				}
				return runInit(
					await withProject({ ...opts, hook: false }, "init"),
					outputFormatFor(this),
				);
			});
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
	opts: {
		hook?: boolean;
		baseUrl?: string;
		dest?: string;
		project?: string;
	},
	verb: string,
	body: () => Promise<void>,
): Promise<void> {
	activeOrigin = describedOrigin(opts);
	activeProject = opts.project;
	setLauncherOrigin(activeOrigin);
	takeAuthFailure();
	takeUpgradeNotice();
	let hookDeadlineAt: number | undefined;
	try {
		if (opts.hook) {
			// The deadline's signal is published for the bundle download
			// (`activeDeadline`) and withdrawn the moment the race settles,
			// whichever side won it.
			const totalMs = hookDeadlineMs();
			activeDeadlineAt = Date.now() + totalMs;
			hookDeadlineAt = activeDeadlineAt;
			await withDeadline(totalMs, (signal) => {
				activeDeadline = signal;
				return body();
			}).finally(() => {
				activeDeadline = undefined;
				activeDeadlineAt = undefined;
			});
		} else {
			await body();
		}
	} catch (error) {
		const failure = presentable(error, opts);
		if (process.env.FABRIC_DEBUG) {
			const original =
				error instanceof CliFailure && error.cause !== undefined
					? error.cause
					: error;
			process.stderr.write(`debug: ${describeError(original)}\n`);
		}
		if (opts.hook) {
			// A sign-in that cannot be used is the one failure the agent must
			// hear about: on stdout, with the line that fixes it. Everything
			// else is a skip, on stderr.
			const authFailure = takeAuthFailure();
			const signedOutOf =
				error instanceof NotSignedInError
					? error.origin
					: (authFailure?.origin ??
						(failure.exitCode === 3
							? describedOrigin(opts)
							: null));
			if (signedOutOf !== null) {
				line(
					`${HOOK_PREFIX}: ${outcomeLine("hook-signed-out", { origin: signedOutOf || describedOrigin(opts), project: opts.project })}`,
				);
			} else if (error instanceof UpgradeRequiredFailure) {
				line(error.line);
			} else {
				process.stderr.write(
					`${HOOK_PREFIX} ${verb} skipped: ${failure.message === outcomeLine("project-not-found", {}) ? "no project for this checkout" : failure.message}\n`,
				);
			}
			showUpgradeNotice(true);
			if (error instanceof UpgradeRequiredFailure) {
				// The failure a newer copy fixes: the deployment will not talk
				// to this build, so this is the run that most needs the daily
				// update.
				await refreshKeptCopyAfterHook(opts, hookDeadlineAt);
			}
			process.exit(0);
		}
		// A list a person has to read (several projects) keeps its lines.
		process.stderr.write(`✗ ${failure.message}\n`);
		showUpgradeNotice(false);
		process.exit(failure.exitCode);
	}
	showUpgradeNotice(Boolean(opts.hook));
	if (opts.hook) {
		await refreshKeptCopyAfterHook(opts, hookDeadlineAt);
	}
}

/**
 * After a hook run has said what it has to say: the kept copy of the served
 * build asks its deployment for a newer one (`self-update.ts`). Only the
 * deployment the hook is bound to with `--base-url` is ever asked. Its one line,
 * when there is one, goes to stderr, never stdout.
 */
async function refreshKeptCopyAfterHook(
	opts: { baseUrl?: string },
	deadlineAt: number | undefined,
): Promise<void> {
	const origin =
		opts.baseUrl === undefined ? null : normalizeOrigin(opts.baseUrl);
	if (origin === null || deadlineAt === undefined) {
		return;
	}
	const outcome = await refreshKeptCopy({
		origin,
		script: bundleScriptPath(),
		configDirectory: path.dirname(getConfigPath()),
		runningTarball: bundleTarballPath(),
		env: process.env,
		deadlineAt,
		timing: {
			budgetMs: hookTiming.selfUpdateBudgetMs,
			marginMs: hookTiming.selfUpdateMarginMs,
		},
	});
	if (outcome.kind === "failed" && process.env.FABRIC_DEBUG) {
		process.stderr.write(
			`debug: ${describeError(outcome.cause ?? outcome.reason)}\n`,
		);
	}
	const message = selfUpdateLine(outcome);
	if (message !== null) {
		process.stderr.write(`${message}\n`);
	}
}

/** The deployment the run in progress talks to, for the sentences that name it. */
let activeOrigin: string = DEFAULT_ORIGIN;

/** The project the run in progress is for, once it is known, for the sign-in line a sentence suggests. */
let activeProject: string | undefined;

function fixedFailure(error: unknown): CliFailure {
	return asFixedFailure(error, activeOrigin, activeProject);
}

/**
 * What a person or an agent reads for a failure: a failure this CLI wrote
 * with its paths and digests taken out, a request's failure as the fixed
 * sentence for its status, and anything else as the message it carries,
 * likewise scrubbed. The original is under `FABRIC_DEBUG=1`.
 */
function presentable(
	error: unknown,
	opts: { dest?: string },
): { message: string; exitCode: number } {
	const scrub = (message: string): string =>
		scrubForOutput(message, {
			destination: destinationOf(opts),
			destinationTyped: opts.dest !== undefined,
			home: machine.home(),
			keep: launcherPathText(),
		});
	if (error instanceof CliFailure) {
		return { message: scrub(error.message), exitCode: error.exitCode };
	}
	if (typeof (error as { status?: unknown } | null)?.status === "number") {
		const mapped = fixedFailure(error);
		return { message: mapped.message, exitCode: mapped.exitCode };
	}
	return { message: scrub(describeError(error)), exitCode: 1 };
}

/**
 * The deployment's own words about this CLI being out of date, once. A hook
 * prints it on stdout, where an agent reads it; a person gets it on stderr.
 * Nothing is updated here: a kept copy of the served build updates itself
 * afterwards (`refreshKeptCopyAfterHook`), and no other build does.
 */
function showUpgradeNotice(hook: boolean): void {
	const notice = takeUpgradeNotice();
	if (notice === null) {
		return;
	}
	if (hook) {
		line(notice);
	} else {
		process.stderr.write(`${notice}\n`);
	}
}

/**
 * The deadline signal in force, if any, so the bundle download can be
 * cancelled by the same clock that bounds the command. Module state rather
 * than a threaded parameter because every command body is single-shot within
 * one process.
 */
let activeDeadline: AbortSignal | undefined;

/**
 * The same deadline as an absolute time, for the git commands a
 * repository-sourced project's hook runs.
 */
let activeDeadlineAt: number | undefined;

/**
 * When the git commands this run makes must be done by. Under a hook that is
 * `hookTiming.gitMarginMs` BEFORE the outer deadline, never at it: a git call
 * that runs out answers "unavailable", the checkout is `unknown`, and that
 * line reaches stdout with time to spare — rather than racing the outer
 * timer, whose generic "skipped" line goes to stderr, which a successful
 * hook's session never sees. A margin already spent makes every git call
 * answer "timed out" at once, with the same result.
 */
function gitDeadline(): number {
	return activeDeadlineAt === undefined
		? Date.now() + GIT_BUDGET_MS
		: activeDeadlineAt - hookTiming.gitMarginMs;
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
	opts: { hook?: boolean; baseUrl?: string; project?: string },
	timeoutMs: number,
	{ neverRetry = false }: { neverRetry?: boolean } = {},
): FabricClient {
	if (!getApiKey(deploymentOrigin(opts), opts.project)) {
		throw new NotSignedInError(deploymentOrigin(opts), opts.project);
	}
	// `withoutContext()`: the SDK constructor adopts `FABRIC_ORG` /
	// `FABRIC_PERSONAL` and injects them into every URL that does not name a
	// context. On a project-authoritative surface that ambient default is not
	// a default, it is a contradiction waiting to be refused — see
	// `orgSlugFor`.
	return getClient({
		...(opts.baseUrl === undefined ? {} : { baseUrl: opts.baseUrl }),
		...(opts.project === undefined ? {} : { project: opts.project }),
		...(opts.hook
			? {
					// Hook mode has ONE absolute deadline covering every
					// call it makes, so it cannot spend it on retries: a
					// session that will not start is worse than instructions
					// one version stale.
					timeoutMs: Math.min(timeoutMs, hookDeadlineMs()),
					retry: { maxRetries: 0 },
				}
			: neverRetry
				? { timeoutMs, retry: { maxRetries: 0 } }
				: { timeoutMs }),
	}).withoutContext();
}

/**
 * The deployment this run talks to, as an origin: `--base-url`, else what
 * `FABRIC_BASE_URL` or the profile names, else the default. What a hook is
 * bound to and the credential is picked by, so an address that is not a URL
 * is a failure here and never the default deployment.
 */
function deploymentOrigin(opts: { baseUrl?: string }): string {
	const origin = normalizeOrigin(
		opts.baseUrl ?? getBaseUrl() ?? DEFAULT_ORIGIN,
	);
	if (origin === null) {
		throw outcomeFailure("bad-base-url", {});
	}
	return origin;
}

/**
 * The deployment a sentence names, for lines that only describe a run that is
 * already ending. Unlike `deploymentOrigin` it never throws and never picks a
 * credential.
 */
function describedOrigin(opts: { baseUrl?: string }): string {
	return (
		normalizeOrigin(opts.baseUrl ?? getBaseUrl() ?? DEFAULT_ORIGIN) ??
		DEFAULT_ORIGIN
	);
}

/** There is no sign-in stored for the deployment this run talks to. */
class NotSignedInError extends CliFailure {
	constructor(
		readonly origin: string,
		project?: string,
	) {
		super(outcomeLine("not-signed-in", { origin, project }), 3);
		this.name = "NotSignedInError";
	}
}

/**
 * The longest `init` waits for a browser sign-in, from the first request to
 * the last: a little more than the five minutes the browser callback is
 * waited for, so the wait is always the callback's and a run nobody is
 * watching still ends.
 */
const SIGN_IN_TIMEOUT_MS = 6 * 60_000;

/**
 * Before `init` goes further, a person who is not signed in to the deployment
 * signs in right here, through the browser. A terminal is not required: an
 * agent running the line for a developer has none, and the URL on stderr is
 * what it hands over. Under CI, and for any other command, it is a refusal
 * that says the one line to run. A hook never gets here: it has no person, and
 * must never open a port or a browser.
 */
async function ensureSignedIn(opts: {
	baseUrl?: string;
	hook?: boolean;
	project?: string;
}): Promise<void> {
	const origin = deploymentOrigin(opts);
	// Only `init` gets here, and the hook it writes carries this address into a
	// command a shell runs at every session start: one a shell would read is
	// refused before anything is signed in to or written.
	if (!isPlainOrigin(origin)) {
		throw outcomeFailure("unusable-base-url", {});
	}
	if (hasSignInFor(origin, opts.project)) {
		return;
	}
	if (opts.hook || runningInCi()) {
		throw new NotSignedInError(origin, opts.project);
	}
	const forProject =
		opts.project === undefined ? "" : ` for project ${opts.project}`;
	try {
		const who = await signInWithBrowser({
			baseUrl: opts.baseUrl ?? getBaseUrl() ?? origin,
			origin,
			explicit: opts.baseUrl !== undefined,
			signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
			...(opts.project === undefined ? {} : { project: opts.project }),
			announce: (url) => {
				process.stderr.write(
					`Opening your browser to sign in to ${origin}${forProject}.\nIf it does not open, visit:\n\n  ${url}\n\nWaiting up to 5 minutes for the sign-in to finish.\n\n`,
				);
			},
		});
		process.stderr.write(
			`Signed in to ${origin}${forProject} as ${sanitizeDisplayText(who.name, 80)}.\n`,
		);
	} catch {
		throw outcomeFailure("sign-in-failed", {
			origin,
			project: opts.project,
		});
	}
}

/**
 * Full native Git transport is an explicit capability, distinct from the
 * selected-instruction read grant used by ordinary CLI and MCP commands.
 */
async function ensureRepositoryTransportScope(
	opts: CommonOptions,
	client: FabricClient,
): Promise<void> {
	let scopes: string[];
	try {
		scopes = (await client.auth.whoami()).scopes;
	} catch (error) {
		throw fixedFailure(error);
	}
	if (scopes.includes(REPOSITORY_TRANSPORT_SCOPE)) {
		return;
	}
	if (opts.hook || runningInCi()) {
		throw new CliFailure(
			"This repository checkout needs the repositories:read capability. Run instructions init interactively to approve it, or use a CI API key with instructions:read and repositories:read from your organization's API keys settings.",
			7,
		);
	}
	const origin = deploymentOrigin(opts);
	try {
		await signInWithBrowser({
			baseUrl: opts.baseUrl ?? getBaseUrl() ?? origin,
			origin,
			explicit: opts.baseUrl !== undefined,
			project: opts.project,
			scopes: [...REQUESTED_SCOPES, REPOSITORY_TRANSPORT_SCOPE],
			signal: AbortSignal.timeout(SIGN_IN_TIMEOUT_MS),
			announce: (url) => {
				process.stderr.write(
					`Opening your browser to approve repository access at ${origin}.\nIf it does not open, visit:\n\n  ${url}\n\nWaiting up to 5 minutes for the sign-in to finish.\n\n`,
				);
			},
		});
	} catch {
		throw new CliFailure(
			"Repository access was not approved; the native checkout was left unchanged.",
			7,
		);
	}
}

async function directGitTransport(
	opts: CommonOptions,
	direct: Extract<
		DirectInstructionRepositoryState,
		{ availability: "READY" }
	>,
): Promise<{ url: string; authorization: string }> {
	if (direct.gitGateway?.version !== "v1") {
		throw new CliFailure(
			"This Fabric deployment does not support repository Git transport yet. Update Fabric, then run init again.",
			7,
		);
	}
	const origin = deploymentOrigin(opts);
	const base = new URL(
		`/api/v1/projects/${encodeURIComponent(opts.project)}/instructions/repository/git/${direct.generation}`,
		origin,
	);
	const signal = opts.hook
		? AbortSignal.timeout(hookDeadlineMs())
		: undefined;
	const token = getOAuth(origin, opts.project)
		? await projectAccessToken(origin, opts.project, signal)
		: getApiKey(origin, opts.project);
	if (!token) {
		throw new NotSignedInError(origin, opts.project);
	}
	return { url: base.toString(), authorization: `Bearer ${token}` };
}

/**
 * Whether the run has what it needs to talk to the deployment. Without a project
 * any credential will do. For a project it is a key, or that project's own
 * sign-in: an organization-wide sign-in reaches every project, which is what a
 * project's setup is there to stop relying on, so it is replaced by one for the
 * project.
 */
function hasSignInFor(origin: string, project: string | undefined): boolean {
	if (project === undefined) {
		return Boolean(getApiKey(origin));
	}
	return hasStoredApiKey(origin) || getOAuth(origin, project) !== undefined;
}

/**
 * The options with the project filled in: the one named, or the one this
 * checkout's repository is connected to. `--base-url` is normalised to an
 * origin here, once, so the client, the hook and the credential all see the
 * same spelling.
 *
 * A hook never resolves: it runs unattended at session start, and what it
 * would answer could change between two sessions. It names its project.
 */
async function withProject<T extends RawOptions>(
	opts: T,
	verb: string,
): Promise<T & { project: string }> {
	const baseUrl =
		opts.baseUrl === undefined ? undefined : normalizeOrigin(opts.baseUrl);
	if (opts.baseUrl !== undefined && baseUrl === null) {
		throw outcomeFailure("bad-base-url", {});
	}
	if (opts.project !== undefined && !isIdentifier(opts.project)) {
		throw outcomeFailure("bad-project-id", {});
	}
	if (opts.org !== undefined && !isIdentifier(opts.org)) {
		throw outcomeFailure("bad-org-slug", {});
	}
	if (opts.remote !== undefined && !git.isRemoteName(opts.remote)) {
		throw outcomeFailure("bad-remote-name", {});
	}
	const bound = { ...opts, baseUrl: baseUrl ?? undefined };
	if (verb === "init") {
		await ensureSignedIn(bound);
	}
	if (opts.project !== undefined) {
		return { ...bound, project: opts.project };
	}
	if (opts.hook) {
		throw outcomeFailure("hook-needs-project", {});
	}
	const client = instructionsClient(bound, CHECK_TIMEOUT_MS);
	const match = await resolveProjectFromCheckout({
		destination: destinationOf(opts),
		verb,
		remote: opts.remote,
		deadline: gitDeadline(),
		deps: {
			resolveCheckout: async (candidates) => {
				try {
					return await client.instructions.resolveCheckout(
						candidates,
					);
				} catch (error) {
					throw fixedFailure(error);
				}
			},
			...(canPrompt()
				? { choose: (projects) => chooseProject(projects) }
				: {}),
		},
	});
	activeProject = match.projectId;
	if (verb === "init") {
		// Finding the project used whatever credential there was, an
		// organization-wide sign-in perhaps. What the setup that follows relies
		// on is the project's own sign-in, so it is taken now that the project
		// is known.
		await ensureSignedIn({ ...bound, project: match.projectId });
	}
	return { ...bound, project: match.projectId };
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
function downloadUrlClient(opts: {
	hook?: boolean;
	baseUrl?: string;
}): FabricClient {
	return instructionsClient(
		opts,
		opts.hook ? hookDeadlineMs() : BUNDLE_TIMEOUT_MS,
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
	guard?: SourceGuard,
): Promise<PublishedInstructions> {
	const org = orgSlugFor(opts);
	let published: PublishedInstructions;
	try {
		published = await client.instructions.getPublished(opts.project, {
			org,
			sinceDigest,
		});
	} catch (error) {
		throw fixedFailure(error);
	}
	await guard?.admit(published);
	return published;
}

/**
 * Where a command's instructions come from, decided once and then held to
 * (Fizzy #2708).
 *
 * The FIRST response decides: for a repository-sourced project it classifies
 * the directory against that response's `repository` block, and that
 * classification governs the whole command — report only in a checkout of the
 * repository, the upload behaviour in a directory that is not a checkout at
 * all. Every LATER response (`sync`'s drift refetch, `init`'s first-copy
 * sync) must then name the same source: a `sourceOfTruth` or repository
 * configuration that moved between two calls means the classification may be
 * wrong for what is now being applied, so the command stops before it plans,
 * downloads or writes anything. Checking only the first response let a
 * project switched between the two be planned, downloaded and applied — a
 * second writer in a checkout that git already keeps current.
 */
class SourceGuard {
	private first: string | undefined;
	/** `null` until admitted, and for a project that is not repository-sourced. */
	checkout: CheckoutClassification | null = null;

	constructor(
		private readonly destination: string,
		private readonly remote?: string,
		/** A missing or empty --clone target must not inherit its parent checkout. */
		private readonly fresh = false,
	) {}

	async admit(published: PublishedInstructions): Promise<void> {
		const identity = sourceIdentity(published);
		if (this.first === undefined) {
			this.first = identity;
			if (published.sourceOfTruth === "REPOSITORY") {
				this.checkout = this.fresh
					? { class: "not-git" }
					: await classifyCheckout({
							destination: this.destination,
							repository: published.repository,
							deadline: gitDeadline(),
							remote: this.remote,
						});
			}
			return;
		}
		if (identity !== this.first) {
			throw new CliFailure(
				"this project's instruction source changed while this command ran; nothing was written — run it again",
				7,
			);
		}
	}
}

/**
 * The fields whose change between two responses stops a command. The
 * repository's `cloneUrl` and `sync` are left out on purpose: they describe
 * how Fabric's own copy is doing, `lastRun` moves on every sync, and neither
 * changes which repository the instructions come from.
 */
function sourceIdentity(published: PublishedInstructions): string {
	const repository = published.repository ?? null;
	const direct = directRepositoryRead(published);
	return JSON.stringify([
		published.sourceOfTruth,
		repository === null
			? null
			: [
					repository.provider,
					repository.host,
					repository.path,
					repository.ref,
					repository.rootPath,
					repository.generation,
				],
		direct === null ? null : [direct.generation, direct.currentCommitSha],
	]);
}

function directRepositoryRead(
	published: PublishedInstructions,
): Extract<DirectInstructionRepositoryState, { availability: "READY" }> | null {
	const direct = published.direct;
	return published.sourceOfTruth === "REPOSITORY" &&
		published.repository !== undefined &&
		published.repository !== null &&
		direct?.availability === "READY"
		? direct
		: null;
}

type DirectRepositoryCheckoutStatus = {
	current: boolean;
	line: string;
};

async function directRepositoryCheckoutStatus(input: {
	repository: NonNullable<PublishedInstructions["repository"]>;
	direct: Extract<
		DirectInstructionRepositoryState,
		{ availability: "READY" }
	>;
	checkout: CheckoutClassification;
	report: Awaited<ReturnType<typeof reportForClassification>>;
}): Promise<DirectRepositoryCheckoutStatus> {
	const commit = input.direct.currentCommitSha.slice(0, 7);
	const repository = repositoryName(input.repository);
	if (input.checkout.class !== "matching") {
		return {
			current: false,
			line: `Coding instructions are read directly from ${repository} at ${commit}. Open a matching native checkout before reading them locally.`,
		};
	}
	const head = input.report.state?.head;
	if (head === null || head === undefined) {
		return {
			current: false,
			line: `Coding instructions are read directly from ${repository} at ${commit}; this checkout could not be compared to that commit.`,
		};
	}
	const contains = await git.isAncestor(
		input.checkout.toplevel,
		input.direct.currentCommitSha,
		head,
		gitDeadline(),
	);
	if (contains.kind === "ok" && contains.value) {
		return {
			current: true,
			line: `Coding instructions are read directly from ${repository} at ${commit}; this checkout already contains that commit.`,
		};
	}
	if (contains.kind === "ok") {
		const behind = await git.isAncestor(
			input.checkout.toplevel,
			head,
			input.direct.currentCommitSha,
			gitDeadline(),
		);
		if (behind.kind === "ok") {
			return {
				current: false,
				line: behind.value
					? `Coding instructions are read directly from ${repository} at ${commit}; this checkout is behind. Run git pull --ff-only.`
					: `Coding instructions are read directly from ${repository} at ${commit}; this checkout has diverged. Inspect its Git history before choosing how to update it.`,
			};
		}
	}
	return {
		current: false,
		line: `Coding instructions are read directly from ${repository} at ${commit}; fetch that commit with your normal Git remote before continuing.`,
	};
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
		throw outcomeFailure("lock-of-other-project", {});
	}
	return lock;
}

/**
 * The lock's digest as a HINT for the first request, or `undefined` — never a
 * failure (Fizzy #2708 review).
 *
 * The lock is validated only once the directory has been classified, and only
 * where this run may use it: a checkout of a repository-sourced project's own
 * repository never has one, so a malformed, symlinked, unsupported or other
 * project's lock left there must not stop the report. The hint keeps the
 * one-request session start for everyone else: when the validated lock later
 * turns out to carry a different digest (or none), `validatedLock` asks again.
 */
async function lockDigestHint(
	root: string,
	projectId: string,
): Promise<string | undefined> {
	try {
		// The guarded, bounded reader: a symlinked `.fabric` or lock is
		// refused rather than followed out of the checkout.
		const lock = await readLockSafely(root, {
			maxBytes: MAX_HINT_LOCK_BYTES,
		});
		return lock !== null && lock.projectId === projectId
			? lock.digest
			: undefined;
	} catch {
		return undefined;
	}
}

/** A 5000-file lock is about a megabyte; a hint is not worth reading more. */
const MAX_HINT_LOCK_BYTES = 16 * 1024 * 1024;

/** Whether this run may use the lock: an uploaded project, or a class that downloads. */
function usesLock(guard: SourceGuard, manual: boolean): boolean {
	return guard.checkout === null || downloadsIn(guard.checkout, manual);
}

/**
 * The lock, validated, and the response to act on: the one already fetched
 * when it was asked with this lock's digest, otherwise a second request —
 * held to the first by the same guard.
 */
async function validatedLock(
	client: FabricClient,
	opts: CommonOptions,
	destination: string,
	guard: SourceGuard,
	hint: string | undefined,
	published: PublishedInstructions,
): Promise<{
	lock: InstructionsLock | null;
	published: PublishedInstructions;
}> {
	const lock = await readLockForProject(destination, opts.project);
	if (lock?.digest === hint) {
		return { lock, published };
	}
	return {
		lock,
		published: await fetchPublished(client, opts, lock?.digest, guard),
	};
}

/**
 * A person's manual `sync` in a directory that may be a checkout of the
 * repository but cannot be shown to be a safe place to copy into: refused,
 * with the class line (Fizzy #2708 review — fail closed).
 */
function refuseManualSync(
	checkout: CheckoutClassification,
	repository: PublishedInstructions["repository"],
): CliFailure | null {
	if (checkout.class === "matching" || checkout.class === "not-git") {
		return null;
	}
	return new CliFailure(classLine(checkout, repository ?? null), 7);
}

function line(text: string): void {
	process.stdout.write(`${text}\n`);
}

/** The command that makes this checkout current, as this install runs it. */
function syncCommand(opts: { project: string }): string {
	return fabricCommand(`instructions sync --project ${opts.project}`);
}

/** What a push says when the published version has moved past the lock. */
function pullFirstLine(): string {
	return `published instructions moved past your last sync; run \`${fabricCommand("instructions sync")}\` then push again`;
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
	const client = instructionsClient(opts, CHECK_TIMEOUT_MS);
	const guard = new SourceGuard(destination, opts.remote);
	const hint = await lockDigestHint(root, opts.project);
	let published = await fetchPublished(client, opts, hint, guard);

	// A repository-sourced project (Fizzy #2708): what this directory is
	// decides what the check says. Outside any git checkout nothing changes;
	// in a checkout of the repository — or anything that might be one — a
	// hook prints only the one line below, and nothing at all when current.
	const checkout =
		guard.checkout === null
			? null
			: await reportForClassification({
					classification: guard.checkout,
					repository: published.repository,
					snapshot: published.snapshot,
					deadline: gitDeadline(),
				});
	const direct = directRepositoryRead(published);
	if (direct !== null && published.repository) {
		const status = await directRepositoryCheckoutStatus({
			repository: published.repository,
			direct,
			checkout: guard.checkout ?? { class: "not-git" },
			report:
				checkout ??
				(await reportForClassification({
					classification: { class: "not-git" },
					repository: published.repository,
					snapshot: undefined,
					deadline: gitDeadline(),
				})),
		});
		if (format === "json") {
			printOutput(
				{
					projectId: opts.project,
					destination,
					direct,
					checkout: checkout?.json ?? null,
				},
				{ format: "json" },
			);
		} else if (!opts.hook || !status.current) {
			process.stdout.write(`${status.line}\n`);
		}
		return;
	}
	if (
		opts.hook &&
		format !== "json" &&
		checkout !== null &&
		checkout.classification.class !== "not-git"
	) {
		if (checkout.line !== null) {
			line(checkout.line);
		}
		return;
	}

	// The lock only where this run may use it; elsewhere the report reads as
	// "not synced here", which is what such a directory is.
	let lock: InstructionsLock | null = null;
	if (usesLock(guard, !opts.hook)) {
		({ lock, published } = await validatedLock(
			client,
			opts,
			destination,
			guard,
			hint,
			published,
		));
	}

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
				checkout: checkout?.json ?? null,
			},
			{ format: "json" },
		);
		return;
	}

	// A checkout of the project's own repository has no lock and needs no
	// copy: git keeps it current. The lock-based report would tell its owner
	// it is "not synced" and to run `sync` "to take a copy", so here the
	// report is where the published commit came from, then where this
	// checkout stands against it.
	const repositoryCheckout =
		checkout?.classification.class === "matching" &&
		published.published &&
		published.repository &&
		published.snapshot
			? { repository: published.repository, snapshot: published.snapshot }
			: null;
	if (repositoryCheckout === null) {
		reportPublishedState(opts, lock, published);
	} else if (repositoryCheckout.snapshot.source?.kind === "REPOSITORY") {
		line(
			describeRepositorySource(
				repositoryCheckout.snapshot.source,
				repositoryCheckout.repository,
			),
		);
	}

	// The common tail. Every text-mode branch returns through here, because
	// `--verify` promises to report local drift and three of those branches
	// used to return before saying a word about it.
	if (opts.verify) {
		reportDrift(opts, drift);
	}
	if (checkout?.line) {
		line(checkout.line);
	} else if (repositoryCheckout !== null) {
		line(
			currentLine(
				repositoryCheckout.repository,
				repositoryCheckout.snapshot,
			),
		);
	}
}

/** What the server said about the published snapshot, in text. */
function reportPublishedState(
	opts: CommonOptions,
	lock: InstructionsLock | null,
	published: PublishedInstructions,
): void {
	if (!published.published) {
		line("This project has no published coding instructions yet.");
		return;
	}

	const version = published.snapshot?.version;
	const source = published.snapshot?.source;
	if (source?.kind === "REPOSITORY") {
		line(describeRepositorySource(source, published.repository ?? null));
	}

	if (!lock) {
		line(
			`Coding instructions have not been synced into this folder yet (published version ${version}, ${published.snapshot?.fileCount} files).`,
		);
		line(`Run \`${syncCommand(opts)}\` to take a copy.`);
		return;
	}

	if (published.unchanged) {
		// "the published version has not moved" — NOT "your files are
		// correct". Without `--verify` nothing local has been read at all, and
		// saying "up to date" invited exactly the wrong conclusion. A session
		// hook says nothing: its stdout becomes the agent's context at every
		// session start, and "nothing moved" is not worth that.
		if (!opts.hook) {
			line(
				`Published coding instructions unchanged (version ${version}).`,
			);
		}
		return;
	}

	if (published.changes === null || published.changes === undefined) {
		line(
			`Coding instructions changed, and the version in this folder is not one the server still recognises, so what changed cannot be listed. A full sync is needed (published version ${version}).`,
		);
		line(`Run \`${syncCommand(opts)}\` to apply.`);
		return;
	}

	const { added, changed, removed } = published.changes;
	line(
		`Coding instructions updated: ${added.length} added, ${changed.length} changed, ${removed.length} removed (version ${version}).`,
	);
	listPaths("added", added);
	listPaths("changed", changed);
	listPaths("removed", removed);
	line(`Run \`${syncCommand(opts)}\` to apply.`);
}

/**
 * The one extra line `check`'s text report adds for a repository-published
 * snapshot; nothing is added for `UPLOAD` (Fizzy #2709). The commit sha is
 * truncated to the same 12 characters this CLI already uses for a digest
 * prefix, with the same `…` marking it as shortened.
 *
 * `repository` is the project's CURRENT sync configuration, not necessarily
 * the one this particular snapshot published from — it is shown only when
 * `source.current` says this snapshot still matches it; otherwise the line
 * says so instead of naming a repository that may no longer apply.
 */
function describeRepositorySource(
	source: Extract<PublishedInstructionSource, { kind: "REPOSITORY" }>,
	repository: PublishedInstructionRepository | null,
): string {
	const commit = `${source.commitSha.slice(0, 12)}…`;
	const base = `published from ${commit} on ${source.ref}`;
	if (!source.current) {
		return `${base} (not the project's current sync configuration)`;
	}
	return repository ? `${base} (${repository.path})` : base;
}

/** What `--verify` found, in the two places the report can end. */
function reportDrift(opts: CommonOptions, drift: LedgerDrift[]): void {
	if (drift.length === 0) {
		line("Every file in this folder matches the lock.");
		return;
	}
	line(`${drift.length} local file(s) no longer match the lock:`);
	listPaths("drifted", drift.map(describeLedgerDrift));
	// Spec §6.4: `sync` puts back what is missing or chmod-ed, and keeps an
	// edit unless it is given `--repair`.
	const edits = drift.filter((entry) => entry.reason === "edited").length;
	if (edits < drift.length) {
		line(
			`Run \`${syncCommand(opts)}\` to put ${edits === 0 ? "them" : "the others"} back.`,
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
	const origin = deploymentOrigin(opts);
	const tree = await git.findWorkTree(root, Date.now() + GIT_BUDGET_MS);
	const report = await runDoctor({
		projectId: opts.project,
		org: orgSlugFor(opts),
		destination,
		root,
		commandDest: opts.dest === undefined ? undefined : destination,
		baseUrl: origin,
		remote: opts.remote,
		probeNetwork: Boolean(opts.probeNetwork),
		env: process.env,
		platform: process.platform,
		apiKeyPresent: Boolean(getApiKey(origin, opts.project)),
		projectSignIn: getOAuth(origin, opts.project) !== undefined,
		agentMcp: await agentRegistrationFacts({
			root,
			cwd: tree.kind === "ok" ? tree.value.toplevel : root,
			projectId: opts.project,
			origin,
			home: machine.home(),
			env: machine.env(),
			platform: machine.platform(),
		}),
		client: () =>
			instructionsClient({ ...opts, hook: false }, CHECK_TIMEOUT_MS),
		createDownloadUrl: (projectId, options) =>
			downloadUrlClient({
				...opts,
				hook: false,
			}).instructions.createDownloadUrl(projectId, options),
		fetchArchive: (url, maxBytes) =>
			fetchBundle(url, { timeoutMs: BUNDLE_TIMEOUT_MS, maxBytes }),
	});

	if (format === "json") {
		printOutput(report, { format: "json" });
	} else {
		process.stdout.write(
			formatDoctorText(
				report,
				opts.dest === undefined ? undefined : destination,
			),
		);
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
	opts: CommonOptions & {
		dryRun?: boolean;
		repair?: boolean;
		fastForward?: boolean;
	},
	format: OutputFormat,
): Promise<void> {
	const synced = await syncOnce(opts);
	if (synced.kind === "reported") {
		// A checkout of the repository (Fizzy #2708): the files arrive with
		// git, so this reports and writes nothing. `--dry-run` and `--repair`
		// describe a download, and there is none to shape.
		if (format === "json") {
			printOutput(
				{
					projectId: opts.project,
					destination: synced.destination,
					published: synced.published,
					reportOnly: synced.fastForward === null,
					version: synced.version,
					checkout: synced.checkout,
					...(synced.fastForward === null
						? {}
						: {
								fastForward: {
									outcome: synced.fastForward.outcome.kind,
								},
							}),
				},
				{ format: "json" },
			);
		} else if (synced.fastForward !== null) {
			// The hook's own fast-forward has said what happened: what the
			// session must know on stdout, the rest in the log.
			for (const text of synced.fastForward.stdout) {
				line(text);
			}
			for (const text of synced.fastForward.stderr) {
				process.stderr.write(`${text}\n`);
			}
		} else if (synced.checkout.line !== null) {
			line(synced.checkout.line);
		} else if (!opts.hook && synced.current !== null) {
			// The hook's silence means "current"; a person gets it in words.
			line(synced.current);
		}
		return;
	}
	const result = synced.outcome;
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

/**
 * What `syncOnce` did: applied the published snapshot, or — in a checkout of
 * a repository-sourced project's repository, or under a hook anywhere that
 * might be one — only reported, writing nothing (Fizzy #2708).
 */
type SyncResult =
	| { kind: "synced"; outcome: SyncOutcome }
	| {
			kind: "reported";
			destination: string;
			published: boolean;
			version: number | null;
			checkout: CheckoutJson;
			/** A manual run's words for "already current"; the hook says nothing. */
			current: string | null;
			/** What the session hook's fast-forward did, when it ran. */
			fastForward: FastForwardResult | null;
	  };

async function syncOnce(
	opts: CommonOptions & {
		dryRun?: boolean;
		repair?: boolean;
		/** `false` for `--no-fast-forward`: a hook that only reports. */
		fastForward?: boolean;
		/**
		 * `init`'s guard, already holding the response it classified the
		 * checkout from, so this sync's own responses are held to it.
		 */
		guard?: SourceGuard;
	},
): Promise<SyncResult> {
	const destination = destinationOf(opts);
	// Canonical, but not created yet: a run that only reports must not make
	// a directory. The lock is read from the same canonical path the writes
	// below resolve against.
	const existing = await resolveExistingRoot(destination);
	// Spec §6.4: a local edit to a synced file is the developer's, and only
	// `--repair` replaces it. `init`'s first sync keeps too: it never passes
	// `repair`.
	const keepLocalEdits = !opts.repair;

	const client = instructionsClient(opts, SYNC_TIMEOUT_MS);
	const guard = opts.guard ?? new SourceGuard(destination, opts.remote);
	const hint = await lockDigestHint(existing, opts.project);
	let published = await fetchPublished(client, opts, hint, guard);
	const direct = directRepositoryRead(published);
	const directRepository = published.repository;
	if (direct !== null) {
		if (
			guard.checkout === null ||
			guard.checkout.class !== "matching" ||
			directRepository === null ||
			directRepository === undefined
		) {
			throw new CliFailure(
				"This project reads coding instructions directly from its configured repository. Fabric does not copy them into this folder; open a matching native checkout or rerun init with --clone.",
				7,
			);
		}
		const report = await reportForClassification({
			classification: guard.checkout,
			repository: directRepository,
			snapshot: undefined,
			deadline: gitDeadline(),
		});
		const status = await directRepositoryCheckoutStatus({
			repository: directRepository,
			direct,
			checkout: guard.checkout,
			report,
		});
		const gitTransport =
			opts.hook && direct.gitGateway?.version === "v1"
				? await directGitTransport(opts, direct)
				: undefined;
		const fastForward =
			opts.hook && guard.checkout.class === "matching"
				? await runFastForward({
						classification: guard.checkout,
						repository: directRepository,
						snapshot: undefined,
						directCommitSha: direct.currentCommitSha,
						...(gitTransport === undefined ? {} : { gitTransport }),
						report: {
							...report,
							reportKind: status.current ? "current" : "behind",
							line: status.current ? null : status.line,
						},
						projectId: opts.project,
						deadline: gitDeadline(),
						optedOut: opts.fastForward === false,
						traceFile: traceFile(path.dirname(getConfigPath())),
					})
				: null;
		return {
			kind: "reported",
			destination: existing,
			published: false,
			version: null,
			checkout: {
				...report.json,
				line: status.current ? null : status.line,
			},
			current: status.current ? status.line : null,
			fastForward,
		};
	}

	if (guard.checkout !== null && !downloadsIn(guard.checkout, !opts.hook)) {
		const refused = opts.hook
			? null
			: refuseManualSync(guard.checkout, published.repository);
		if (refused !== null) {
			throw refused;
		}
		const report = await reportForClassification({
			classification: guard.checkout,
			repository: published.repository,
			snapshot: published.snapshot,
			deadline: gitDeadline(),
		});
		// A session hook in a checkout of the repository brings it up to date
		// when that is safe; `check` never does, and neither does a person's
		// own `sync`.
		const fastForward =
			opts.hook &&
			guard.checkout.class === "matching" &&
			published.repository
				? await runFastForward({
						classification: guard.checkout,
						repository: published.repository,
						snapshot: published.snapshot,
						report,
						projectId: opts.project,
						deadline: gitDeadline(),
						optedOut: opts.fastForward === false,
						traceFile: traceFile(path.dirname(getConfigPath())),
					})
				: null;
		return {
			kind: "reported",
			destination: existing,
			published: published.published,
			version: published.snapshot?.version ?? null,
			fastForward,
			checkout: report.json,
			current:
				report.line === null &&
				published.repository &&
				published.snapshot
					? currentLine(published.repository, published.snapshot)
					: null,
		};
	}

	let lock: InstructionsLock | null;
	({ lock, published } = await validatedLock(
		client,
		opts,
		existing,
		guard,
		hint,
		published,
	));

	// Canonical from here on: every write resolves against this, so a
	// symlinked `--dest` (or `/tmp` on macOS) is decided once rather than at
	// each write.
	const root = await resolveDestinationRoot(destination);
	const outcome = emptyOutcome(opts, root);

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
			return { kind: "synced", outcome };
		}

		outcome.drifted = drift.map(describeLedgerDrift);
		// The first call answered with a delta and therefore carries no
		// manifest. Ask again without a base digest: the plan needs the whole
		// published list to put the tree back.
		published = await fetchPublished(client, opts, undefined, guard);
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
	let manifest = assertValidManifest({
		manifest: published.manifest,
		snapshot: published.snapshot,
	});

	let plan = await computeSyncPlan(
		{ destination: root, manifest, lock },
		{ keepLocalEdits },
	);
	fillPlanPaths(outcome, plan);

	if (opts.dryRun) {
		// The plan is computable from the manifest alone, so a dry run
		// downloads nothing at all.
		return { kind: "synced", outcome };
	}

	let contents: FileContents = new Map<string, Uint8Array>();
	let staged: StagedFileContents | null = null;
	let applied: ApplyResult;
	try {
		for (
			let attempt = 0;
			plan.writes.length > 0 && attempt < 2;
			attempt++
		) {
			try {
				const byPath = new Map(
					manifest.map((entry) => [entry.path, entry]),
				);
				const large =
					manifest.reduce((total, entry) => total + entry.size, 0) >
					IN_MEMORY_SNAPSHOT_BYTES;
				if (
					large ||
					(attempt === 0 && plan.writes.length <= PER_FILE_MAX_WRITES)
				) {
					const options = {
						client,
						projectId: opts.project,
						org: orgSlugFor(opts),
						digest: published.snapshot.digest,
						files: plan.writes.map((entry) => ({
							path: entry.path,
							size: byPath.get(entry.path)?.size ?? -1,
							sha256: entry.sha256 ?? "",
						})),
						timeoutMs: opts.hook
							? hookDeadlineMs()
							: BUNDLE_TIMEOUT_MS,
						signal: activeDeadline,
					};
					if (large) {
						staged = await stageFilesByUrl(options);
						contents = staged;
					} else contents = await fetchFilesByUrl(options);
				} else {
					const download = await downloadUrlClient(
						opts,
					).instructions.createDownloadUrl(opts.project, {
						org: orgSlugFor(opts),
					});
					const archive = await fetchBundle(download.url, {
						timeoutMs: opts.hook
							? hookDeadlineMs()
							: BUNDLE_TIMEOUT_MS,
						maxBytes: maxArchiveBytes(manifest),
						signal: activeDeadline,
					});
					contents = extractBundle(
						archive,
						plan.writes.map((entry) => ({
							path: entry.path,
							size: byPath.get(entry.path)?.size ?? -1,
						})),
					);
				}
				break;
			} catch (error) {
				if (!(error instanceof PublishedChangedError) || attempt > 0)
					throw fixedFailure(error);
				published = await fetchPublished(
					client,
					opts,
					undefined,
					guard,
				);
				if (!published.published || !published.snapshot)
					throw new CliFailure(
						"This project has no published coding instructions yet.",
						4,
					);
				outcome.version = published.snapshot.version;
				outcome.digest = published.snapshot.digest;
				manifest = assertValidManifest({
					manifest: published.manifest,
					snapshot: published.snapshot,
				});
				plan = await computeSyncPlan(
					{ destination: root, manifest, lock },
					{ keepLocalEdits },
				);
				fillPlanPaths(outcome, plan);
			}
		}
		applied = await applyPlan({ root, plan, contents, keepLocalEdits });
	} finally {
		await staged?.dispose();
	}
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
			source: published.snapshot.source,
		},
		manifest,
		// Published hash plus `kept: true`: `push` diffs the edit against the
		// version everyone else has, and the next run still knows it was kept.
		kept: outcome.keptEdited,
	});
	await writeLock(root, lockToWrite);

	return { kind: "synced", outcome };
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
	if (
		total === 0 &&
		outcome.keptModified.length === 0 &&
		outcome.keptRenamed.length === 0 &&
		outcome.keptEdited.length === 0
	) {
		line("Everything in this folder already matched.");
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
 * The command that replaces kept edits. It carries the `--base-url` (when it
 * is not the default deployment), the `--org` and the resolved `--dest` this
 * run was given, so a pasted copy acts on the same deployment, project,
 * context and checkout: the rule doctor's generated fixes follow,
 * through the same guarded builder (Decision 42). `undefined` when a word
 * cannot be pasted safely, such as a `--dest` holding a newline.
 */
function repairCommand(opts: CommonOptions): string | undefined {
	const origin = deploymentOrigin(opts);
	return buildFabricCommand([
		"instructions",
		"sync",
		"--project",
		opts.project,
		...(origin !== DEFAULT_ORIGIN ? ["--base-url", origin] : []),
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
		: `\`${fabricCommand("instructions sync --repair")}\` with this run's --project and --dest`;
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
	/**
	 * Changes left out because one of the caller's open proposals already
	 * carries them (Fizzy #2739), each with the newest proposal that does.
	 */
	alreadyProposed: Array<{
		path: string;
		action: "put" | "delete";
		snapshotId: string;
		version: number | null;
		pullRequestState: string | null;
		pullRequestUrl: string | null;
	}>;
	/**
	 * Whether open proposals were checked: `skipped` under
	 * `--include-proposed`, `unavailable` (with the reason) when the lookup
	 * failed and every change was sent.
	 */
	openProposalCheck: {
		state: "checked" | "skipped" | "unavailable";
		reason: string | null;
	};
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
	 *
	 * `branch` and `append` are the member branch the suggestion is added to
	 * and what adding it did (Fizzy #2738 spec §10), null for a suggestion
	 * not on one or from a server that predates member branches. `url` is
	 * the branch's pull request once it has one.
	 */
	pullRequest: PushPullRequestStatus | null;
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
 * A change one of the caller's OPEN proposals already carries — same path,
 * same bytes — is left out and reported (Fizzy #2739): the lock names the
 * published version, which a proposal does not move, so without this a
 * second session on the same checkout re-sent the first one's change.
 * `--publish` follows the same rule: publishing a change that is waiting for
 * review would skip that review, under this push's name. `--include-proposed`
 * sends everything, as before. When the lookup is unavailable everything is
 * sent with a warning; see `lib/instructions/open-proposals.ts`.
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
		includeProposed?: boolean;
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
	const client = instructionsClient(
		{ ...opts, hook: false },
		PUSH_TIMEOUT_MS,
	);
	const published = await fetchPublished(client, opts);
	const direct = directRepositoryRead(published);
	if (direct && published.repository) {
		await runNativeInstructionPush({
			...opts,
			client,
			projectId: opts.project,
			root,
			repository: published.repository,
			direct,
			org: orgSlugFor(opts),
			format,
		});
		return;
	}
	const lock = await readLockForProject(root, opts.project);
	if (lock === null) {
		throw new CliFailure(
			`No coding-instructions lock in this folder. Run \`${syncCommand(opts)}\` first: a push is a diff against the version that was last applied here, and without that ledger there is nothing to diff against.`,
			7,
		);
	}

	// The SDK's ordinary retry policy. Retries used to be off here: the change
	// route wrote a snapshot row per POST, so a push whose response was lost
	// opened a second proposal for one edit. The route now recognises a change
	// set it has already admitted and answers with the proposal it opened, so
	// a retry repairs a dropped response instead of duplicating it.
	// BEFORE any file is read. Two questions, both answered by this one call:
	// is the lock still the published version, and is its ledger actually
	// that version's manifest.
	if (!published.published || !published.snapshot) {
		throw new CliFailure(
			"this project has no published coding instructions to change yet; the first version is uploaded from the Coding Instructions tab",
			4,
		);
	}
	if (published.snapshot.id !== lock.snapshotId) {
		// Exactly what the server would answer, decided locally so nothing is
		// read or sent first.
		throw new CliFailure(pullFirstLine(), 7);
	}

	const computed = await computePushPlan({
		root,
		lock,
		manifest: published.manifest ?? [],
		added: opts.add,
	});

	if (computed.entries.length === 0) {
		throw new CliFailure(
			`Nothing to push: every file the last sync wrote still matches version ${lock.snapshotVersion}. Add a new file with --add <path> if you meant to suggest one.`,
			7,
		);
	}

	// What the caller's open proposals already carry is left out (Fizzy
	// #2739). Asked only once there is something to send, and never under
	// --include-proposed, which sends everything exactly as before.
	let plan = computed;
	let alreadyProposed: AlreadyProposed[] = [];
	let openProposalCheck: PushOutcome["openProposalCheck"] = {
		state: "skipped",
		reason: null,
	};
	if (!opts.includeProposed) {
		const lookup = await lookUpOpenProposals(client, opts.project, {
			org: orgSlugFor(opts),
		});
		if (lookup.kind === "found") {
			({ plan, alreadyProposed } = setAsideProposed(
				computed,
				lookup.proposals,
				lock.snapshotId,
			));
			openProposalCheck = { state: "checked", reason: null };
		} else {
			openProposalCheck = { state: "unavailable", reason: lookup.reason };
			process.stderr.write(
				`Could not check your open proposals (${lookup.reason}), so nothing was left out: a change one of them already carries ${opts.dryRun ? "would be" : "is"} sent again.\n`,
			);
		}
	}

	if (plan.entries.length > MAX_PUSH_CHANGES) {
		throw new CliFailure(
			`Too many changes to push (${plan.entries.length} > ${MAX_PUSH_CHANGES}). A change set this large is a replacement rather than an edit — upload the folder from the project's Coding Instructions tab, which is also the only path that re-reads the project's exclusion rules.`,
			7,
		);
	}
	if (pushContentBytes(plan.entries) > MAX_INLINE_PUSH_BYTES) {
		throw new CliFailure(
			`The selected changes are too large to send inline (over ${MAX_INLINE_PUSH_BYTES} bytes of file content). Upload the folder from the project's Coding Instructions tab instead.`,
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
		alreadyProposed: alreadyProposed.map((entry) => ({
			path: entry.path,
			action: entry.action,
			snapshotId: entry.proposal.snapshotId,
			version: entry.proposal.version,
			pullRequestState: entry.proposal.pullRequest?.state ?? null,
			pullRequestUrl: entry.proposal.pullRequest?.url ?? null,
		})),
		openProposalCheck,
		snapshotId: null,
		version: null,
		proposalStatus: null,
		status: null,
		published: null,
		pullRequest: null,
	};

	// Everything left was already proposed. For a proposal that is the state
	// the developer wanted, and what repeating an identical push used to
	// answer, so it is reported and exits 0; a publish has not done what it
	// was asked, as "Nothing to push" has not, and exits 7 — after printing
	// the outcome under --format json, so a script still gets
	// `alreadyProposed` and `openProposalCheck` saying why.
	if (plan.entries.length === 0 && opts.publish) {
		if (format === "json") {
			printOutput(outcome, { format: "json" });
		}
		throw new CliFailure(
			`Nothing new to publish: every change here is already in an open proposal of yours (${proposalReferences(alreadyProposed)}), and publishing it from here would skip that proposal's review. Add --include-proposed to publish it anyway; nothing was sent.`,
			7,
		);
	}

	// Whether this push saw its member branch before the branch had a pull
	// request: then the pull request it ends on was opened for it, rather
	// than an existing one it was added to (spec §10's "Opened pull request"
	// against "Added to your pull request").
	let sawBranchWithoutPullRequest = false;
	const noteBranch = (pullRequest: ProposalPullRequest) => {
		if (pullRequest.branch && pullRequest.branch.pullRequest === null) {
			sawBranchWithoutPullRequest = true;
		}
	};

	if (!opts.dryRun && plan.entries.length > 0) {
		let changes: Awaited<ReturnType<typeof materializePushChanges>>;
		try {
			changes = await materializePushChanges({
				root,
				entries: plan.entries,
			});
		} catch (error) {
			throw new CliFailure(describeError(error), 7);
		}
		try {
			// Two methods, not one method with a flag: they are two routes
			// behind two scopes, and choosing between them here is what makes
			// a key that cannot publish fail with a scope refusal rather than
			// quietly proposing instead.
			const submitted = opts.publish
				? await client.instructions.publishChange(
						opts.project,
						lock.snapshotId,
						changes,
						{ org: orgSlugFor(opts) },
					)
				: await client.instructions.submitChange(
						opts.project,
						lock.snapshotId,
						changes,
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
			if (submitted.pullRequest) {
				noteBranch(submitted.pullRequest);
			}
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
				{ org: orgSlugFor(opts), observe: noteBranch },
			);
		} catch (error) {
			const failure = fixedFailure(error);
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
		? pullRequestVerdict(outcome.pullRequest, {
				waited: opts.wait !== false,
				openedHere: sawBranchWithoutPullRequest,
			})
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

/**
 * The refusals a push has to say something useful about, by the reason code
 * the route sends (`packages/api/modules/v1/instructions.ts`).
 *
 * Everything else falls through to `asFixedFailure`'s status mapping, which is
 * already right for auth, permission and rate limits.
 */
function asPushFailure(error: unknown): CliFailure {
	const code = (error as { code?: string }).code;
	switch (code) {
		case "PULL_FIRST":
			return new CliFailure(pullFirstLine(), 7);
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
			return outcomeFailure("proposal-limit-proposer", {});
		case "PROPOSAL_PROJECT_LIMIT":
			return outcomeFailure("proposal-limit-project", {});
		// A repository-backed project's admission (Fizzy #2563 spec §5.3).
		case "REPOSITORY_UNAVAILABLE":
			return outcomeFailure("repository-needs-attention", {});
		case "REPOSITORY_BASE_UNAVAILABLE":
			return new CliFailure(
				`this project's published instructions are not a sync of its repository as it is configured now; sync the project from its Coding Instructions tab, run \`${fabricCommand("instructions sync")}\`, then push again; nothing was sent`,
				7,
			);
		case "NOTE_REJECTED":
			return outcomeFailure("note-rejected", {});
		default:
			return fixedFailure(error);
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
			return `Published version ${outcome.version}. Run \`${fabricCommand("instructions sync")}\` to bring this checkout onto it.`;
		}
		if (outcome.status === "FAILED" || outcome.status === "REJECTED") {
			return `Version ${outcome.version} did not pass its checks (${outcome.status}), so nothing was published; open the project's Coding Instructions tab to see why.`;
		}
		const sent = `Sent as version ${outcome.version}. It publishes on its own once its checks pass (${outcome.status}) — then run \`${fabricCommand("instructions sync")}\` to bring this checkout onto it.`;
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
			return `Suggested as version ${outcome.version}. This project's coding instructions come from its repository, so once the files pass their checks Fabric adds the change to your pull request there, opening one if you have none, and it is reviewed and merged in the repository.`;
		}
		return `Proposed as version ${outcome.version}. It is pending review — nothing is published until somebody who can edit this project's coding instructions approves it in the Coding Instructions tab.`;
	}
	if (outcome.proposalStatus === "APPROVED") {
		return `Version ${outcome.version} has already been approved and published — run \`${fabricCommand("instructions sync")}\` to bring this checkout up to it.`;
	}
	return `Version ${outcome.version} is no longer open for review (${outcome.proposalStatus ?? outcome.status}): an earlier attempt at this same change was closed out, so push again.`;
}

function reportPush(outcome: PushOutcome): void {
	// Only reachable for a proposal whose every change is already proposed:
	// nothing was sent, on a dry run or not.
	if (outcome.put.length === 0 && outcome.deleted.length === 0) {
		line(
			"Nothing new to push: every change here is already in your open proposals.",
		);
		reportAlreadyProposed(outcome);
		return;
	}

	const prefix = outcome.dryRun ? "Would send" : "Sent";
	const proposed =
		outcome.alreadyProposed.length > 0
			? `, ${outcome.alreadyProposed.length} already proposed`
			: "";
	line(
		`${prefix} ${outcome.put.length} changed file(s) and ${outcome.deleted.length} deletion(s) against version ${outcome.baseVersion} (${outcome.unchanged} unchanged${proposed}).`,
	);
	listPaths("changed", outcome.put);
	listPaths("deleted", outcome.deleted);
	reportAlreadyProposed(outcome);

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
			? `Your lock was not changed: it still names version ${outcome.baseVersion}, which is what \`${fabricCommand("instructions sync")}\` compares against.`
			: `Your lock was not changed: it still names the published version, which is what \`${fabricCommand("instructions sync")}\` compares against.`,
	);
}

/**
 * Which open proposal carries a change, in the words a developer can find it
 * by: its version, and its pull request when it has one.
 */
function proposalReference(proposal: {
	version: number | null;
	pullRequestState: string | null;
	pullRequestUrl: string | null;
}): string {
	if (proposal.version === null)
		return proposal.pullRequestUrl
			? `pull request ${proposal.pullRequestUrl}`
			: "a repository suggestion";
	if (proposal.pullRequestUrl) {
		return `version ${proposal.version}, pull request ${proposal.pullRequestUrl}`;
	}
	if (proposal.pullRequestState) {
		return `version ${proposal.version}, whose pull request is being opened`;
	}
	return `version ${proposal.version}`;
}

/** Every proposal named in `alreadyProposed`, once each, newest first. */
function proposalReferences(alreadyProposed: AlreadyProposed[]): string {
	const byVersion = new Map<number, string>();
	for (const entry of alreadyProposed) {
		if (entry.proposal.version === null) continue;
		byVersion.set(
			entry.proposal.version,
			proposalReference({
				version: entry.proposal.version,
				pullRequestState: entry.proposal.pullRequest?.state ?? null,
				pullRequestUrl: entry.proposal.pullRequest?.url ?? null,
			}),
		);
	}
	return [...byVersion.entries()]
		.sort(([a], [b]) => b - a)
		.map(([, reference]) => reference)
		.join("; ");
}

function reportAlreadyProposed(outcome: PushOutcome): void {
	if (outcome.alreadyProposed.length === 0) {
		return;
	}
	line("  already proposed, not sent:");
	for (const entry of outcome.alreadyProposed) {
		const what = entry.action === "delete" ? "deletion already" : "already";
		line(
			`    ${entry.path} — ${what} proposed in ${proposalReference(entry)}`,
		);
	}
	line(
		outcome.publish
			? `Left out because an open proposal of yours already carries the same change, and publishing it from here would skip that proposal's review; add --include-proposed to publish it anyway. Once this version publishes, that proposal is stated against an older version and can no longer be approved: run \`${fabricCommand("instructions sync")}\`, then push again to propose those files afresh.`
			: "Left out because an open proposal of yours already carries the same change; add --include-proposed to send it anyway.",
	);
}

// ---------------------------------------------------------------------------
// init
// ---------------------------------------------------------------------------

/** A clone of a large repository may take a while; nothing else here does. */
const CLONE_TIMEOUT_MS = 5 * 60_000;

async function isEmptyFolder(folder: string): Promise<boolean> {
	try {
		return (await readdir(folder)).length === 0;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "ENOENT";
	}
}

/**
 * Clone the project's repository into the (empty) folder, when the person
 * wants that: `--clone`, or a yes at the prompt. Returns what the folder is
 * now, for the same classification as for any checkout.
 */
async function cloneProjectRepository(
	opts: CommonOptions & { clone?: boolean | string },
	destination: string,
	repository: PublishedInstructionRepository | null,
	transport: { url: string; authorization: string } | null,
): Promise<CheckoutClassification> {
	if (repository === null) {
		throw outcomeFailure("no-clone-url", { repo: "its repository" });
	}
	const repo = repositoryName(repository);
	// Before anyone is asked: a clone that could only contact some other host
	// than the one shown is never offered.
	const providerUrl = cloneUrlFor(repository);
	if (providerUrl === null) {
		throw outcomeFailure("no-clone-url", { repo });
	}
	const url = transport?.url ?? providerUrl;
	const ref = sanitizeDisplayText(repository.ref, 255);
	const wanted =
		opts.clone !== undefined ||
		(canPrompt() &&
			(await confirm(`Clone ${repo} (${ref}) into this folder?`)));
	if (!wanted) {
		throw outcomeFailure("empty-folder", { repo, ref });
	}
	const root = await resolveDestinationRoot(destination);
	await assertKeyOutside(root);
	const result = await git.cloneInto(
		root,
		url,
		repository.ref,
		Date.now() + CLONE_TIMEOUT_MS,
		transport === null ? {} : { httpAuthorization: transport },
	);
	if (result.kind !== "cloned") {
		throw outcomeFailure("clone-failed", {
			repo,
			ref: repository.ref,
			host: repository.host,
			url: shellQuote(providerUrl),
			reason:
				result.kind === "failed" && result.reason !== "not-empty"
					? result.reason
					: "other",
			login: providerLoginCommand(
				repository.provider,
				`git ls-remote ${shellQuote(url)}`,
			),
		});
	}
	if (transport !== null) {
		const restored = await git.setRemoteUrl(
			root,
			"origin",
			providerUrl,
			Date.now() + CLONE_TIMEOUT_MS,
		);
		if (restored.kind !== "ok") {
			throw new CliFailure(
				"Fabric cloned the repository but could not restore its provider remote. Remove this new checkout and run init again.",
				7,
			);
		}
	}
	return classifyCheckout({
		destination: root,
		repository,
		deadline: gitDeadline(),
		remote: opts.remote,
	});
}

function toHookTool(tool: string): InstructionsHookTool {
	if (!isInstructionsHookTool(tool)) {
		throw outcomeFailure("unknown-tool", { tool });
	}
	return tool;
}

async function runInit(
	opts: CommonOptions & {
		tool?: string;
		apply?: boolean;
		reportOnly?: boolean;
		lessons?: boolean;
		clone?: boolean | string;
		/** False under `--no-mcp`: the tools' MCP servers are left alone. */
		mcp?: boolean;
	},
	format: OutputFormat,
): Promise<void> {
	const explicitTool =
		opts.tool === undefined ? undefined : toHookTool(opts.tool);

	// Before any write: Codex has no wired Stop hook for lesson capture yet,
	// so a `--lessons` request against it is refused rather than silently
	// dropped or half-applied.
	if (opts.lessons && explicitTool === "codex") {
		throw outcomeFailure("lessons-need-claude", {});
	}

	// `--clone <folder>` names a folder of its own, under the current one (or
	// `--dest`): refused now if it holds anything, made when the clone is.
	const cloneFolder = typeof opts.clone === "string" ? opts.clone : undefined;
	let destination = destinationOf(opts);
	if (cloneFolder !== undefined) {
		destination = await resolveCloneFolder(destination, cloneFolder);
	}
	// Not created yet: a refusal below must leave nothing behind.
	let existing = await resolveExistingRoot(destination);
	let cloned = false;
	const freshCloneDestination =
		cloneFolder !== undefined && (await isEmptyFolder(destination));

	// A local precondition answered before any network call: a credential
	// file that would end up inside the checkout.
	await assertKeyOutside(existing);

	const client = instructionsClient(opts, SYNC_TIMEOUT_MS);
	const guard = new SourceGuard(
		destination,
		opts.remote,
		freshCloneDestination,
	);
	const published = await fetchPublished(client, opts, undefined, guard);
	const direct = directRepositoryRead(published);
	let repositoryTransportApproved = false;

	// A repository-sourced project, classified once, here. The folder is, or
	// becomes, a clone of the repository with its own `.git`: nothing is
	// downloaded and no lock is written, so existing files are never touched.
	// A folder that cannot be set up as one is refused with the command that
	// gets the person to a state that can (`adoption.ts`).
	const repository = published.repository ?? null;
	let checkout = guard.checkout;
	if (cloneFolder !== undefined && checkout === null) {
		throw outcomeFailure("clone-needs-repository", {});
	}
	if (checkout !== null) {
		const rerun = {
			project: opts.project,
			tool: opts.tool,
			dest: opts.dest,
		};
		const planned = adoptionFor({
			classification: checkout,
			repository,
			destination: existing,
			folderEmpty: await isEmptyFolder(existing),
			rerun,
		});
		if (planned.kind === "refused") {
			throw planned.failure;
		}
		if (planned.kind === "empty-folder") {
			let transport: { url: string; authorization: string } | null = null;
			if (direct?.gitGateway?.version === "v1") {
				await ensureRepositoryTransportScope(opts, client);
				repositoryTransportApproved = true;
				transport = await directGitTransport(opts, direct);
			}
			checkout = await cloneProjectRepository(
				opts,
				destination,
				repository,
				transport,
			);
			cloned = true;
			// The instructions may live in a folder of the repository. With a
			// folder of its own the run carries on there; without one it stops
			// and says where, below.
			if (cloneFolder !== undefined && checkout.class === "unmapped") {
				destination = path.join(checkout.toplevel, checkout.rootPath);
				existing = await resolveExistingRoot(destination);
				checkout = await classifyCheckout({
					destination: existing,
					repository,
					deadline: gitDeadline(),
					remote: opts.remote,
				});
			}
			const after = adoptionFor({
				classification: checkout,
				repository,
				destination: existing,
				folderEmpty: false,
				rerun,
			});
			if (after.kind === "refused") {
				if (
					cloneFolder === undefined &&
					checkout.class === "unmapped" &&
					repository !== null
				) {
					const next = outcomeLine("cloned-needs-folder", {
						repo: repositoryName(repository),
						ref: repository.ref,
						where: folderForCommand(opts.dest, repository.rootPath),
					});
					if (format === "json") {
						printOutput(
							{
								projectId: opts.project,
								cloned: true,
								checkout: { class: checkout.class },
							},
							{ format: "json" },
						);
					} else {
						line(next);
					}
					return;
				}
				throw after.failure;
			}
		}
	}
	const matching = checkout?.class === "matching" ? checkout : null;
	const interrupted =
		matching === null
			? null
			: await git.checkoutAppearsIncomplete(
					matching.toplevel,
					gitDeadline(),
				);
	if (interrupted?.kind === "ok" && interrupted.value) {
		throw outcomeFailure("clone-checkout-needs-repair", {});
	}
	// A lock that belongs to another project, checked only where a lock is
	// used: a checkout of the repository never has one, and whatever is left
	// there must not stop the hook being installed (Fizzy #2708 review).
	if (matching === null) {
		await readLockForProject(existing, opts.project);
	}

	const root = await resolveDestinationRoot(destination);
	if (root !== existing) {
		// The directory did not exist a moment ago; the key check is about
		// real paths, so it is asked again of the one that now does.
		await assertKeyOutside(root);
	}

	// Which coding tools get a hook: the one named, or every one found. Read
	// after any clone, because a repository may carry `.claude` or `.codex`.
	const tools: DetectedTools =
		explicitTool === undefined
			? await detectTools({
					root,
					home: machine.home(),
					lookup: {
						env: machine.env(),
						platform: machine.platform(),
					},
				})
			: { tools: [explicitTool], detected: true };
	if (opts.lessons && !tools.tools.includes("claude-code")) {
		throw outcomeFailure("lessons-need-claude", {});
	}
	if (matching !== null) {
		const prefix = path.relative(matching.toplevel, root);
		const relativeSetupPaths = [
			...tools.tools.map((tool) =>
				path.join(prefix, hookPathFor(tool)).replaceAll(path.sep, "/"),
			),
			path
				.join(prefix, LOCK_DIRECTORY, LOCK_FILENAME)
				.replaceAll(path.sep, "/"),
		];
		const tracked = await git.trackedPaths(
			matching.toplevel,
			relativeSetupPaths,
			gitDeadline(),
		);
		if (tracked.kind !== "ok") {
			throw new CliFailure(
				"Fabric could not verify whether its local setup files are tracked by Git, so it did not modify them. Check git status and run init again.",
				7,
			);
		}
		if (tracked.value.length > 0) {
			throw new CliFailure(
				`Fabric left this checkout unchanged because Git tracks setup file${tracked.value.length === 1 ? "" : "s"}: ${tracked.value.join(", ")}. Keep ${tracked.value.length === 1 ? "it" : "them"} under the repository's normal setup process, or configure Fabric's hook and agent integration manually outside tracked paths.`,
				7,
			);
		}
	}
	if (
		direct?.gitGateway?.version === "v1" &&
		matching !== null &&
		!repositoryTransportApproved
	) {
		await ensureRepositoryTransportScope(opts, client);
		repositoryTransportApproved = true;
	}

	let outcome: SyncOutcome | null = null;
	if (checkout === null && published.published) {
		// A second manifest call, deliberately: the one above answered "may a
		// hook be installed for this project at all", and this one is the
		// sync's own — held to the first by the same guard. Do it before the
		// hook write: a failed first copy must not leave a new or updated
		// hook behind.
		const synced = await syncOnce({ ...opts, hook: false, guard });
		if (synced.kind !== "synced") {
			throw new CliFailure(
				"the first copy was not taken; nothing else was written",
				7,
			);
		}
		outcome = synced.outcome;
	}

	// A repository project's hook fast-forwards the checkout when that is safe
	// (`sync`); `--report-only` writes one that only reports (`check`). An
	// uploaded project's hook reports unless `--apply`.
	const fastForwards = matching !== null && !opts.reportOnly;
	const applies = opts.reportOnly
		? false
		: matching !== null
			? true
			: Boolean(opts.apply);
	// What the hook runs to start this CLI. A person with only the npx line has
	// no `fabric`, so the served build keeps a copy of itself for the hook.
	const launcher = await resolveHookLauncher({
		origin: deploymentOrigin(opts),
		configDirectory: path.dirname(getConfigPath()),
		lookup: { env: machine.env(), platform: machine.platform() },
		bundle: isServedBundle() ? { scriptPath: bundleScriptPath() } : null,
	});
	const command = buildHookCommand(
		opts.project,
		applies,
		opts.org,
		{ baseUrl: deploymentOrigin(opts), remote: opts.remote },
		launcher.prefix,
	);
	const hooks = await installHooks({
		root,
		projectId: opts.project,
		tools: tools.tools,
		command,
		lessonsCommand: buildLessonPromptCommand(
			opts.project,
			opts.org,
			launcher.prefix,
		),
		lessons: Boolean(opts.lessons),
	});

	// Keep the per-machine files out of the developer's commits, in the
	// repository's own local ignore file and never in `.gitignore`.
	let toplevel: string | null = matching?.toplevel ?? null;
	if (checkout === null) {
		const tree = await git.findWorkTree(root, gitDeadline());
		toplevel = tree.kind === "ok" ? tree.value.toplevel : null;
	}
	const excluded =
		toplevel === null
			? null
			: await excludeLocalFiles({
					toplevel,
					directory: root,
					files: [
						...hooks.map((hook) => hookPathFor(hook.tool)),
						...(checkout === null ? [LOCK_DIRECTORY] : []),
					],
					deadline: gitDeadline(),
				});

	// An upload-era lock has no use in a checkout git keeps current.
	const lockRemoved =
		matching === null ? false : await dropOwnLock(root, opts.project);

	// The project's own MCP server, for each tool found: after the hook, so
	// nothing here can leave the hook unwritten. A tool that was only the
	// fallback, because none was found, is not asked.
	const mcpRequested =
		opts.mcp !== false && (tools.detected || explicitTool !== undefined);
	const mcp = !mcpRequested
		? []
		: await registerAgentMcp({
				tools: tools.tools,
				projectId: opts.project,
				origin: deploymentOrigin(opts),
				cwd: toplevel ?? root,
				home: machine.home(),
				env: machine.env(),
				platform: machine.platform(),
				run: createAgentRunner({
					lookup: {
						env: machine.env(),
						platform: machine.platform(),
					},
				}),
				interactive:
					format !== "json" &&
					canPrompt() &&
					process.stdout.isTTY === true &&
					!runningInCi(),
			});
	const mcpComplete = !mcpRequested || mcpRegistrationComplete(mcp);
	const mcpAuthPending = mcpAuthenticationPending(mcp);

	const first = hooks[0];
	if (format === "json") {
		printOutput(
			{
				projectId: opts.project,
				destination: root,
				settingsPath: first?.settingsPath,
				hookCommand: command,
				hookWarning: launcher.warning,
				createdSettingsFile: first?.createdFile,
				replacedHooks: first?.replacedCount,
				hooks: hooks.map((hook) => ({
					tool: hook.tool,
					settingsPath: hook.settingsPath,
					createdSettingsFile: hook.createdFile,
					replacedHooks: hook.replacedCount,
				})),
				lessonsHook: Boolean(opts.lessons),
				mcpRequested,
				mcpComplete,
				mcpAuthenticationPending: mcpAuthPending,
				mcp: mcp.map((result) => ({
					tool: result.tool,
					name: result.name,
					url: result.url,
					outcome: result.outcome.kind,
					login: result.login,
					registerLine: result.registerLine,
					loginLine: result.loginLine,
				})),
				sync: outcome,
				lockRemoved,
				excluded: excluded?.kind ?? null,
				checkout:
					checkout === null
						? null
						: matching !== null
							? { class: matching.class, remote: matching.remote }
							: { class: checkout.class },
			},
			{ format: "json" },
		);
		if (!mcpComplete) {
			throw new CliFailure(
				"Coding tool setup is incomplete: the Fabric MCP server was not registered for every selected tool. Complete the action shown above, then run init again.",
				7,
			);
		}
		return;
	}

	for (const hook of hooks) {
		if (hook.lessons === "added") {
			line("Added a Stop hook for lesson capture.");
		} else if (hook.lessons === "removed") {
			line("Removed the Stop hook for lesson capture.");
		}
	}
	if (matching !== null && repository !== null && direct !== null) {
		const report = await reportForClassification({
			classification: matching,
			repository,
			snapshot: undefined,
			deadline: gitDeadline(),
		});
		line(
			(
				await directRepositoryCheckoutStatus({
					repository,
					direct,
					checkout: matching,
					report,
				})
			).line,
		);
	} else if (matching !== null && repository !== null) {
		if (published.snapshot?.source?.kind !== "REPOSITORY") {
			line(nothingPublishedLine(repository));
		}
	} else if (outcome === null) {
		line(
			"This project has nothing published yet, so there is nothing to copy — the hook will pick it up once there is.",
		);
	} else {
		reportSync(outcome, opts);
	}
	if (lockRemoved && repository !== null) {
		line(outcomeLine("lock-removed", { repo: repositoryName(repository) }));
	}
	if (excluded?.kind === "failed") {
		line(outcomeLine("exclude-failed", { entries: excluded.entries }));
	}
	if (!tools.detected) {
		line(outcomeLine("no-tool-detected", {}));
	}
	if (launcher.warning !== null) {
		line(launcher.warning);
	}
	for (const mcpLine of agentMcpLines(mcp)) {
		line(mcpLine);
	}
	if (mcpAuthPending) {
		line(
			"The Fabric MCP server is registered, but its coding-tool sign-in is still pending.",
		);
	}
	if (cloneFolder !== undefined && cloned) {
		line(
			outcomeLine("cloned-into", {
				where: folderForCommand(
					opts.dest,
					path.relative(
						await resolveExistingRoot(destinationOf(opts)),
						root,
					),
				),
			}),
		);
	}
	if (!mcpComplete) {
		line(
			"The session hook was set up, but the Fabric MCP server was not registered for every selected tool.",
		);
		throw new CliFailure(
			"Coding tool setup is incomplete: the Fabric MCP server was not registered for every selected tool. Complete the action shown above, then run init again.",
			7,
		);
	}
	line(
		outcomeLine("set-up", {
			repo:
				matching !== null && repository !== null
					? repositoryName(repository)
					: null,
			ref:
				matching !== null && repository !== null
					? repository.ref
					: null,
			tools: hooks.map((hook) => hook.tool),
			applies: applies && matching === null,
			fastForwards,
		}),
	);
}

async function assertKeyOutside(root: string): Promise<void> {
	try {
		await assertKeyStaysOutside(root, getConfigPath());
	} catch (error) {
		throw new CliFailure(describeError(error), 7);
	}
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
