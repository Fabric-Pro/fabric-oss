import { Command, InvalidArgumentError } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

function integer(min: number, max: number) {
	return (value: string) => {
		if (
			!/^[0-9]+$/.test(value) ||
			!Number.isSafeInteger(Number(value)) ||
			Number(value) < min ||
			Number(value) > max
		)
			throw new InvalidArgumentError(
				`Use an integer between ${min} and ${max}.`,
			);
		return Number(value);
	};
}
export function registerContextManifestCommand(context: Command) {
	context
		.command("manifest")
		.description(
			"Inspect one live page of project context metadata, readiness and read references; no source bodies",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option("--limit <n>", "Sources per page (1..50)", integer(1, 50), 20)
		.option(
			"--offset <n>",
			"Live offset; not a cross-page snapshot",
			integer(0, 2147483646),
			0,
		)
		.option("--include-code-contexts", "Include code-index sources")
		.action(async (opts) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().contexts.manifest(opts.project, {
						org: ctx?.slug,
						limit: opts.limit,
						offset: opts.offset,
						includeCodeContexts: opts.includeCodeContexts ?? false,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
}
