import { readFile } from "node:fs/promises";
import type {
	AgentTestCaseCreateInput,
	AgentTestCaseUpdateInput,
	AgentTestRunStartInput,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

interface Options {
	org?: string;
	revision?: string;
	limit?: string;
	cursor?: string;
	format: "json" | "yaml" | "table";
}
async function requestFile<T>(path: string): Promise<T> {
	const file = await readFile(path);
	if (file.byteLength > 128 * 1024) {
		throw new Error("Agent-test requests must not exceed 128 KiB.");
	}
	return JSON.parse(file.toString("utf8")) as T;
}
export function buildAgentTestsCommand(): Command {
	const tests = new Command("tests").description(
		"Save regression examples and check actual saved-agent runs. Tests use live connections and normal permissions.",
	);
	const cases = tests
		.command("case")
		.description("Manage your saved agent test cases");
	function add(
		parent: Command,
		name: string,
		description: string,
		action: (args: string[], options: Options) => Promise<unknown>,
		flags: { pagination?: boolean; revision?: boolean } = {},
	) {
		const command = parent
			.command(name)
			.description(description)
			.option("--org <slug>", "Organization context")
			.option("--format <format>", "Output: json|yaml|table", "json");
		if (flags.pagination) {
			command
				.option("--limit <number>", "Page size (1–50)")
				.option("--cursor <id>", "Next-page cursor");
		}
		if (flags.revision) {
			command.option("--revision <number>", "Expected case revision");
		}
		return command.action(async (...values: unknown[]) => {
			const command = values[values.length - 1] as Command;
			const opts = command.opts<Options>();
			const context = resolveContext(undefined, opts.org, true);
			if (!context || context.type !== "org") {
				printError("Select an organization with --org <slug>.", 2);
			}
			if (!["json", "yaml", "table"].includes(opts.format)) {
				printError("--format must be json, yaml or table.", 2);
			}
			if (
				opts.limit !== undefined &&
				(!/^\d+$/.test(opts.limit) ||
					Number(opts.limit) < 1 ||
					Number(opts.limit) > 50)
			) {
				printError("--limit must be an integer from 1 to 50.", 2);
			}
			try {
				printOutput(
					await action(command.processedArgs.map(String), {
						...opts,
						org: context.slug,
					}),
					{ format: opts.format },
				);
			} catch (error) {
				printError(
					error instanceof Error
						? error.message
						: "Agent test operation could not be confirmed. Inspect its current state before retrying.",
					1,
				);
			}
		});
	}
	add(
		cases,
		"list <instance-id>",
		"List test cases for an agent family",
		([id], o) =>
			getClient().agentTests.listCases(id, {
				org: o.org,
				limit: o.limit === undefined ? undefined : Number(o.limit),
				cursor: o.cursor,
			}),
		{ pagination: true },
	);
	add(
		cases,
		"create <request-file>",
		"Create from JSON: instanceId, name, input and checks",
		async ([file], o) =>
			getClient().agentTests.createCase(
				await requestFile<AgentTestCaseCreateInput>(file),
				{ org: o.org },
			),
	);
	add(
		cases,
		"update <case-id> <request-file>",
		"Update using JSON: revision, name, input and checks",
		async ([id, file], o) =>
			getClient().agentTests.updateCase(
				id,
				await requestFile<AgentTestCaseUpdateInput>(file),
				{ org: o.org },
			),
	);
	add(
		cases,
		"archive <case-id>",
		"Archive a case with --revision; running tests retain their frozen case",
		([id], o) => {
			if (
				!o.revision ||
				!/^\d+$/.test(o.revision) ||
				Number(o.revision) < 1
			) {
				throw new Error("Supply a positive --revision.");
			}
			return getClient().agentTests.archiveCase(id, Number(o.revision), {
				org: o.org,
			});
		},
		{ revision: true },
	);
	add(
		tests,
		"run <request-file>",
		"Execute JSON: caseId, caseRevision, instanceId and UUID idempotencyKey. Reuse the key only to retry the same test.",
		async ([file], o) =>
			getClient().agentTests.start(
				await requestFile<AgentTestRunStartInput>(file),
				{ org: o.org },
			),
	);
	add(
		tests,
		"get <test-run-id>",
		"Read current assessment status and exact-text results",
		([id], o) => getClient().agentTests.get(id, { org: o.org }),
	);
	add(
		tests,
		"history <case-id>",
		"List test history across saved agent versions",
		([id], o) =>
			getClient().agentTests.listRuns(id, {
				org: o.org,
				limit: o.limit === undefined ? undefined : Number(o.limit),
				cursor: o.cursor,
			}),
		{ pagination: true },
	);
	add(
		tests,
		"cancel <test-run-id>",
		"Request cancellation, then inspect status",
		([id], o) => getClient().agentTests.cancel(id, { org: o.org }),
	);
	add(
		tests,
		"compare <baseline-run-id> <candidate-run-id>",
		"Compare the same frozen case revision across agent versions",
		([baseline, candidate], o) =>
			getClient().agentTests.compare(baseline, candidate, { org: o.org }),
	);
	return tests;
}
