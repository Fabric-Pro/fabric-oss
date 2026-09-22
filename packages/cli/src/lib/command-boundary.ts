/**
 * The failure boundary the file-syncing command groups share —
 * `fabric instructions` and `fabric context`.
 *
 * Both groups promise the same two things: a failure a person sees maps onto
 * one of the documented exit codes (`src/bin/fabric.ts`), and under `--hook`
 * nothing ever exits non-zero or runs past one absolute deadline. The pieces
 * that make those promises live here so the two groups cannot drift apart on
 * them. Each group keeps its own `run` wrapper, because the one line a hook
 * prints names the group.
 */
import type { Command } from "commander";

/** The two shapes these commands print: one JSON object, or prose. */
export type OutputFormat = "text" | "json";

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
export function outputFormatFor(command: Command): OutputFormat {
	const resolved = command.optsWithGlobals() as { format?: string };
	return resolved.format === "json" ? "json" : "text";
}

/**
 * A failure that already knows which documented exit code it is
 * (`src/bin/fabric.ts`). Errors from the SDK are translated into one of
 * these at the boundary so the command bodies can just throw.
 */
export class CliFailure extends Error {
	constructor(
		message: string,
		readonly exitCode: number,
	) {
		super(message);
		this.name = "CliFailure";
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
 *
 * `body` receives the deadline's signal, aborted when the time is up, so work
 * that can be cancelled — a download — is cancelled by the same clock.
 */
export async function withDeadline(
	totalMs: number,
	body: (signal: AbortSignal) => Promise<void>,
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
	try {
		await Promise.race([body(controller.signal), deadline]);
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export function describeError(error: unknown): string {
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
export function asCliFailure(error: unknown): CliFailure {
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
