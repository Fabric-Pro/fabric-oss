/**
 * fabric context
 *
 *   fabric context push <dir...> --project <id>   Sync local knowledge folders
 *                                                 into the project's Context,
 *                                                 one after another.
 *   fabric context reset --project <id> [dir]     Delete every synced file of
 *                                                 the project (`reset.ts`).
 *
 * Several folders are pushed in order, each with its own lock and report; a
 * folder that fails does not stop the next, and the run exits with the first
 * failure's code. `--init` ignores and replaces each folder's lock, so after
 * a Living Memory reset every file is sent as new. Progress goes to stderr,
 * one `[n/total]` line per request (a `--force` resend included), and
 * `--timeout` bounds each folder's push as a whole.
 *
 * PROJECT Context — the knowledge sources a project's AI features read — and
 * not `fabric ctx`, which switches the CLI's default organization and never
 * talks to a project.
 *
 * Every file under `<dir>` that the ignore rules leave in and that is text is
 * pushed by its relative path, one request per file, through
 * `PUT /api/v1/projects/:projectId/contexts/synced-files`. The lock at
 * `<dir>/.fabric/context.lock` remembers what the server confirmed, so a file
 * that has not changed is not sent again, and a file that has changed names
 * the version it replaces — which is what turns somebody else's edit on the
 * server into a conflict instead of a silent overwrite.
 *
 * A file moved or renamed with its content unchanged is one rename on the
 * server, keeping its history and its place in the Context tab. A file
 * removed locally keeps its server entry unless `--prune` is given; then it
 * is deleted, but only in the version the lock names, so an edit somebody
 * made on the server since is a conflict rather than lost (Fizzy #2636).
 *
 * A path a Living Memory repository sync owns refuses a create, a replace, a
 * move or a `--prune` delete the same way every time: nothing is written,
 * it is reported as skipped, and `--force` never retries it — the file
 * changes in the repository, not here (Living Memory design 2026-09-23 §6).
 *
 * Everything that touches the filesystem lives in `lib/context-sync/`; this
 * file is argument parsing, the sequence, and the exit code.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { FabricClient } from "@fabricorg/sdk";
import { Command, InvalidArgumentError } from "commander";
import { getClient } from "../../lib/client.js";
import {
	CliFailure,
	describeError,
	type OutputFormat,
	outputFormatFor,
	withDeadline,
} from "../../lib/command-boundary.js";
import { getApiKey } from "../../lib/config.js";
import { contextCliFailure } from "../../lib/context-sync/failure.js";
import {
	type ContextLock,
	contextLockPath,
	emptyContextLock,
	readContextLock,
	writeContextLock,
} from "../../lib/context-sync/lock.js";
import {
	findMissingOnServer,
	type MissingOnServer,
	NOTHING_MISSING,
} from "../../lib/context-sync/missing-on-server.js";
import {
	type ContextPlan,
	computeContextPlan,
} from "../../lib/context-sync/plan.js";
import { stderrProgress } from "../../lib/context-sync/progress.js";
import {
	type ContextPushResult,
	DELETE_STATUSES,
	nextContextLock,
	pushContextPlan,
} from "../../lib/context-sync/push.js";
import {
	contextPushJson,
	formatDryRunReport,
	formatPushReport,
} from "../../lib/context-sync/report.js";
import { resolveExistingRoot } from "../../lib/instructions/safe-write.js";
import { fabricCommand } from "../../lib/launcher.js";
import { printOutput } from "../../lib/output.js";
import { registerContextAssembleCommand } from "./assemble.js";
import { registerContextDocumentCommands } from "./documents.js";
import { registerContextManifestCommand } from "./manifest.js";
import { registerContextQualityCommands } from "./quality.js";
import { registerContextResetCommand } from "./reset.js";

/**
 * Hook mode's one absolute deadline, the same bound `fabric instructions`
 * uses. A hook that cannot finish in time leaves the lock as it was, and the
 * next run finishes the job: content the server already holds is answered
 * `unchanged` and recorded then.
 */
