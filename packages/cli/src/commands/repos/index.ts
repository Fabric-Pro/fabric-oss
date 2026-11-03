/**
 * `fabric repos sync`: clone the project's code repositories into the agent
 * workspace's `repos/<folder>/` (specs/2026-10-21-ai-artifacts-hub §5.7).
 * Safe to run any time: existing clones are left as they are and only new
 * repositories are cloned.
 */
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { CliFailure } from "../../lib/command-boundary.js";
import { resolveContext } from "../../lib/context.js";
import {
	describeOutcomes,
	readWorkspaceProject,
	syncCodeRepositories,
} from "../../lib/workspace/code-repos.js";

export function buildReposCommand(): Command {
	const repos = new Command("repos").description(
		"The project's code repositories in this agent workspace (repos/)",
	);
	repos
		.command("sync")
		.description(
			"Clone the project's code repositories into repos/<name>; existing clones are left alone",
		)
		.option(
			"--project <id>",
			"The Fabric project (remembered in repos/ after the first run)",
		)
		.option("--org <slug>", "Organization context")
		.action(async (opts: { project?: string; org?: string }) => {
			const workspace = process.cwd();
			const projectId =
				opts.project ?? (await readWorkspaceProject(workspace));
			if (!projectId) {
				throw new CliFailure(
					"Which project? Run `fabric repos sync --project <id>` once in this folder.",
					2,
				);
			}
			const ctx = resolveContext(undefined, opts.org, false);
			const outcomes = await syncCodeRepositories({
				client: getClient(),
				projectId,
				org: ctx?.type === "org" ? ctx.slug : undefined,
				workspace,
				onProgress: (message) => process.stderr.write(`${message}\n`),
			});
			process.stdout.write(`${describeOutcomes(outcomes)}\n`);
			if (outcomes.some((o) => o.status === "failed")) {
				process.exitCode = 1;
			}
		});
	return repos;
}
