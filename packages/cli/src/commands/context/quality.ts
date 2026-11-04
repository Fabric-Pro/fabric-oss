import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import type {
	ContextQualityEvaluationInput,
	ContextQualityResult,
} from "@fabricorg/sdk";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { CliFailure } from "../../lib/command-boundary.js";
import { printOutput } from "../../lib/output.js";

const MAX_EVALUATION_BYTES = 128 * 1024;

interface QualityOptions {
	project: string;
	org?: string;
}

/**
 * Read one explicitly named regular file. The bound applies before and during
 * reading, so a growing file, symlink or FIFO cannot turn this into an unbounded
 * read. File contents and parser diagnostics never enter error output.
 */
async function readEvaluationFile(
	file: string,
): Promise<ContextQualityEvaluationInput> {
	let value: unknown;
	try {
		const before = await lstat(file);
		if (!before.isFile() || before.size > MAX_EVALUATION_BYTES) {
			throw new Error("not a bounded regular file");
		}
		const handle = await open(
			file,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
		);
		try {
			const opened = await handle.stat();
			if (
				!opened.isFile() ||
				opened.dev !== before.dev ||
				opened.ino !== before.ino ||
				opened.size > MAX_EVALUATION_BYTES
			) {
				throw new Error("file changed or is too large");
			}
			const bytes = Buffer.alloc(MAX_EVALUATION_BYTES + 1);
			let length = 0;
			while (length < bytes.length) {
				const read = await handle.read(
					bytes,
					length,
					bytes.length - length,
					length,
				);
				length += read.bytesRead;
				if (read.bytesRead === 0) {
					break;
				}
			}
			if (
				length > MAX_EVALUATION_BYTES ||
				(await handle.stat()).size > MAX_EVALUATION_BYTES
			) {
				throw new Error("file is too large");
			}
			value = JSON.parse(
				new TextDecoder("utf-8", { fatal: true }).decode(
					bytes.subarray(0, length),
				),
			);
		} finally {
			await handle.close();
		}
	} catch {
		throw new CliFailure(
			"Evaluation input must be a regular UTF-8 JSON file of at most 128 KiB; symlinks are not accepted.",
			7,
		);
	}
	if (
		!value ||
		typeof value !== "object" ||
		!("version" in value) ||
		value.version !== 1 ||
		!("sources" in value) ||
		!Array.isArray(value.sources) ||
		!("cases" in value) ||
		!Array.isArray(value.cases)
	) {
		throw new CliFailure(
			"Evaluation input must contain version: 1, sources and recorded-output cases. Fabric validates each case and revision.",
			7,
		);
	}
	return value as ContextQualityEvaluationInput;
}

/** Stable errors intentionally exclude remote bodies, answers and source text. */
function safeFailure(error: unknown, saved = false): CliFailure {
	if (error instanceof CliFailure) {
		return error;
	}
	const status = (error as { status?: number } | null)?.status;
	switch (status) {
		case 401:
			return new CliFailure(
				"Authentication is required for context quality.",
				3,
			);
		case 403:
			return new CliFailure("Context quality access was denied.", 5);
		case 404:
			return new CliFailure(
				saved
					? "The saved evaluation or project is unavailable."
					: "The requested context source is unavailable.",
				4,
			);
		case 409:
			return new CliFailure(
				saved
					? "The evaluation conflicts with the current source, binding or idempotency key. Inspect the sources and reconcile the original request before creating another run."
					: "A source revision changed; inspect it and update the evaluation input.",
				7,
			);
		case 400:
		case 413:
		case 422:
			return new CliFailure(
				"Fabric rejected the context quality input. Check the schema, revisions and byte limits.",
				7,
			);
		case 412:
			return new CliFailure(
				"An approved evaluation connection is required for this project.",
				7,
			);
		case 429:
			return new CliFailure(
				"Context quality rate limit reached. Try again later.",
				6,
			);
		default:
			return new CliFailure(
				saved
					? "Saved evaluation request failed. Check connectivity and inspect the run; retry creation only with the same input and idempotency key."
					: "Context quality request failed. Check connectivity and try again.",
				1,
			);
	}
}

async function runQuality<T>(
	body: () => Promise<T>,
	saved = false,
): Promise<T> {
	try {
		return await body();
	} catch (error) {
		const failure = safeFailure(error, saved);
		process.stderr.write(`✗ ${failure.message}\n`);
		process.exit(failure.exitCode);
	}
}

function clientFor(command: Command, options: QualityOptions) {
	const globalOptions = command.optsWithGlobals() as { baseUrl?: string };
	return getClient({
		project: options.project,
		baseUrl: globalOptions.baseUrl,
		retry: { maxRetries: 0 },
	}).withoutContext();
}

