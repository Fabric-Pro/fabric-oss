import { readFile } from "node:fs/promises";
import type {
	ConfigureRunQualityInput,
	RunQualityTarget,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

function target(type: string, id: string): RunQualityTarget {
	if (!["agent", "workflow"].includes(type)) {
		throw new Error("Use agent or workflow as the target type.");
	}
	return {
		targetType: type === "agent" ? "AGENT" : "WORKFLOW",
		targetId: id,
	};
}
export function buildRunQualityCommand(): Command {
	const quality = new Command("quality").description(
		"Configure automatic recorded-result checks and inspect assessments. Checks never rerun business work.",
	);
	function add(
		name: string,
		description: string,
		run: (
			args: string[],
			options: { org: string; limit?: string; offset?: string },
		) => Promise<unknown>,
		paging = false,
	) {
		const command = quality
			.command(name)
			.description(description)
			.option("--org <slug>", "Organization context")
			.option("--format <format>", "Output: json|yaml|table", "json");
		if (paging) {
			command
				.option("--limit <n>", "Page size (1–50)", "20")
				.option("--offset <n>", "Page offset", "0");
		}
		command.action(async (...values: unknown[]) => {
			const command = values.at(-1) as Command;
			const options = command.opts();
			try {
				const context = resolveContext(undefined, options.org, true);
				if (!context || context.type !== "org") {
					throw new Error(
						"Select an organization with --org <slug>.",
					);
				}
				if (!["json", "yaml", "table"].includes(options.format)) {
					throw new Error("--format must be json, yaml or table.");
				}
				if (
					paging &&
					(!/^\d+$/.test(options.limit) ||
						Number(options.limit) < 1 ||
						Number(options.limit) > 50 ||
						!/^\d+$/.test(options.offset) ||
						!Number.isSafeInteger(Number(options.offset)))
				) {
					throw new Error(
						"Use a page size from 1 to 50 and a nonnegative integer offset.",
					);
				}
				printOutput(
					await run(command.processedArgs.map(String), {
						...options,
						org: context.slug,
					}),
					{ format: options.format },
				);
			} catch (error) {
				printError(
					error instanceof Error
						? error.message
						: "Quality operation could not be confirmed. Refresh its state before retrying.",
					1,
				);
			}
		});
	}
	add(
		"policy <type> <target-id>",
		"View the current agent or workflow check policy",
		([type, id], o) =>
			getClient().runQuality.getPolicy(target(type, id), { org: o.org }),
	);
	add(
		"configure <type> <target-id> <request-file>",
		"Save reviewed JSON: expectedRevision, enabled and rules; affects future executions",
		async ([type, id, file], o) => {
			const bytes = await readFile(file);
			if (bytes.byteLength > 128 * 1024) {
				throw new Error(
					"Quality policy requests must not exceed 128 KiB.",
				);
			}
			const raw: unknown = JSON.parse(bytes.toString("utf8"));
			if (
				!raw ||
				typeof raw !== "object" ||
				Array.isArray(raw) ||
				"targetType" in raw ||
				"targetId" in raw ||
				"organizationId" in raw ||
				"userId" in raw
			) {
				throw new Error(
					"Use the target from the command and omit actor, target and organization fields from the request file.",
				);
			}
			return getClient().runQuality.configure(
				{ ...raw, ...target(type, id) } as ConfigureRunQualityInput,
				{ org: o.org },
			);
		},
	);
	add(
		"list <type> <target-id>",
		"List retained assessments with pagination",
		([type, id], o) =>
			getClient().runQuality.list(target(type, id), {
				org: o.org,
				limit: Number(o.limit),
				offset: Number(o.offset),
			}),
		true,
	);
	add(
		"show <type> <target-id> <assessment-id>",
		"Inspect checks separately from business execution",
		([type, id, assessmentId], o) =>
			getClient().runQuality.get(
				{ ...target(type, id), assessmentId },
				{ org: o.org },
			),
	);
	add(
		"cancel <type> <target-id> <assessment-id>",
		"Cancel assessment only; the business execution continues",
		([type, id, assessmentId], o) =>
			getClient().runQuality.cancel(
				{ ...target(type, id), assessmentId },
				{ org: o.org },
			),
	);
	add(
		"compare <type> <target-id> <left-id> <right-id>",
		"Compare compatible recorded assessments",
		([type, id, leftId, rightId], o) =>
			getClient().runQuality.compare(
				{ ...target(type, id), leftId, rightId },
				{ org: o.org },
			),
	);
	return quality;
}