const HOOK_DEADLINE_MS = 10_000;

/** Per request, outside hook mode. A file is at most 2 MiB. */
const PUSH_TIMEOUT_MS = 60_000;

interface PushOptions {
	project: string;
	org?: string;
	force?: boolean;
	dryRun?: boolean;
	prune?: boolean;
	hook?: boolean;
	exclude?: string[];
	/** Ignore and replace each folder's lock: every file is sent as new. */
	init?: boolean;
	/** The overall bound on each folder's push, in milliseconds. */
	timeout?: number;
	/** Read through `optsWithGlobals()`, never off this object. */
	format?: string;
}

function collectPattern(value: string, previous: string[]): string[] {
	return [...previous, value];
}

/** `--timeout <seconds>`, a positive whole number, as milliseconds. */
function parseTimeoutSeconds(value: string): number {
	if (!/^\d+$/.test(value) || Number(value) <= 0) {
		throw new InvalidArgumentError(
			"--timeout takes a positive whole number of seconds.",
		);
	}
	return Number(value) * 1000;
}

export function buildContextCommand(): Command {
	const context = new Command("context").description(
		"Manage project Context and check recorded-output quality",
	);

	context
		.command("push")
		.description(
			"Push every text file under each <dir> into the project's Context by its relative path",
		)
		.argument(
			"<dir...>",
			"Folders to push, in order, each with its own lock (required; never the working directory by default)",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option(
			"--force",
			"On a conflict, replace the server's version once with this folder's; never retries a path a repository sync owns",
		)
		.option(
			"--prune",
			"Delete the server entries of files removed locally, only in the version last pushed",
		)
		.option("--dry-run", "Print the plan; send nothing and write no lock")
		.option(
			"--exclude <pattern>",
			"Also leave out paths matching this gitignore pattern (repeatable)",
			collectPattern,
			[] as string[],
		)
		.option(
			"--hook",
			"Hook mode: never fails, never blocks, one line on stderr on failure",
		)
		.option(
			"--init",
			"Ignore and replace each folder's lock and send every file as new, e.g. after a Living Memory reset",
		)
		.option(
			"--timeout <seconds>",
			"Stop each folder's push after this many seconds, keeping what the server confirmed (default: no overall bound; each request has its own)",
			parseTimeoutSeconds,
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			dirs: string[],
			opts: PushOptions,
		) {
			await run(opts, () =>
				runPushAll(dirs, opts, outputFormatFor(this)),
			);
		});

	registerContextResetCommand(context, {
		run,
		client: contextClient,
		resolveFolder,
	});
	registerContextManifestCommand(context);
	registerContextAssembleCommand(context);
	registerContextDocumentCommands(context);
	registerContextQualityCommands(context);
	return context;
}

/**
 * Every failure becomes an exit code or, under `--hook`, one line on stderr
 * and a zero exit — the same contract as `fabric instructions`, so a hook
 * that pushes notes can never be what stops a session or a commit.
 */
async function run(
	opts: { hook?: boolean },
	body: () => Promise<void>,
	subcommand = "push",
): Promise<void> {
	try {
		if (opts.hook) {
			await withDeadline(HOOK_DEADLINE_MS, () => body());
		} else {
			await body();
		}
	} catch (error) {
		const message = describeError(error);
		if (opts.hook) {
			process.stderr.write(
				`fabric: context ${subcommand} failed: ${message}\n`,
			);
			process.exit(0);
		}
		process.stderr.write(`✗ ${message}\n`);
		process.exit(error instanceof CliFailure ? error.exitCode : 1);
	}
}

/**
 * A client that throws instead of exiting (`getClient` exits 3 on a missing
 * key, which would break the hook contract), with retries off in hook mode.
 *
 * Retries stay ON otherwise, and that is safe for this route in particular:
 * the same content at the same path is answered `unchanged` before the
 * expected hash is compared, so a retry of a request whose response was lost
 * reports the first attempt's write rather than making another.
 *
 * `withoutContext()`: the project decides which organization it is in, so an
 * ambient `FABRIC_ORG` must not bind the request; `--org` still does.
 */
