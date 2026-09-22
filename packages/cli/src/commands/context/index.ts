/**
 * fabric context
 *
 *   fabric context push <dir> --project <id>   Sync a local knowledge folder
 *                                              into the project's Context.
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
 * Everything that touches the filesystem lives in `lib/context-sync/`; this
 * file is argument parsing, the sequence, and the exit code.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";
import type { FabricClient } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import {
	CliFailure,
	describeError,
	type OutputFormat,
	outputFormatFor,
	withDeadline,
} from "../../lib/command-boundary.js";
import { getApiKey } from "../../lib/config.js";
import {
	type ContextLock,
	contextLockPath,
	readContextLock,
	writeContextLock,
} from "../../lib/context-sync/lock.js";
import {
	type ContextPlan,
	computeContextPlan,
} from "../../lib/context-sync/plan.js";
import {
	type ContextPushResult,
	nextContextLock,
	pushContextPlan,
} from "../../lib/context-sync/push.js";
import {
	contextPushJson,
	formatDryRunReport,
	formatPushReport,
} from "../../lib/context-sync/report.js";
import { resolveExistingRoot } from "../../lib/instructions/safe-write.js";
import { printOutput } from "../../lib/output.js";

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
	hook?: boolean;
	exclude?: string[];
	/** Read through `optsWithGlobals()`, never off this object. */
	format?: string;
}

function collectPattern(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function buildContextCommand(): Command {
	const context = new Command("context").description(
		"Sync local knowledge files into a project's Context",
	);

	context
		.command("push")
		.description(
			"Push every text file under <dir> into the project's Context by its relative path",
		)
		.argument(
			"<dir>",
			"Folder to push (required; never the working directory by default)",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option(
			"--force",
			"On a conflict, replace the server's version once with this folder's",
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
		.option("--format <format>", "Output format: text|json")
		.action(async function (this: Command, dir: string, opts: PushOptions) {
			await run(opts, () => runPush(dir, opts, outputFormatFor(this)));
		});

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
			process.stderr.write(`fabric: context push failed: ${message}\n`);
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
function contextClient(opts: { hook?: boolean }): FabricClient {
	if (!getApiKey()) {
		throw new CliFailure(
			"Not authenticated. Run: fabric auth login --key <api-key>",
			3,
		);
	}
	return getClient(
		opts.hook
			? { timeoutMs: HOOK_DEADLINE_MS, retry: { maxRetries: 0 } }
			: { timeoutMs: PUSH_TIMEOUT_MS },
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

async function runPush(
	dir: string,
	opts: PushOptions,
	format: OutputFormat,
): Promise<void> {
	const root = await resolveFolder(dir);
	// Before any file is read: a push that cannot authenticate should not
	// spend a walk and a hash of every file finding that out.
	const client = opts.dryRun ? null : contextClient(opts);
	const lock = await readLockForProject(root, opts.project);
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
			}),
		);
		return;
	}

	const pushed = await pushContextPlan({
		client,
		projectId: opts.project,
		org: opts.org,
		root,
		plan,
		force: Boolean(opts.force),
	});

	// LAST, after every request, and only with what the server answered.
	const next = nextContextLock({
		previous: lock,
		projectId: opts.project,
		results: pushed.results,
		forgotten: plan.forgotten,
		now: new Date(),
	});
	if (next !== null) {
		await writeContextLock(root, next);
	}

	if (format === "json") {
		printOutput(
			jsonOutcome({
				root,
				opts,
				plan,
				results: pushed.results,
				lockWritten: next !== null,
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
			}),
		);
	}

	if (pushed.stoppedBy !== null) {
		throw pushed.stoppedBy;
	}
	throwIfIncomplete(pushed.results);
}

function jsonOutcome(input: {
	root: string;
	opts: PushOptions;
	plan: ContextPlan;
	results: ContextPushResult[];
	lockWritten: boolean;
}) {
	return contextPushJson({
		projectId: input.opts.project,
		directory: input.root,
		lockPath: contextLockPath(input.root),
		lockWritten: input.lockWritten,
		dryRun: Boolean(input.opts.dryRun),
		force: Boolean(input.opts.force),
		plan: input.plan,
		results: input.results,
	});
}

/**
 * The run's exit, once everything that could be pushed has been.
 *
 * A failed request exits with the code its error maps to (a 400 is 7, a 5xx
 * is 1); remaining conflicts alone exit 1. Either way the report above has
 * already named every file, so this sentence only says what to do next.
 */
function throwIfIncomplete(results: readonly ContextPushResult[]): void {
	const failed = results.filter((r) => r.status === "failed");
	const conflicts = results.filter((r) => r.status === "conflict");
	if (failed.length === 0 && conflicts.length === 0) {
		return;
	}
	const parts: string[] = [];
	if (conflicts.length > 0) {
		parts.push(
			`${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`,
		);
	}
	const first = failed[0];
	if (first && first.status === "failed") {
		// The first cause, so a hook's single stderr line says why.
		parts.push(
			`${failed.length} failed, first ${first.sourcePath}: ${first.error}`,
		);
	}
	const total = conflicts.length + failed.length;
	let message = `${total} of ${results.length} file${results.length === 1 ? "" : "s"} sent ${total === 1 ? "was" : "were"} not stored (${parts.join(", ")}).`;
	if (conflicts.length > 0) {
		message +=
			" A conflict means the server holds a version this folder did not name, or deleted the one it named: compare the two in the project's Context tab, and use --force to replace the version the conflict reported with this folder's (or to send a deleted file again with no version, which recreates it, or answers duplicate if that content is already stored under another path).";
	}
	throw new CliFailure(
		message,
		first && first.status === "failed" ? first.exitCode : 1,
	);
}
