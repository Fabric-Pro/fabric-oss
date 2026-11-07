import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

export function registerProjectDeliveryCommand(projects: Command) {
	projects
		.command("delivery <project-id>")
		.description(
			"Inspect delivery evidence, implementation outcomes and context health",
		)
		.option("--org <slug>", "Organization context")
		.option("--format <format>", "json|yaml", "json")
		.action(
			async (
				projectId: string,
				options: { org?: string; format: string },
			) => {
				try {
					const context = resolveContext(false, options.org, false);
					const result = await getClient().projects.delivery(
						projectId,
						{
							org:
								context?.type === "org"
									? context.slug
									: undefined,
						},
					);
					printOutput(result, {
						format: options.format === "yaml" ? "yaml" : "json",
					});
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "Project delivery is unavailable.",
						1,
					);
				}
			},
		);
}
