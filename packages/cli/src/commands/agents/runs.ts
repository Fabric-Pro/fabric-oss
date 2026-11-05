import type { AgentRunHistoryOptions } from "@fabricorg/sdk";
import { Command, InvalidArgumentError } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

interface Options {
	org?: string;
	format: "json" | "yaml" | "table";
	limit?: string;
	cron?: string;
	timezone?: string;
	message?: string;
	enabled?: boolean;
}
export function buildAgentRunsCommand(): Command {
	const runs = new Command("runs").description(
		"Inspect saved-agent runs, request cancellation, and manage their one recurring schedule",
	);
	const command = (
		name: string,
		description: string,
		action: (id: string, opts: Options) => Promise<unknown>,
	) =>
		runs
			.command(name)
			.description(description)
			.option("--org <slug>", "Organization context")
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
							: "Run control could not be confirmed. Inspect the run or schedule before retrying.",
						error instanceof InvalidArgumentError ? 2 : 1,
					);
				}
			});
	command(
		"list <instance-id>",
		"List this agent owner's recent runs",
		(id, opts) => {
			const limit = Number(opts.limit ?? 20);
			if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
				throw new InvalidArgumentError(
					"--limit must be between 1 and 50.",
				);
			}
			return getClient().agentRuns.list(id, { org: opts.org, limit });
		},
	).option("--limit <number>", "Recent runs, 1–50", "20");
	command(
		"get <execution-id>",
		"Read verified status, output and execution evidence",
		(id, opts) => getClient().agentRuns.get(id, { org: opts.org }),
	);
	command(
		"cancel <execution-id>",
		"Request cancellation at the next safe point; completed actions are not undone",
		(id, opts) => getClient().agentRuns.cancel(id, { org: opts.org }),
	);
	command(
		"schedule <instance-id>",
		"Read the agent's current recurring schedule",
		(id, opts) => getClient().agentRuns.getSchedule(id, { org: opts.org }),
	);
	command(
		"schedule-set <instance-id>",
		"Save recurring work; requires explicit agents:schedule and agents:execute key scopes",
		(id, opts) => {
			if (!opts.cron || !opts.timezone || !opts.message) {
				printError("Provide --cron, --timezone and --message.", 2);
			}
			return getClient().agentRuns.setSchedule(
				id,
				{
					cronExpression: opts.cron,
					timezone: opts.timezone,
					input: { message: opts.message },
					enabled: opts.enabled !== false,
				},
				{ org: opts.org },
			);
		},
	)
		.requiredOption("--cron <expression>", "Five- or six-field cron")
		.requiredOption("--timezone <IANA>", "Schedule timezone")
		.requiredOption(
			"--message <text>",
			"Saved task, up to 20,000 characters",
		)
		.option("--no-enabled", "Pause an existing schedule");
	runs.command("search")
		.description(
			"Search paged saved-agent run metadata; inspect a run for full results",
		)
		.option("--org <slug>", "Organization context")
		.option("--format <format>", "Output: json|yaml|table", "json")
		.option("--instance <id>", "Limit to a saved agent")
		.option(
			"--status <status>",
			"ACTIVE|COMPLETED|FAILED|CANCELLED|TIMED_OUT",
		)
		.option("--trigger <type>", "MANUAL|SCHEDULE|API|WEBHOOK|EVENT|SLACK")
		.option("--from <ISO>", "Inclusive queued time")
		.option("--to <ISO>", "Inclusive queued time")
		.option(
			"--query <text>",
			"Run ID, agent name or task text, up to 200 characters",
		)
		.option("--cursor <opaque>", "Continue with identical filters")
		.option("--limit <number>", "Runs per page, 1–50", "25")
		.action(
			async (
				opts: Options & {
					instance?: string;
					status?: string;
					trigger?: string;
					from?: string;
					to?: string;
					query?: string;
					cursor?: string;
				},
			) => {
				const context = resolveContext(undefined, opts.org, true);
				if (!context || context.type !== "org") {
					printError("Select an organization with --org <slug>.", 2);
				}
				try {
					if (!["json", "yaml", "table"].includes(opts.format)) {
						throw new InvalidArgumentError(
							"--format must be json, yaml or table.",
						);
					}
					const limit = Number(opts.limit);
					if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
						throw new InvalidArgumentError(
							"--limit must be between 1 and 50.",
						);
					}
					if (
						opts.status &&
						![
							"ACTIVE",
							"COMPLETED",
							"FAILED",
							"CANCELLED",
							"TIMED_OUT",
						].includes(opts.status)
					) {
						throw new InvalidArgumentError("Invalid --status.");
					}
					if (
						opts.trigger &&
						![
							"MANUAL",
							"SCHEDULE",
							"API",
							"WEBHOOK",
							"EVENT",
							"SLACK",
						].includes(opts.trigger)
					) {
						throw new InvalidArgumentError("Invalid --trigger.");
					}
					for (const date of [opts.from, opts.to]) {
						if (
							date &&
							(!/^\d{4}-\d\d-\d\dT.*(?:Z|[+-]\d\d:\d\d)$/.test(
								date,
							) ||
								Number.isNaN(Date.parse(date)))
						) {
							throw new InvalidArgumentError(
								"Dates must be ISO timestamps with a timezone.",
							);
						}
					}
					if (
						opts.from &&
						opts.to &&
						Date.parse(opts.from) > Date.parse(opts.to)
					) {
						throw new InvalidArgumentError(
							"--from must be no later than --to.",
						);
					}
					if (
						opts.query !== undefined &&
						(!opts.query.trim() ||
							opts.query.trim().length > 200 ||
							/[\p{Cc}]/u.test(opts.query))
					) {
						throw new InvalidArgumentError(
							"--query must contain 1–200 characters without control characters.",
						);
					}
					if (
						opts.cursor !== undefined &&
						!/^[A-Za-z0-9_-]{1,4096}$/.test(opts.cursor)
					) {
						throw new InvalidArgumentError("Invalid --cursor.");
					}
					const options: AgentRunHistoryOptions = {
						org: context.slug,
						instanceId: opts.instance,
						status: opts.status as AgentRunHistoryOptions["status"],
						triggerType:
							opts.trigger as AgentRunHistoryOptions["triggerType"],
						from: opts.from,
						to: opts.to,
						query: opts.query?.trim(),
						cursor: opts.cursor,
						limit,
					};
					printOutput(await getClient().agentRuns.search(options), {
						format: opts.format,
					});
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "Run history could not be loaded.",
						error instanceof InvalidArgumentError ? 2 : 1,
					);
				}
			},
		);
	return runs;
}