function contextClient(opts: {
	hook?: boolean;
	timeout?: number;
}): FabricClient {
	if (!getApiKey()) {
		throw new CliFailure(
			`Not authenticated. Run: ${fabricCommand("auth login")}`,
			3,
		);
	}
	return getClient(
		opts.hook
			? { timeoutMs: HOOK_DEADLINE_MS, retry: { maxRetries: 0 } }
			: // A request never outlives an overall --timeout shorter than
				// its own bound.
				{
					timeoutMs: Math.min(
						PUSH_TIMEOUT_MS,
						opts.timeout ?? PUSH_TIMEOUT_MS,
					),
				},
	).withoutContext();
}

async function resolveFolder(dir: string): Promise<string> {
	const directory = path.resolve(dir);
	const root = await resolveExistingRoot(directory);
	const stats = await lstat(root).catch(() => null);
	if (stats === null || !stats.isDirectory()) {
		throw new CliFailure(`${directory} is not a directory.`, 2);
	}
	return root;
}

/** The lock, refused when damaged or when it belongs to another project. */
async function readLockForProject(
	root: string,
	projectId: string,
): Promise<ContextLock | null> {
	let lock: ContextLock | null;
	try {
		lock = await readContextLock(root);
	} catch (error) {
		throw new CliFailure(describeError(error), 7);
	}
	if (lock !== null && lock.projectId !== projectId) {
		throw new CliFailure(
			`${contextLockPath(root)} belongs to project ${lock.projectId}, not ${projectId}. Push this folder to ${lock.projectId}, or remove that lock if this folder should now feed ${projectId}.`,
			7,
		);
	}
	return lock;
}

function print(lines: string[]): void {
	process.stdout.write(`${lines.join("\n")}\n`);
}

/**
 * Every folder, in order, each with its own lock and its own report. A
 * folder's failure is reported on stderr and the next folder still goes;
 * the run then exits with the first failure's code. One folder behaves
 * exactly as before, its failure thrown as it is.
 */
async function runPushAll(
	dirs: readonly string[],
	opts: PushOptions,
	format: OutputFormat,
): Promise<void> {
	if (opts.init && opts.prune) {
		throw new CliFailure(
			"--init sends every file as new and names no earlier version, so there is nothing for --prune to delete. Run them separately.",
			2,
		);
	}
	const [only] = dirs;
	if (dirs.length === 1 && only !== undefined) {
		await runPush(only, opts, format);
		return;
	}
	const failures: Array<{ dir: string; failure: CliFailure }> = [];
	for (const dir of dirs) {
		try {
			await runPush(dir, opts, format);
		} catch (error) {
			const failure = contextCliFailure(error);
			failures.push({ dir, failure });
			if (!opts.hook) {
				process.stderr.write(`✗ ${dir}: ${describeError(failure)}\n`);
			}
		}
	}
	const [first] = failures;
	if (first !== undefined) {
		throw new CliFailure(
			`${failures.length} of ${dirs.length} folders did not push completely, first ${first.dir}: ${describeError(first.failure)}`,
			first.failure.exitCode,
		);
	}
}

