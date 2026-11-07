import { readFile } from "node:fs/promises";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

export function registerImplementationCommands(projects: Command) {
	const sessions = projects
		.command("implementations")
		.description(
			"Inspect and control existing Fabric Agents implementation sessions",
		);
	const options = (command: Command) =>
		command
			.option("--org <slug>", "Organization context")
			.option("--format <format>", "json|yaml", "json");
	const org = (value?: string) => {
		const context = resolveContext(false, value, false);
		return context?.type === "org" ? context.slug : undefined;
	};
	const run = async (action: () => Promise<unknown>, format: string) => {
		try {
			printOutput(await action(), {
				format: format === "yaml" ? "yaml" : "json",
			});
		} catch (error) {
			printError(
				error instanceof Error
					? error.message
					: "Implementation request failed.",
				1,
			);
		}
	};
	options(
		sessions
			.command("list <project-id>")
			.option("--story <id>", "Work item ID")
			.option("--cursor <id>", "nextCursor from the previous page")
			.option("--limit <number>", "Maximum 50", "20"),
	).action((projectId, value) =>
		run(
			() =>
				getClient().projects.listImplementationSessions(projectId, {
					org: org(value.org),
					storyId: value.story,
					cursor: value.cursor,
					limit: Number(value.limit),
				}),
			value.format,
		),
	);
	options(sessions.command("show <project-id> <id>")).action(
		(projectId, id, value) =>
			run(
				() =>
					getClient().projects.getImplementationSession(
						projectId,
						id,
						{ org: org(value.org) },
					),
				value.format,
			),
	);
	options(sessions.command("messages <project-id> <id>")).action(
		(projectId, id, value) =>
			run(
				() =>
					getClient().projects.getImplementationMessages(
						projectId,
						id,
						{ org: org(value.org) },
					),
				value.format,
			),
	);
	options(
		sessions
			.command("start <project-id>")
			.requiredOption(
				"--input <path>",
				"JSON with stable requestId UUID, storyId and reviewed native server/provider options",
			),
	).action((projectId, value) =>
		run(async () => {
			const input = JSON.parse(await readFile(value.input, "utf8"));
			return getClient().projects.startImplementationSession(projectId, {
				...input,
				org: org(value.org),
			});
		}, value.format),
	);
	options(sessions.command("cancel <project-id> <id>")).action(
		(projectId, id, value) =>
			run(
				() =>
					getClient().projects.cancelImplementationSession(
						projectId,
						id,
						{ org: org(value.org) },
					),
				value.format,
			),
	);
	options(
		sessions
			.command("follow-up <project-id> <id>")
			.requiredOption(
				"--prompt-id <uuid>",
				"Stable UUID; reuse with the same message on retry",
			)
			.requiredOption(
				"--message-file <path>",
				"UTF-8 follow-up message (maximum 4000 characters)",
			),
	).action((projectId, id, value) =>
		run(
			async () =>
				getClient().projects.followUpImplementationSession(
					projectId,
					id,
					{
						org: org(value.org),
						promptId: value.promptId,
						message: await readFile(value.messageFile, "utf8"),
					},
				),
			value.format,
		),
	);
}
