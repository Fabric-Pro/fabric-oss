import type { DashboardCuratedFeedbackAction } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

const ACTIONS = new Set(["click", "pin", "unpin", "dismiss", "restore"]);

export function buildDashboardCommand(): Command {
	const dashboard = new Command("dashboard").description(
		"Inspect and personalize dashboard recommendations",
	);

	dashboard
		.command("curated")
		.description("List your Curated for you feedback")
		.option("--org <slug>", "Organization context")
		.option("--format <format>", "Output: table|json|yaml|csv", "table")
		.action(async (options: { org?: string; format: string }) => {
			try {
				const context = resolveContext(undefined, options.org, true);
				if (!context || context.type !== "org") {
					throw new Error(
						"Select an organization with --org <slug>.",
					);
				}
				const result = await getClient().dashboard.listCuratedFeedback({
					org: context.slug,
				});
				printOutput(result.preferences, {
					format: options.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"cardKey",
						"pinnedAt",
						"dismissedAt",
						"clickCount",
						"lastClickedAt",
					],
				});
			} catch (error) {
				printError(
					error instanceof Error
						? error.message
						: "Could not read recommendation feedback",
					1,
				);
			}
		});

	dashboard
		.command("feedback <card-key> <action>")
		.description("Record click, pin, unpin, dismiss or restore feedback")
		.option("--org <slug>", "Organization context")
		.option("--format <format>", "Output: json|yaml|table", "json")
		.action(
			async (
				cardKey: string,
				action: string,
				options: { org?: string; format: string },
			) => {
				try {
					const context = resolveContext(
						undefined,
						options.org,
						true,
					);
					if (!context || context.type !== "org") {
						throw new Error(
							"Select an organization with --org <slug>.",
						);
					}
					if (!ACTIONS.has(action)) {
						throw new Error(
							"Use click, pin, unpin, dismiss or restore as the action.",
						);
					}
					if (!["json", "yaml", "table"].includes(options.format)) {
						throw new Error(
							"--format must be json, yaml or table.",
						);
					}
					const result =
						await getClient().dashboard.recordCuratedFeedback(
							{
								cardKey,
								action: action as DashboardCuratedFeedbackAction,
							},
							{ org: context.slug },
						);
					printOutput(result.preference, {
						format: options.format as "json" | "yaml" | "table",
					});
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "Could not save recommendation feedback",
						1,
					);
				}
			},
		);

	return dashboard;
}
