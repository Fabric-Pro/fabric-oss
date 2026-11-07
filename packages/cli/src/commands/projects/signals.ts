import { type DeliverySignalProvider, FabricError } from "@fabricorg/sdk";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

export function registerProjectSignalCommands(projects: Command) {
	const signals = projects
		.command("signals")
		.description(
			"Browse source-backed project work and your own saved source setup",
		);
	for (const operation of ["list", "show", "sources"] as const) {
		const command = signals
			.command(
				`${operation} <project-id>${operation === "show" ? " <item-id>" : ""}`,
			)
			.description(
				operation === "sources"
					? "Inspect saved setup; this does not test live capture"
					: operation === "show"
						? "Read one saved-work entry"
						: "List saved work; incoming messages/proposals are excluded",
			)
			.option("--org <slug>", "Organization context")
			.option("--format <format>", "json|yaml");
		if (operation === "list") {
			command
				.option(
					"--source <provider>",
					"SLACK|TEAMS|JIRA|AZURE_DEVOPS|FIZZY",
				)
				.option("--search <text>", "Search title or identifier")
				.option("--limit <n>", "Page size, 1–50")
				.option(
					"--cursor <token>",
					"Continue with the same actor, project and filters",
				);
		}
		command.action(async (...args: unknown[]) => {
			const projectId = args[0] as string;
			const itemId =
				operation === "show" ? (args[1] as string) : undefined;
			const options = command.optsWithGlobals<{
				org?: string;
				format?: string;
				source?: string;
				search?: string;
				limit?: string;
				cursor?: string;
			}>();
			try {
				if (
					options.format &&
					options.format !== "json" &&
					options.format !== "yaml"
				) {
					throw Error("Use --format json or yaml.");
				}
				const context = resolveContext(false, options.org, false);
				const shared = {
					org: context?.type === "org" ? context.slug : undefined,
				};
				const client = getClient({ project: projectId });
				const result =
					operation === "sources"
						? await client.projects.getDeliverySignalSourceConfiguration(
								projectId,
								shared,
							)
						: operation === "show" && itemId
							? await client.projects.getDeliverySignal(
									projectId,
									itemId,
									shared,
								)
							: await client.projects.listDeliverySignals(
									projectId,
									{
										...shared,
										source: options.source
											?.toUpperCase()
											.replaceAll("-", "_") as
											| DeliverySignalProvider
											| undefined,
										search: options.search,
										cursor: options.cursor,
										limit:
											options.limit === undefined
												? undefined
												: Number(options.limit),
									},
								);
				printOutput(result, {
					format: options.format === "yaml" ? "yaml" : "json",
				});
			} catch (error) {
				if (
					!options.format ||
					options.format === "json" ||
					options.format === "yaml"
				) {
					printOutput(
						{
							error: {
								code:
									error instanceof FabricError
										? (error.code ?? "REQUEST_FAILED")
										: "REQUEST_FAILED",
								message:
									error instanceof Error
										? error.message
										: "Project history is unavailable.",
								...(error instanceof FabricError
									? { status: error.status }
									: {}),
							},
						},
						{ format: options.format === "yaml" ? "yaml" : "json" },
					);
					process.exit(1);
				}
				printError(
					error instanceof Error
						? error.message
						: "Project history is unavailable.",
					1,
				);
			}
		});
	}
}
