import { randomUUID } from "node:crypto";
import { FabricError } from "@fabricorg/sdk";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

interface Options {
	org?: string;
	format?: string;
	watch?: string;
	integration?: string;
	channel?: string;
	requestId?: string;
	expectedVersion?: string;
	mode?: string;
	from?: string;
	to?: string;
	retentionDays?: string;
	cursor?: string;
	limit?: string;
	observation?: string;
}
function required(value: string | undefined, name: string): string {
	if (!value) {
		throw new Error(`Use --${name}.`);
	}
	return value;
}
const operations = [
	"list",
	"test",
	"connect",
	"pause",
	"resume",
	"disconnect",
	"capture",
	"status",
	"cancel",
	"observations",
	"evidence",
] as const;
export function registerProjectSourceCommands(projects: Command) {
	const sources = projects
		.command("sources")
		.description(
			"Capture private Slack root messages for your own project evidence",
		);
	sources.addHelpText(
		"after",
		"\nMutations generate a request ID only when absent. For safe retries, pass --request-id with the SAME original input; a new ID starts a new command. Capture input is retained in list.lastCaptureInput for recovery.\n",
	);
	for (const operation of operations) {
		const command = sources
			.command(`${operation} <project-id>`)
			.description(
				{
					list: "List your private watches and connections",
					test: "Test your own source access without saving",
					connect: "Connect a private Slack source",
					pause: "Pause capture",
					resume: "Resume after checking access",
					disconnect: "Disconnect a watch",
					capture: "Start bounded durable capture",
					status: "Read capture status",
					cancel: "Cancel capture",
					observations: "List private receipt metadata",
					evidence: "Read fresh-authorized private evidence",
				}[operation],
			)
			.option("--org <slug>", "Organization selector")
			.option("--format <format>", "json|yaml");
		if (!["list", "test", "connect"].includes(operation)) {
			command.requiredOption("--watch <id>", "Private watch ID");
		}
		if (operation === "test" || operation === "connect") {
			command
				.requiredOption(
					"--integration <id>",
					"Your Slack connection ID",
				)
				.requiredOption("--channel <id>", "Channel ID");
		}
		if (
			[
				"connect",
				"pause",
				"resume",
				"disconnect",
				"capture",
				"cancel",
			].includes(operation)
		) {
			command.option(
				"--request-id <uuid>",
				"Reuse this ID and original input for safe retries",
			);
		}
		if (["pause", "resume", "disconnect", "capture"].includes(operation)) {
			command.requiredOption(
				"--expected-version <n>",
				"Current saved watch version",
			);
		}
		if (operation === "capture") {
			command
				.option("--mode <mode>", "RECENT|CONTINUE|BACKFILL", "RECENT")
				.option(
					"--from <iso-utc>",
					"Start of selected past window (BACKFILL only)",
				)
				.option(
					"--to <iso-utc>",
					"End of selected past window, at most seven days (BACKFILL only)",
				);
		}
		if (operation === "connect") {
			command.option("--retention-days <n>", "7|30", "7");
		}
		if (operation === "observations") {
			command
				.option("--cursor <token>", "Opaque same-watch cursor")
				.option("--limit <n>", "Page size, 1–50");
		}
		if (operation === "evidence") {
			command.requiredOption(
				"--observation <id>",
				"Observation receipt ID",
			);
		}
		command.action(async (projectId: string) => {
			const options = command.optsWithGlobals<Options>();
			const mutationRequestId = [
				"connect",
				"pause",
				"resume",
				"disconnect",
				"capture",
				"cancel",
			].includes(operation)
				? (options.requestId ?? randomUUID())
				: undefined;
			try {
				if (
					options.format &&
					!["json", "yaml"].includes(options.format)
				) {
					throw new Error("Use --format json or yaml.");
				}
				const context = resolveContext(false, options.org, false);
				const shared = {
					org: context?.type === "org" ? context.slug : undefined,
				};
				const client = getClient({ project: projectId });
				const mutation = {
					...shared,
					requestId: mutationRequestId ?? "",
					expectedVersion: Number(options.expectedVersion),
				};
				let result: unknown;
				switch (operation) {
					case "list":
						result = await client.projects.listDeliverySources(
							projectId,
							shared,
						);
						break;
					case "test":
						result = await client.projects.testDeliverySource(
							projectId,
							{
								...shared,
								integrationId: required(
									options.integration,
									"integration",
								),
								channelId: required(options.channel, "channel"),
							},
						);
						break;
					case "connect":
						result = await client.projects.configureDeliverySource(
							projectId,
							{
								...shared,
								requestId: mutation.requestId,
								integrationId: required(
									options.integration,
									"integration",
								),
								channelId: required(options.channel, "channel"),
								retentionDays: Number(options.retentionDays) as
									| 7
									| 30,
							},
						);
						break;
					case "pause":
						result = await client.projects.pauseDeliverySource(
							projectId,
							required(options.watch, "watch"),
							mutation,
						);
						break;
					case "resume":
						result = await client.projects.resumeDeliverySource(
							projectId,
							required(options.watch, "watch"),
							mutation,
						);
						break;
					case "disconnect":
						result = await client.projects.disconnectDeliverySource(
							projectId,
							required(options.watch, "watch"),
							mutation,
						);
						break;
					case "capture":
						result =
							await client.projects.startDeliverySourceCapture(
								projectId,
								required(options.watch, "watch"),
								{
									...mutation,
									mode: options.mode?.toUpperCase() as
										| "RECENT"
										| "CONTINUE"
										| "BACKFILL",
									...(options.from !== undefined ||
									options.to !== undefined
										? {
												window: {
													start: required(
														options.from,
														"from",
													),
													end: required(
														options.to,
														"to",
													),
												},
											}
										: {}),
								},
							);
						break;
					case "status":
						result = await client.projects.getDeliverySourceCapture(
							projectId,
							required(options.watch, "watch"),
							shared,
						);
						break;
					case "cancel":
						result =
							await client.projects.cancelDeliverySourceCapture(
								projectId,
								required(options.watch, "watch"),
								{ ...shared, requestId: mutation.requestId },
							);
						break;
					case "observations":
						result =
							await client.projects.listDeliverySourceObservations(
								projectId,
								required(options.watch, "watch"),
								{
									...shared,
									cursor: options.cursor,
									limit:
										options.limit === undefined
											? undefined
											: Number(options.limit),
								},
							);
						break;
					case "evidence":
						result =
							await client.projects.getDeliverySourceEvidence(
								projectId,
								required(options.watch, "watch"),
								required(options.observation, "observation"),
								shared,
							);
						break;
				}
				printOutput(result, {
					format: options.format === "yaml" ? "yaml" : "json",
				});
			} catch (error) {
				if (
					!options.format ||
					["json", "yaml"].includes(options.format)
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
										: "Private sources are unavailable.",
								...(error instanceof FabricError
									? { status: error.status }
									: {}),
								...(mutationRequestId
									? { requestId: mutationRequestId }
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
						: "Private sources are unavailable.",
					1,
				);
			}
		});
	}
}