export function registerContextQualityCommands(context: Command): void {
	const collect = (value: string, previous: string[]) => [...previous, value];
	context
		.command("inspect-run <execution-id>")
		.description(
			"Inspect your completed agent run's actual answer and revision; no rerun or shared save",
		)
		.requiredOption("--project <id>", "Recorded project ID")
		.option("--org <slug>", "Organization context")
		.action(async function (
			this: Command,
			executionId: string,
			options: QualityOptions,
		) {
			printOutput(
				await runQuality(() =>
					clientFor(this, options).contextQuality.inspectAgentResult(
						executionId,
						{ projectId: options.project, org: options.org },
					),
				),
				{ format: "json" },
			);
		});
	context
		.command("check-run <execution-id>")
		.description(
			"Check exact phrases in the server's recorded answer; requires agents:read and projects:read",
		)
		.requiredOption("--project <id>", "Recorded project ID")
		.option("--org <slug>", "Organization context")
		.requiredOption(
			"--revision <sha256>",
			"Revision returned by inspect-run",
		)
		.option(
			"--require <phrase>",
			"Exact case-sensitive phrase required; repeat for more",
			collect,
			[],
		)
		.option(
			"--forbid <phrase>",
			"Exact case-sensitive phrase forbidden; repeat for more",
			collect,
			[],
		)
		.action(async function (
			this: Command,
			executionId: string,
			options: QualityOptions & {
				revision: string;
				require: string[];
				forbid: string[];
			},
		) {
			printOutput(
				await runQuality(() =>
					clientFor(this, options).contextQuality.checkAgentResult(
						executionId,
						{
							expectedRevision: options.revision,
							requiredPhrases: options.require,
							forbiddenPhrases: options.forbid,
						},
						{ projectId: options.project, org: options.org },
					),
				),
				{ format: "json" },
			);
		});
	const runs = context
		.command("runs")
		.description("Create and inspect saved context-quality evaluations");
	function scope(command: Command) {
		return command
			.requiredOption("--project <id>", "Project ID")
			.option("--org <slug>", "Organization context");
	}
	function optionsFor(options: QualityOptions) {
		return { projectId: options.project, org: options.org };
	}
	scope(
		runs
			.command("capabilities")
			.description("Check saved evaluation availability"),
	).action(async function (this: Command, options: QualityOptions) {
		const result = await runQuality(
			() =>
				clientFor(this, options).contextQuality.runs.capabilities(
					optionsFor(options),
				),
			true,
		);
		printOutput(result, { format: "json" });
	});
	scope(
		runs
			.command("create")
			.description(
				"Save and dispatch an evaluation, exporting evidence to the approved connection",
			)
			.argument(
				"<file>",
				"Bounded evaluation JSON file (at most 128 KiB)",
			)
			.requiredOption(
				"--binding <id>",
				"Approved project evaluation binding",
			)
			.requiredOption(
				"--idempotency-key <key>",
				"Stable key to reuse with the same input when reconciling this request",
			)
			.option("--name <name>", "Evaluation name"),
	).action(async function (
		this: Command,
		file: string,
		options: QualityOptions & {
			binding: string;
			idempotencyKey: string;
			name?: string;
		},
	) {
		const result = await runQuality(async () => {
			if (!options.idempotencyKey.trim() || !options.binding.trim()) {
				throw new CliFailure(
					"A binding and a non-empty stable idempotency key are required.",
					7,
				);
			}
			const evaluation = await readEvaluationFile(file);
			return clientFor(this, options).contextQuality.runs.create(
				{
					bindingId: options.binding,
					idempotencyKey: options.idempotencyKey,
					name: options.name,
					evaluation,
				},
				optionsFor(options),
			);
		}, true);
		printOutput(result, { format: "json" });
	});
	scope(
		runs
			.command("list")
			.description("List saved evaluations")
			.option("--cursor <id>", "Next-page cursor")
			.option("--limit <count>", "Page size (1–50)", "20"),
	).action(async function (
		this: Command,
		options: QualityOptions & { cursor?: string; limit: string },
	) {
		const result = await runQuality(async () => {
			const limit = Number(options.limit);
			if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
				throw new CliFailure("Page size must be between 1 and 50.", 7);
			}
			return clientFor(this, options).contextQuality.runs.list({
				...optionsFor(options),
				cursor: options.cursor,
				limit,
			});
		}, true);
		printOutput(result, { format: "json" });
	});
	for (const action of ["get", "cancel"] as const) {
		scope(
			runs
				.command(action)
				.description(
					action === "get"
						? "Read one saved evaluation"
						: "Request cancellation; CANCELLED confirms execution stopped",
				)
				.argument("<runId>", "Saved evaluation ID"),
		).action(async function (
			this: Command,
			runId: string,
			options: QualityOptions,
		) {
			const result = await runQuality(
				() =>
					clientFor(this, options).contextQuality.runs[action](
						runId,
						optionsFor(options),
					),
				true,
			);
			printOutput(result, { format: "json" });
		});
	}
	scope(
		runs
			.command("compare")
			.description("Compare two saved evaluation reports")
			.argument("<baselineId>", "Baseline evaluation")
			.argument("<candidateId>", "Candidate evaluation"),
	).action(async function (
		this: Command,
		baselineId: string,
		candidateId: string,
		options: QualityOptions,
	) {
		const result = await runQuality(
			() =>
				clientFor(this, options).contextQuality.runs.compare(
					baselineId,
					candidateId,
					optionsFor(options),
				),
			true,
		);
		printOutput(result, { format: "json" });
	});

	context
		.command("inspect")
		.description(
			"Read an authorized context source and its current revision as JSON",
		)
		.argument("<sourceId>", "Project Context source ID")
		.requiredOption("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.action(async function (
			this: Command,
			sourceId: string,
			options: QualityOptions,
		) {
			const snapshot = await runQuality(() =>
				clientFor(this, options).contextQuality.inspect(sourceId, {
					projectId: options.project,
					org: options.org,
				}),
			);
			printOutput(snapshot, { format: "json" });
		});

	context
		.command("evaluate")
		.description(
			"Score recorded answers from a JSON file; no live AI or retrieval calls",
		)
		.argument(
			"<file>",
			"Explicit JSON evaluation input file (at most 128 KiB)",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.action(async function (
			this: Command,
			file: string,
			options: QualityOptions,
		) {
			const result: ContextQualityResult = await runQuality(async () => {
				const input = await readEvaluationFile(file);
				return clientFor(this, options).contextQuality.evaluate(input, {
					projectId: options.project,
					org: options.org,
				});
			});
			printOutput(result, { format: "json" });
			if (result.status !== "passed") {
				process.exit(1);
			}
		});
}
