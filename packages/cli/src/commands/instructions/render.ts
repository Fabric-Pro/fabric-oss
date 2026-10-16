/**
 * fabric instructions render --project <id> [--target claude-code|codex] [--out <dir>]
 *
 * Builds a project's instructions into a plugin directory and prints its
 * absolute path, and nothing else, on stdout. That is the contract of a Claude
 * Code `command` plugin source: Claude Code runs this at install, once per
 * session, and whenever its cached version is missing, and takes the one line
 * as the plugin's folder. Everything else (progress, warnings) is stderr.
 *
 * A failure exits non-zero with its reason on stderr, which is what Claude
 * Code needs to keep the version it already has; a session never starts worse
 * because Fabric was unreachable.
 *
 * `--hook` is the Codex session hook's mode: the same render, but silent and
 * never failing, because a hook's stdout is the session's context and a hook
 * must not stop a session. It also refreshes the project's `AGENTS.override.md`
 * (Codex has no plugin slot for always-on text) when `--target codex`.
 */
import os from "node:os";
import path from "node:path";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { CliFailure, describeError } from "../../lib/command-boundary.js";
import { getApiKey, getBaseUrl, getConfigPath } from "../../lib/config.js";
import * as git from "../../lib/instructions/git.js";
import { excludeLocalFiles } from "../../lib/instructions/git-exclude.js";
import { isIdentifier } from "../../lib/instructions/identifiers.js";
import { machine } from "../../lib/instructions/machine.js";
import { resolveExistingRoot } from "../../lib/instructions/safe-write.js";
import { DEFAULT_ORIGIN, normalizeOrigin } from "../../lib/origin.js";
import type { PluginTool } from "../../lib/plugin/layout.js";
import { writeAgentsOverride } from "../../lib/plugin/register.js";
import { renderPlugin } from "../../lib/plugin/render.js";

/** One request's budget: a cold render reads every file. */
const REQUEST_TIMEOUT_MS = 30_000;

interface RenderOptions {
	project?: string;
	baseUrl?: string;
	org?: string;
	target?: string;
	out?: string;
	dest?: string;
	hook?: boolean;
}

function toolOf(target: string | undefined): PluginTool {
	if (
		target === undefined ||
		target === "claude-code" ||
		target === "claude"
	) {
		return "claude-code";
	}
	if (target === "codex") {
		return "codex";
	}
	throw new CliFailure("--target is claude-code or codex", 2);
}

export interface RenderedPlugin {
	directory: string;
	alwaysOn: { file: string; text: string } | null;
}

/** The render itself, for `render` and for `init`: no printing. */
export async function renderForProject(input: {
	project: string;
	baseUrl?: string;
	org?: string;
	tool: PluginTool;
	out?: string;
	log?: (line: string) => void;
}): Promise<RenderedPlugin> {
	const origin = normalizeOrigin(
		input.baseUrl ?? getBaseUrl() ?? DEFAULT_ORIGIN,
	);
	if (origin === null) {
		throw new CliFailure("--base-url is not a URL", 2);
	}
	if (!isIdentifier(input.project)) {
		throw new CliFailure("--project is not a project id", 2);
	}
	if (!getApiKey(origin, input.project)) {
		throw new CliFailure(
			`not signed in to ${origin}. Run: fabric auth login --base-url ${origin} --project ${input.project}`,
			3,
		);
	}
	const client = getClient({
		baseUrl: input.baseUrl,
		project: input.project,
		timeoutMs: REQUEST_TIMEOUT_MS,
	}).withoutContext();
	const cacheDirectory = path.join(path.dirname(getConfigPath()), "cache");
	const rendered = await renderPlugin({
		client,
		projectId: input.project,
		org: input.org,
		origin,
		tool: input.tool,
		cacheDirectory:
			input.out !== undefined && input.tool === "claude-code"
				? path.resolve(input.out)
				: cacheDirectory,
		codexPluginsDirectory:
			input.out !== undefined && input.tool === "codex"
				? path.resolve(input.out)
				: path.join(
						machine.home() ?? os.homedir(),
						".codex",
						"plugins",
					),
		timeoutMs: REQUEST_TIMEOUT_MS,
		log: input.log,
	});
	return { directory: rendered.directory, alwaysOn: rendered.alwaysOn };
}

/**
 * Codex has no plugin slot for the always-on file, so a render for it also
 * refreshes `AGENTS.override.md` in the working tree, kept out of commits.
 */
export async function refreshAgentsOverride(
	root: string,
	instructions: string,
): Promise<void> {
	const canonical = await resolveExistingRoot(root);
	const written = await writeAgentsOverride({
		root: canonical,
		instructions,
	});
	if (written.kind === "written") {
		const tree = await git.findWorkTree(canonical, Date.now() + 8_000);
		if (tree.kind === "ok") {
			await excludeLocalFiles({
				toplevel: tree.value.toplevel,
				directory: canonical,
				files: ["AGENTS.override.md"],
				deadline: Date.now() + 8_000,
			});
		}
	}
}

export function registerRenderCommand(instructions: Command): void {
	instructions
		.command("render")
		.description(
			"Build the project's instructions into a coding-tool plugin and print the plugin's folder (for a plugin command source)",
		)
		.requiredOption("--project <id>", "Project ID")
		.option(
			"--base-url <origin>",
			"Deployment to talk to, such as https://example.com (default: the one you are signed in to)",
		)
		.option("--org <slug>", "Organization context")
		.option(
			"--target <tool>",
			"Plugin to build: claude-code (default) or codex",
		)
		.option(
			"--out <dir>",
			"Use this folder instead of the CLI's cache (claude-code: the plugin goes in <dir>/plugins/<project>/<version>; codex: <dir> holds the plugin folder)",
		)
		.option(
			"--dest <dir>",
			"The project folder, for codex's AGENTS.override.md (default: cwd)",
		)
		.option("--hook", "Run as a session hook: print nothing, never fail")
		.action(async (opts: RenderOptions) => {
			try {
				const tool = toolOf(opts.target);
				const rendered = await renderForProject({
					project: opts.project as string,
					baseUrl: opts.baseUrl,
					org: opts.org,
					tool,
					out: opts.out,
					log: (text) => process.stderr.write(`fabric: ${text}\n`),
				});
				if (tool === "codex" && rendered.alwaysOn !== null) {
					await refreshAgentsOverride(
						opts.dest ?? process.cwd(),
						rendered.alwaysOn.text,
					);
				}
				if (!opts.hook) {
					process.stdout.write(`${rendered.directory}\n`);
				}
			} catch (error) {
				process.stderr.write(
					`fabric: render failed: ${error instanceof CliFailure ? error.message : describeError(error)}\n`,
				);
				if (!opts.hook) {
					process.exit(
						error instanceof CliFailure ? error.exitCode : 1,
					);
				}
			}
		});
}