async function runPush(
	dir: string,
	opts: PushOptions,
	format: OutputFormat,
): Promise<void> {
	const root = await resolveFolder(dir);
	// Before any file is read: a push that cannot authenticate should not
	// spend a walk and a hash of every file finding that out.
	const client = opts.dryRun ? null : contextClient(opts);
	// --init: the lock is neither trusted nor checked. Every file is new, no
	// earlier version is named, so entries left by a Living Memory reset can
	// never read as "deleted on the server"; the lock is replaced below.
	const lock = opts.init
		? null
		: await readLockForProject(root, opts.project);
	const plan = await computeContextPlan({
		root,
		lock,
		excludes: opts.exclude,
	});

	if (client === null) {
		if (format === "json") {
			printOutput(
				jsonOutcome({
					root,
					opts,
					plan,
					results: [],
					lockWritten: false,
				}),
				{ format: "json" },
			);
			return;
		}
		print(
			formatDryRunReport({
				projectId: opts.project,
				directory: root,
				plan,
				prune: Boolean(opts.prune),
			}),
		);
		return;
	}

	// Never under --hook, whose contract is one line on stderr on failure.
	const progress = opts.hook ? null : stderrProgress();
	let pushed: Awaited<ReturnType<typeof pushContextPlan>>;
	try {
		pushed = await pushContextPlan({
			client,
			projectId: opts.project,
			org: opts.org,
			root,
			plan,
			force: Boolean(opts.force),
			prune: Boolean(opts.prune),
			lock,
			...(progress ? { onProgress: progress.report } : {}),
			...(opts.timeout !== undefined ? { timeoutMs: opts.timeout } : {}),
		});
	} finally {
		progress?.done();
	}

	// LAST, after every request, and only with what the server answered.
	const now = new Date();
	const next =
		nextContextLock({
			previous: lock,
			projectId: opts.project,
			results: pushed.results,
			forgotten: plan.forgotten,
			now,
		}) ??
		// --init replaces the lock it ignored, even with nothing new to say,
		// unless a refusal stopped the run before anything was confirmed.
		(opts.init && pushed.stoppedBy === null
			? emptyContextLock(opts.project, now)
			: null);
	if (next !== null) {
		await writeContextLock(root, next);
	}

	// After the push and its lock, so the check can only add to what is said.
	// A run that stopped early says why; this would only bury it.
	const missingOnServer =
		pushed.stoppedBy === null
			? await findMissingOnServer({
					client,
					projectId: opts.project,
					org: opts.org,
					lock,
					unchanged: plan.unchangedLocal,
				})
			: NOTHING_MISSING;

	if (format === "json") {
		printOutput(
			jsonOutcome({
				root,
				opts,
				plan,
				results: pushed.results,
				lockWritten: next !== null,
				missingOnServer,
			}),
			{ format: "json" },
		);
	} else {
		print(
			formatPushReport({
				projectId: opts.project,
				directory: root,
				plan,
				results: pushed.results,
				prune: Boolean(opts.prune),
				pruneTargets: pushed.pruneTargets,
				missingOnServer,
			}),
		);
	}

	const prune = Boolean(opts.prune);
	if (pushed.stoppedBy !== null) {
		// Under --prune, say how far the deletions got: a hook's one line is
		// all its user sees.
		throw prune
			? new CliFailure(
					`${pushed.stoppedBy.message} (${pruneSummary(pushed.results, pushed.pruneTargets)})`,
					pushed.stoppedBy.exitCode,
				)
			: pushed.stoppedBy;
	}
	throwIfIncomplete(pushed.results, prune, pushed.pruneTargets);
}

function jsonOutcome(input: {
	root: string;
	opts: PushOptions;
	plan: ContextPlan;
	results: ContextPushResult[];
	lockWritten: boolean;
	missingOnServer?: MissingOnServer;
}) {
	return contextPushJson({
		projectId: input.opts.project,
		directory: input.root,
		lockPath: contextLockPath(input.root),
		lockWritten: input.lockWritten,
		dryRun: Boolean(input.opts.dryRun),
		force: Boolean(input.opts.force),
		prune: Boolean(input.opts.prune),
		plan: input.plan,
		results: input.results,
		missingOnServer: input.missingOnServer ?? NOTHING_MISSING,
	});
}

/**
 * `--prune: 1 deleted, 0 already gone, 1 not deleted`, with the first
 * failure's cause. Counted from the plan's targets, not only from answers:
 * a target a run-level refusal stopped before it was tried is not deleted
 * too.
 */
function pruneSummary(
	results: readonly ContextPushResult[],
	targets: readonly string[],
): string {
	const count = (status: ContextPushResult["status"]) =>
		results.filter((r) => r.status === status).length;
	const settled = new Set(
		results
			.filter(
				(r) => r.status === "deleted" || r.status === "already-gone",
			)
			.map((r) => r.sourcePath),
	);
	const notDeleted = targets.filter((path) => !settled.has(path)).length;
	let text = `--prune: ${count("deleted")} deleted, ${count("already-gone")} already gone, ${notDeleted} not deleted`;
	const first = results.find((r) => r.status === "delete-failed");
	if (first && first.status === "delete-failed") {
		text += `, first ${first.sourcePath}: ${first.error}`;
	}
	return text;
}

