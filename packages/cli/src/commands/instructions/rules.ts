/**
 * fabric instructions rules --project <id> [--dest <dir>] [--hook]
 *
 * Writes the project's rules (the instructions' `rules/**` and
 * `.claude/rules/**` markdown) into the project folder as
 * `.claude/rules/fabric-<id>/`, where Claude Code loads them. A plugin cannot
 * carry rules, so this is the only way they reach a Claude Code session.
 * Codex gets its rules in `AGENTS.override.md` (see `render --target codex`).
 *
 * `--hook` is the Claude Code session hook's mode: it prints nothing on
 * stdout (a hook's stdout is the session's context), writes its notes to
 * stderr, stops at a deadline, and never fails.
 */
import path from "node:path";
import type { Command } from "commander";
import { CliFailure, describeError } from "../../lib/command-boundary.js";
import * as git from "../../lib/instructions/git.js";
import { excludeLocalFiles } from "../../lib/instructions/git-exclude.js";
import {
	resolveDestinationRoot,
	resolveExistingRoot,
} from "../../lib/instructions/safe-write.js";
import { findProjectRoot } from "../../lib/memory/project-root.js";
import { selectRules } from "../../lib/plugin/rules.js";
import {
	type RulesSyncResult,
	rulesFolderFor,
	rulesSyncLines,
	syncProjectRules,
} from "../../lib/plugin/rules-sync.js";
import { readInstructions } from "../../lib/plugin/source.js";
import { connectForProject } from "./render.js";

/** A hook's whole budget; the hook entry allows a little more. */
const HOOK_BUDGET_MS = 40_000;
const REQUEST_TIMEOUT_MS = 20_000;

/** The paths git tracks below the rules folder, relative to it. */
async function trackedBelow(
	toplevel: string,
	root: string,
	folder: string,
	deadline: git.GitDeadline,
): Promise<Set<string>> {
	const prefix = path
		.relative(toplevel, path.join(root, folder))
		.split(path.sep)
		.join("/");
	const tracked = await git.trackedPaths(toplevel, [prefix], deadline);
	return new Set(
		tracked.kind === "ok"
			? tracked.value
					.filter((entry) => entry.startsWith(`${prefix}/`))
					.map((entry) => entry.slice(prefix.length + 1))
			: [],
	);
}

/**
 * Read the published instructions (through the CLI's file cache) and bring the
 * project's rules folder to match. Shared by the command and by `init`.
 */
export async function syncRulesForProject(input: {
	project: string;
	baseUrl?: string;
	org?: string;
	/** The project folder. */
	root: string;
	budgetMs?: number;
}): Promise<RulesSyncResult> {
	const budget = input.budgetMs ?? HOOK_BUDGET_MS;
	const deadline = Date.now() + budget;
	const { client, cacheDirectory } = connectForProject(input);
	const published = await client.instructions.getPublished(input.project, {
		org: input.org,
	});
	const read = await readInstructions({
		client,
		projectId: input.project,
		org: input.org,
		published,
		cacheDirectory,
		timeoutMs: REQUEST_TIMEOUT_MS,
		signal: AbortSignal.timeout(budget),
	});
	const rules = selectRules(read, "claude-code");
	const root = await resolveExistingRoot(input.root);
	const folder = rulesFolderFor(input.project);
	const tree = await git.findWorkTree(root, Date.now() + 8_000);
	const toplevel = tree.kind === "ok" ? tree.value.toplevel : null;
	const result = await syncProjectRules({
		root,
		projectId: input.project,
		rules,
		tracked:
			toplevel === null
				? undefined
				: await trackedBelow(
						toplevel,
						root,
						folder,
						Date.now() + 8_000,
					),
		deadline,
	});
	if (toplevel !== null && rules.length > 0 && result.refused === null) {
		await excludeLocalFiles({
			toplevel,
			directory: root,
			files: [folder],
			deadline: Date.now() + 8_000,
		});
	}
	return result;
}

interface RulesOptions {
	project?: string;
	baseUrl?: string;
	org?: string;
	dest?: string;
	hook?: boolean;
}

export function registerRulesCommand(instructions: Command): void {
	instructions
		.command("rules")
		.description(
			"Write the project's rules into .claude/rules/fabric-<id>/ for Claude Code (a plugin cannot carry rules)",
		)
		.requiredOption("--project <id>", "Project ID")
		.option(
			"--base-url <origin>",
			"Deployment to talk to (default: the one you are signed in to)",
		)
		.option("--org <slug>", "Organization context")
		.option(
			"--dest <dir>",
			"The project folder (default: the folder `init` set up, found from cwd)",
		)
		.option("--hook", "Run as a session hook: print nothing, never fail")
		.action(async (opts: RulesOptions) => {
			const note = (text: string) =>
				process.stderr.write(`fabric: ${text}\n`);
			try {
				const project = opts.project as string;
				let root: string;
				if (opts.dest !== undefined) {
					root = await resolveDestinationRoot(
						path.resolve(opts.dest),
					);
				} else {
					const found = await findProjectRoot(process.cwd());
					if (found === null || found.marker.projectId !== project) {
						throw new CliFailure(
							"this folder was not set up by `fabric instructions init` for this project; pass --dest",
							2,
						);
					}
					root = found.root;
				}
				const result = await syncRulesForProject({
					project,
					baseUrl: opts.baseUrl,
					org: opts.org,
					root,
				});
				for (const text of rulesSyncLines(result)) {
					note(text);
				}
			} catch (error) {
				note(
					`rules failed: ${error instanceof CliFailure ? error.message : describeError(error)}`,
				);
				if (!opts.hook) {
					process.exit(
						error instanceof CliFailure ? error.exitCode : 1,
					);
				}
			}
		});
}
