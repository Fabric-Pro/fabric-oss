import { readFile } from "node:fs/promises";
import type { AgentPreviewStartInput } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

interface Options {
	org?: string;
	runId?: string;
	format: "json" | "yaml" | "table";
}
export function buildAgentPreviewsCommand(): Command {
	const previews = new Command("previews").description(
		"Test read-only single-turn drafts without saving the agent. External connections and goal loops require saved runs.",
	);
	function add(
		name: string,
		description: string,
		action: (id: string, opts: Options) => Promise<unknown>,
	) {
		return previews
			.command(name)
			.description(description)
			.option("--org <slug>", "Organization context")
			.option("--run-id <uuid>", "Pin an existing preview run")
			.option("--format <format>", "Output: json|yaml|table", "json")
			.action(async (id: string, opts: Options) => {
				const context = resolveContext(undefined, opts.org, true);
				if (!context || context.type !== "org") {
					printError("Select an organization with --org <slug>.", 2);
				}
				if (!["json", "yaml", "table"].includes(opts.format)) {
					printError("--format must be json, yaml or table.", 2);
				}
				try {
					printOutput(
						await action(id, { ...opts, org: context.slug }),
						{ format: opts.format },
					);
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "Preview could not be confirmed. Retry the same request or inspect its status.",
						1,
					);
				}
			});
	}
	add(
		"start <request-file>",
		"Start from a JSON request containing draft, userMessage, UUID idempotencyKey and optional history",
		async (file, opts) => {
			const encoded = await readFile(file);
			if (encoded.byteLength > 128 * 1024) {
				throw new Error("Preview requests must not exceed 128 KiB.");
			}
			const request: AgentPreviewStartInput = JSON.parse(
				encoded.toString("utf8"),
			);
			return getClient().agentPreviews.start(request, { org: opts.org });
		},
	);
	add(
		"get <workflow-id>",
		"Read current preview status, response, sources and tool activity",
		(id, opts) =>
			getClient().agentPreviews.get(id, {
				org: opts.org,
				runId: opts.runId,
			}),
	);
	add(
		"cancel <workflow-id>",
		"Request cooperative cancellation, then inspect status",
		(id, opts) =>
			getClient().agentPreviews.cancel(id, {
				org: opts.org,
				runId: opts.runId,
			}),
	);
	return previews;
}