/**
 * The run's exit, once everything that could be pushed has been.
 *
 * A failed request exits with the code its error maps to (a 400 is 7, a 5xx
 * is 1); remaining conflicts, or `--prune` deletions still running on the
 * server, alone exit 1. Either way the report above has
 * already named every file, so this sentence only says what to do next.
 * A push's failure decides the code before a `--prune` deletion's does.
 */
function throwIfIncomplete(
	results: readonly ContextPushResult[],
	prune: boolean,
	pruneTargets: readonly string[],
): void {
	const pushes = results.filter((r) => !DELETE_STATUSES.has(r.status));
	const failed = pushes.filter((r) => r.status === "failed");
	const conflicts = pushes.filter((r) => r.status === "conflict");
	const unsupported = pushes.filter((r) => r.status === "move-unsupported");
	const deleteFailed = results.filter((r) => r.status === "delete-failed");
	const deleteConflicts = results.filter(
		(r) => r.status === "delete-conflict",
	);
	const stillDeleting = results.filter(
		(r) => r.status === "delete-in-progress",
	);
	if (
		failed.length === 0 &&
		conflicts.length === 0 &&
		unsupported.length === 0 &&
		deleteFailed.length === 0 &&
		deleteConflicts.length === 0 &&
		stillDeleting.length === 0
	) {
		return;
	}
	const sentences: string[] = [];
	const total = conflicts.length + failed.length + unsupported.length;
	if (total > 0) {
		const parts: string[] = [];
		if (conflicts.length > 0) {
			parts.push(
				`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`,
			);
		}
		if (unsupported.length > 0) {
			parts.push(
				`${unsupported.length} move${unsupported.length === 1 ? "" : "s"} the server does not support yet`,
			);
		}
		const first = failed[0];
		if (first && first.status === "failed") {
			// The first cause, so a hook's single stderr line says why.
			parts.push(
				`${failed.length} failed, first ${first.sourcePath}: ${first.error}`,
			);
		}
		sentences.push(
			`${total} of ${pushes.length} file${pushes.length === 1 ? "" : "s"} sent ${total === 1 ? "was" : "were"} not stored (${parts.join(", ")}).`,
		);
		if (conflicts.length > 0) {
			sentences.push(
				"A conflict means the server holds a version this folder did not name, or deleted the one it named: compare the two in the project's Context tab, and use --force to replace the version the conflict reported with this folder's (or to send a deleted file again with no version, which recreates it, or answers duplicate if that content is already stored under another path).",
			);
			if (
				conflicts.some(
					(r) => r.status === "conflict" && r.current === null,
				)
			) {
				sentences.push(
					"If the project's Living Memory was reset, push again with --init: it ignores this folder's lock and sends every file as new.",
				);
			}
		}
	}
	if (unsupported.length > 0) {
		sentences.push(
			"This server does not support moves yet: a moved file's old path stays on the server and in the lock, its new path is not pushed, and the move is sent again on the next push.",
		);
	}
	if (prune) {
		sentences.push(`${pruneSummary(results, pruneTargets)}.`);
		if (deleteConflicts.length > 0) {
			sentences.push(
				"A file changed on the server since your last push is not deleted: compare it in the project's Context tab, and use --force to delete the version the conflict reported.",
			);
		}
		if (stillDeleting.length > 0) {
			sentences.push(
				"A deletion still running on the server keeps its lock entry: run again to confirm it.",
			);
		}
	}
	const firstFailure = failed[0] ?? deleteFailed[0];
	throw new CliFailure(
		sentences.join(" "),
		firstFailure &&
			(firstFailure.status === "failed" ||
				firstFailure.status === "delete-failed")
			? firstFailure.exitCode
			: 1,
	);
}
