import { randomUUID } from "node:crypto";
import { FabricError } from "@fabricorg/sdk";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printOutput } from "../../lib/output.js";

interface Options {
	org?: string;
	format?: string;
	run?: string;
	goal?: string;
	evidence?: string;
	requestId?: string;
	proposal?: string;
	decision?: string;
	before?: string;
}
export function registerProjectTriageCommands(projects: Command) {
	const triage = projects
		.command("triage")
		.description(
			"Privately review selected project signals with a bounded Harness agent",
		);
	triage.addHelpText(
		"after",
		"\nKeeping a proposal does not create a ticket or share it. Starts require a request ID; reuse the same ID and original input after a lost response. Manual runs only; schedules and remote targets are not enabled by this command.\n",
	);
	for (const op of [
		"list",
		"start",
		"status",
		"result",
		"cancel",
		"review",
	] as const) {
		const command = triage
			.command(`${op} <project-id>`)
			.option("--org <slug>", "Organization selector")
			.option("--format <format>", "json|yaml", "json");
		if (op === "start") {
			command
				.requiredOption("--goal <text>", "What to look for")
				.requiredOption(
					"--evidence <ids>",
					"Comma-separated selected observation IDs, at most five",
				)
				.option(
					"--request-id <uuid>",
					"Same ID and original input on retries",
				);
		}
		if (op !== "list" && op !== "start") {
			command.requiredOption("--run <id>", "Private triage run ID");
		}
		if (op === "review") {
			command
				.requiredOption("--proposal <id>", "Proposal ID")
				.requiredOption("--decision <decision>", "KEEP|DISMISS");
		}
		if (op === "list") {
			command.option(
				"--before <token>",
				"Continuation returned as nextBefore",
			);
		}
		command.action(async (projectId: string) => {
			const options = command.optsWithGlobals<Options>();
			let mutationRequestId: string | undefined;
			try {
				const client = getClient({ project: projectId });
				const context = resolveContext(undefined, options.org, false);
				const shared = { org: context?.slug };
				let result: unknown;
				switch (op) {
					case "list":
						result = await client.projects.listTriageRuns(
							projectId,
							{ ...shared, before: options.before },
						);
						break;
					case "start": {
						const requestId = options.requestId ?? randomUUID();
						mutationRequestId = requestId;
						process.stderr.write(
							`Triage request ID: ${requestId}. Reuse this ID and original input if the outcome is unknown.\n`,
						);
						result = await client.projects.startTriage(projectId, {
							...shared,
							requestId,
							goal: options.goal!,
							evidenceIds: options
								.evidence!.split(",")
								.map((x) => x.trim()),
						});
						break;
					}
					case "status":
						result = await client.projects.getTriageRun(
							projectId,
							options.run!,
							shared,
						);
						break;
					case "result":
						result = await client.projects.getTriageResult(
							projectId,
							options.run!,
							shared,
						);
						break;
					case "cancel":
						result = await client.projects.cancelTriageRun(
							projectId,
							options.run!,
							shared,
						);
						break;
					case "review":
						if (
							options.decision !== "KEEP" &&
							options.decision !== "DISMISS"
						) {
							throw Error("Use --decision KEEP or DISMISS.");
						}
						result = await client.projects.reviewTriageProposal(
							projectId,
							options.run!,
							{
								...shared,
								proposalId: options.proposal!,
								decision: options.decision,
							},
						);
						break;
				}
				printOutput(result, {
					format: options.format === "yaml" ? "yaml" : "json",
				});
			} catch (error) {
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
									: "Private signal review unavailable.",
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
				process.exitCode = 1;
			}
		});
	}
}
