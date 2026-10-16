/**
 * fabric memory
 *
 *   fabric memory pull   [--project <id>]   Bring the project's memory folders into this tree.
 *   fabric memory push   [--project <id>]   Send what changed in them to Fabric.
 *   fabric memory status [--project <id>]   How the folders and the server stand.
 *
 * Living Memory's write folders (ADR-022) appear as plain files at their
 * repository-relative paths, so an agent writes a spec with its ordinary file
 * tools and a skill that names `docs/ai/spec.md` keeps working. Fabric commits
 * the files, or opens a pull request, with the repository integration's own
 * credential: the working tree needs no clone and no git credential.
 *
 * `--hook` is the contract that makes these safe to run at session start and
 * at the end of a turn: they NEVER exit non-zero, stop at one absolute
 * deadline, print at most one line, and never print a file's content. A coding
 * session that cannot start or end because Fabric is unreachable would be a
 * far worse failure than a memory file that is one turn late.
 */
import { Command } from "commander";
import {
	CliFailure,
	describeError,
	outputFormatFor,
	withDeadline,
} from "../../lib/command-boundary.js";
import { hookTiming } from "../../lib/instructions/hook-timing.js";
import { pull } from "../../lib/memory/pull.js";
import { push } from "../../lib/memory/push.js";
import {
	pullHookLine,
	pullLines,
	pushHookLine,
	pushLines,
	statusLines,
} from "../../lib/memory/report.js";
import { createRuntime, type MemoryOptions } from "../../lib/memory/runtime.js";
import { status } from "../../lib/memory/status.js";
import { printOutput } from "../../lib/output.js";

/** A hook's whole run, node start-up included: Claude Code kills a hook long after this. */
const HOOK_DEADLINE_MS = 14_000;

const PROJECT_HELP =
	"Project ID (default: the project `fabric instructions init --plugin` set this folder up for)";
const BASE_URL_HELP =
	"Deployment to talk to, such as https://example.com (default: the one you are signed in to)";
const DEST_HELP =
	"Where to look for the project's folder, going up from here (default: cwd). Files are only ever written inside that folder";

interface RawOptions extends MemoryOptions {
	format?: string;
}

/**
 * Run a subcommand. In hook mode every failure is a line on stderr and an exit
 * of 0; otherwise it is a real failure with its exit code.
 */
async function run(
	opts: MemoryOptions,
	verb: string,
	body: (runtime: Awaited<ReturnType<typeof createRuntime>>) => Promise<void>,
): Promise<void> {
	const execute = async (signal?: AbortSignal) =>
		body(await createRuntime(opts, signal));
	try {
		if (opts.hook) {
			await withDeadline(HOOK_DEADLINE_MS, (signal) => execute(signal));
			await endHookProcess();
		} else {
			await execute();
		}
	} catch (error) {
		const message =
			error instanceof CliFailure ? error.message : describeError(error);
		if (opts.hook) {
			process.stderr.write(
				`fabric: memory ${verb} skipped: ${message}\n`,
			);
			await endHookProcess();
			return;
		}
		process.stderr.write(`✗ ${message}\n`);
		process.exit(error instanceof CliFailure ? error.exitCode : 1);
	}
}

/**
 * After a hook run has said what it has to say: end the process once its
 * output is written, so a socket left open by the abandoned work cannot keep
 * the session waiting. Only the binary's entry point asks for it.
 */
async function endHookProcess(): Promise<void> {
	if (!hookTiming.exitWhenDone) {
		return;
	}
	await Promise.all(
		[process.stdout, process.stderr].map(
			(stream) =>
				new Promise<void>((resolve) => {
					stream.write("", () => resolve());
				}),
		),
	);
	process.exit(0);
}

function line(text: string): void {
	process.stdout.write(`${text}\n`);
}

export function buildMemoryCommand(): Command {
	const memory = new Command("memory").description(
		"Mirror a project's Living Memory write folders as plain files, and send changes back",
	);

	memory
		.command("pull")
		.description(
			"Bring the project's memory folders into this tree; never overwrites a file you changed",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--dest <dir>", DEST_HELP)
		.option(
			"--accept-remote <path>",
			"Take the server's version of this file, replacing yours (repeatable)",
			(value: string, previous: string[]) => [...previous, value],
			[] as string[],
		)
		.option(
			"--flush",
			"Send local changes first (for a tool that has no end-of-turn hook)",
		)
		.option(
			"--hook",
			"Run as a session hook: never fail, stop at a deadline, print at most one line",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & { acceptRemote: string[]; flush?: boolean },
		) {
			const format = outputFormatFor(this);
			await run(opts, "pull", async ({ context }) => {
				const flushed = opts.flush
					? await push(context, { cached: true })
					: null;
				const result = await pull(context, {
					acceptRemote: opts.acceptRemote,
				});
				if (opts.hook) {
					const hookLine = [
						flushed === null ? null : pushHookLine(flushed),
						pullHookLine(result),
					]
						.filter((entry): entry is string => entry !== null)
						.join("; ")
						.replace(/; memory: /g, "; ");
					if (hookLine !== "") {
						line(hookLine);
					}
					return;
				}
				if (format === "json") {
					printOutput(
						{ pushed: flushed, ...result },
						{ format: "json" },
					);
					return;
				}
				for (const text of [
					...(flushed === null ? [] : pushLines(flushed)),
					...pullLines(result),
				]) {
					line(text);
				}
			});
		});

	memory
		.command("push")
		.description(
			"Send what changed in the memory folders; Fabric commits it or opens a pull request",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--dest <dir>", DEST_HELP)
		.option(
			"--message <text>",
			"The commit message (default: names the date and count)",
		)
		.option(
			"--hook",
			"Run as a session hook: never fail, stop at a deadline, print at most one line",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & { message?: string },
		) {
			const format = outputFormatFor(this);
			await run(opts, "push", async ({ context }) => {
				const result = await push(context, {
					message: opts.message,
					cached: Boolean(opts.hook),
				});
				if (opts.hook) {
					const hookLine = pushHookLine(result);
					if (hookLine !== null) {
						line(hookLine);
					}
					return;
				}
				if (format === "json") {
					printOutput(result, { format: "json" });
					return;
				}
				for (const text of pushLines(result)) {
					line(text);
				}
			});
		});

	memory
		.command("status")
		.description(
			"Settle what was sent, and report pull requests, problems and unsent changes",
		)
		.option("--project <id>", PROJECT_HELP)
		.option("--base-url <origin>", BASE_URL_HELP)
		.option("--dest <dir>", DEST_HELP)
		.option(
			"--clear",
			"Dismiss writes that ended in a conflict, a refusal or a failure",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			opts: RawOptions & { clear?: boolean },
		) {
			const format = outputFormatFor(this);
			await run(opts, "status", async ({ context }) => {
				const result = await status(context, { clear: opts.clear });
				if (format === "json") {
					printOutput(result, { format: "json" });
					return;
				}
				for (const text of statusLines(result)) {
					line(text);
				}
			});
		});

	return memory;
}
