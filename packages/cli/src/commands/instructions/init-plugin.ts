/**
 * `fabric instructions init --plugin`: deliver a project's coding instructions
 * as a plugin instead of a clone.
 *
 * Nothing about the instructions is copied into the project. Claude Code is
 * given a plugin whose files are produced on demand (`instructions render`),
 * Codex a plugin folder and a marketplace entry that point at one, and both a
 * pair of hooks that keep the project's memory folders in step with Fabric
 * (`memory pull|push`). The settings files written are the developer's own
 * and per-machine (`.claude/settings.local.json`, `.codex/hooks.json`), kept
 * out of commits through `.git/info/exclude`.
 *
 * This is what a bare `init` does. The clone mode (`init --clone`, or `init` run
 * inside an existing clone of the instructions' repository) is unchanged and
 * still the way to work on the instructions themselves.
 *
 * The plugin carries the project's MCP gateway, so no tool's own MCP
 * registration is added; an earlier Claude Code one is taken out so an agent
 * does not see two sets of tools.
 */
import path from "node:path";
import { CliFailure } from "../../lib/command-boundary.js";
import { getConfigPath } from "../../lib/config.js";
import { runningInCi } from "../../lib/environment.js";
import {
	type AgentRunner,
	createAgentRunner,
} from "../../lib/instructions/agent-run.js";
import * as git from "../../lib/instructions/git.js";
import { excludeLocalFiles } from "../../lib/instructions/git-exclude.js";
import {
	assertKeyStaysOutside,
	CLAUDE_SETTINGS_RELATIVE_PATH,
	CODEX_HOOKS_RELATIVE_PATH,
	type InstructionsHookTool,
	removeCommandHook,
} from "../../lib/instructions/hook.js";
import { resolveHookLauncher } from "../../lib/instructions/hook-launcher.js";
import { machine } from "../../lib/instructions/machine.js";
import { canPrompt } from "../../lib/instructions/prompt.js";
import { resolveDestinationRoot } from "../../lib/instructions/safe-write.js";
import { detectTools } from "../../lib/instructions/tools.js";
import {
	bundleScriptPath,
	fabricCommand,
	isServedBundle,
	pathAsCommandWord,
} from "../../lib/launcher.js";
import { installPluginHooks } from "../../lib/memory/hooks.js";
import { writeProjectMarker } from "../../lib/memory/project-root.js";
import { createRuntime } from "../../lib/memory/runtime.js";
import { printOutput } from "../../lib/output.js";
import {
	type GatewayRemoval,
	removeLocalClaudeGateway,
} from "../../lib/plugin/gateway.js";
import { pluginNameFor } from "../../lib/plugin/layout.js";
import {
	claudeApprovalCommands,
	pluginIdFor,
	registerClaudePlugin,
	registerCodexPlugin,
	renderCommandLine,
	writeClaudeMarketplace,
} from "../../lib/plugin/register.js";
import { refreshAgentsOverride, renderForProject } from "./render.js";

export interface PluginInitOptions {
	project: string;
	/** The deployment, as an origin. */
	origin: string;
	org?: string;
	tool?: string;
	dest?: string;
	/** False under `--no-mcp`: the old Claude Code gateway registration is left alone. */
	mcp?: boolean;
	format: "text" | "json";
}

type MemoryAccess = "ready" | "no-folders" | "needs-sign-in" | "unavailable";

interface ToolResult {
	tool: InstructionsHookTool;
	settingsPath: string;
	pluginDirectory: string;
	pluginId: string;
	steps: string[];
}

type PluginApproval =
	| { kind: "not-needed" }
	| { kind: "approved" }
	| { kind: "manual"; lines: string[] };

/** A word for a command the person pastes: quoted when it holds a space. */
function wordForPaste(value: string): string {
	return pathAsCommandWord(value) ?? value;
}

/**
 * Claude Code runs a `command` plugin source only after the person has reviewed
 * the exact command and accepted it, once, in their own terminal; it refuses
 * the acceptance from anywhere else (a coding session included), and that is
 * deliberate. So this registers the marketplace folder with `claude plugin
 * marketplace add` (which asks nothing), then hands the terminal over to
 * `claude plugin install`, where the person sees the command and answers. Where
 * that cannot be done (no terminal, no `claude` on PATH) it says the lines to
 * run.
 */
async function approveClaudePlugin(input: {
	run: AgentRunner;
	projectId: string;
	marketplaceDirectory: string;
	root: string;
	interactive: boolean;
}): Promise<PluginApproval> {
	const commands = claudeApprovalCommands({
		projectId: input.projectId,
		marketplaceDirectory: wordForPaste(input.marketplaceDirectory),
	});
	const asArgument =
		process.platform === "win32"
			? input.marketplaceDirectory.replaceAll("\\", "/")
			: input.marketplaceDirectory;
	const added = await input.run(
		"claude",
		["plugin", "marketplace", "add", asArgument, "--scope", "local"],
		{ cwd: input.root, timeoutMs: 60_000 },
	);
	if (added.kind !== "exited" || added.code !== 0) {
		return { kind: "manual", lines: [commands.add, commands.install] };
	}
	if (!input.interactive) {
		return { kind: "manual", lines: [commands.install] };
	}
	const installed = await input.run(
		"claude",
		["plugin", "install", pluginIdFor(input.projectId), "--scope", "local"],
		{ cwd: input.root, timeoutMs: 180_000, interactive: true },
	);
	return installed.kind === "exited" && installed.code === 0
		? { kind: "approved" }
		: { kind: "manual", lines: [commands.install] };
}

function line(text: string): void {
	process.stdout.write(`${text}\n`);
}

function toolOf(value: string): InstructionsHookTool {
	if (value === "claude-code" || value === "codex") {
		return value;
	}
	throw new CliFailure("--tool is claude-code or codex", 2);
}

/** Does the sign-in reach the memory folders? Reads only; never fails the setup. */
async function probeMemory(
	options: PluginInitOptions,
	root: string,
): Promise<MemoryAccess> {
	try {
		const { context } = await createRuntime({
			project: options.project,
			baseUrl: options.origin,
			dest: root,
		});
		const { targets } = await context.client.memory.getTargets(
			options.project,
		);
		return targets.length === 0 ? "no-folders" : "ready";
	} catch (error) {
		const code = (error as { code?: string }).code;
		return code === "MISSING_SCOPE" ? "needs-sign-in" : "unavailable";
	}
}

export async function runPluginInit(options: PluginInitOptions): Promise<void> {
	const explicit =
		options.tool === undefined ? undefined : toolOf(options.tool);
	const destination = path.resolve(options.dest ?? process.cwd());
	const root = await resolveDestinationRoot(destination);
	try {
		await assertKeyStaysOutside(root, getConfigPath());
	} catch (error) {
		throw new CliFailure(
			error instanceof Error ? error.message : String(error),
			7,
		);
	}

	const detected = await detectTools({
		root,
		home: machine.home(),
		lookup: { env: machine.env(), platform: machine.platform() },
	});
	const tools = explicit === undefined ? detected.tools : [explicit];

	const launcher = await resolveHookLauncher({
		origin: options.origin,
		configDirectory: path.dirname(getConfigPath()),
		lookup: { env: machine.env(), platform: machine.platform() },
		bundle: isServedBundle() ? { scriptPath: bundleScriptPath() } : null,
	});

	const run = createAgentRunner({
		lookup: { env: machine.env(), platform: machine.platform() },
	});
	const interactive =
		options.format !== "json" &&
		canPrompt() &&
		process.stdout.isTTY === true &&
		!runningInCi();
	const results: ToolResult[] = [];
	const excludes: string[] = [".fabric"];
	let marketplaceDirectory: string | null = null;
	for (const tool of tools) {
		const rendered = await renderForProject({
			project: options.project,
			baseUrl: options.origin,
			org: options.org,
			tool,
		});
		const steps: string[] = [];
		if (tool === "claude-code") {
			const command = renderCommandLine({
				launcherPrefix: launcher.prefix,
				nodeWord: pathAsCommandWord(process.execPath),
				projectId: options.project,
				baseUrl: options.origin,
				org: options.org,
			});
			marketplaceDirectory = await writeClaudeMarketplace({
				cacheDirectory: path.join(
					path.dirname(getConfigPath()),
					"cache",
				),
				projectId: options.project,
				command,
			});
			const registered = await registerClaudePlugin({
				root,
				projectId: options.project,
				marketplaceDirectory,
			});
			excludes.push(CLAUDE_SETTINGS_RELATIVE_PATH);
			steps.push(
				`Registered the ${pluginNameFor(options.project)} plugin in ${path.relative(root, registered.settingsPath) || registered.settingsPath} (marketplace folder ${marketplaceDirectory}); Claude Code builds it from Fabric at the start of each session.`,
			);
		} else {
			const registration = await registerCodexPlugin({
				home: machine.home() ?? root,
				projectId: options.project,
				pluginDirectory: rendered.directory,
			});
			steps.push(
				`Rendered the ${pluginNameFor(options.project)} plugin to ${rendered.directory} and listed it in ${registration.marketplaceFile} (marketplace "${registration.marketplaceName}"). Install it from Codex's plugin browser if it is not on yet.`,
			);
			if (rendered.alwaysOn !== null) {
				await refreshAgentsOverride(root, rendered.alwaysOn.text);
				excludes.push("AGENTS.override.md");
				steps.push(
					"Wrote AGENTS.override.md (kept out of commits): the project's AGENTS.md, then the instructions.",
				);
			}
		}

		const hooks = await installPluginHooks({
			root,
			tool,
			projectId: options.project,
			launcher: launcher.prefix,
			baseUrl: options.origin,
			org: options.org,
		});
		excludes.push(
			tool === "codex"
				? CODEX_HOOKS_RELATIVE_PATH
				: CLAUDE_SETTINGS_RELATIVE_PATH,
		);
		steps.push(
			tool === "claude-code"
				? "Added hooks: memory files are pulled at session start and sent when a turn ends."
				: "Added hooks: the plugin is refreshed and memory files are exchanged at session start (Codex has no end-of-turn hook).",
		);
		// An earlier clone-mode setup kept the checkout current by hook; the
		// plugin makes that hook redundant, so it is taken out.
		for (const subcommand of ["check", "sync"]) {
			await removeCommandHook({
				root,
				projectId: options.project,
				subcommand,
				tool,
				event: "SessionStart",
			});
		}
		results.push({
			tool,
			settingsPath: hooks.settingsPath,
			pluginDirectory: rendered.directory,
			pluginId:
				tool === "claude-code"
					? pluginIdFor(options.project)
					: pluginNameFor(options.project),
			steps,
		});
	}

	const tree = await git.findWorkTree(root, Date.now() + 8_000);
	const toplevel = tree.kind === "ok" ? tree.value.toplevel : null;
	const excluded =
		toplevel === null
			? null
			: await excludeLocalFiles({
					toplevel,
					directory: root,
					files: [...new Set(excludes)],
					deadline: Date.now() + 8_000,
				});

	await writeProjectMarker(root, {
		projectId: options.project,
		gitToplevel: toplevel,
	});

	const gateway: GatewayRemoval =
		options.mcp === false || !tools.includes("claude-code")
			? { kind: "unchecked" }
			: await removeLocalClaudeGateway({
					run,
					projectId: options.project,
					origin: options.origin,
					cwd: toplevel ?? root,
					home: machine.home(),
					env: machine.env(),
					platform: machine.platform(),
				});
	const approval: PluginApproval =
		marketplaceDirectory === null
			? { kind: "not-needed" }
			: await approveClaudePlugin({
					run,
					projectId: options.project,
					marketplaceDirectory,
					root,
					interactive,
				});
	const memory = await probeMemory(options, root);

	if (options.format === "json") {
		printOutput(
			{
				projectId: options.project,
				mode: "plugin",
				destination: root,
				tools: results.map((result) => ({
					tool: result.tool,
					settingsPath: result.settingsPath,
					pluginDirectory: result.pluginDirectory,
					pluginId: result.pluginId,
				})),
				memory,
				pluginApproval: approval,
				excluded: excluded?.kind ?? null,
				gatewayVia: "plugin",
				previousGatewayRegistration: gateway.kind,
			},
			{ format: "json" },
		);
		return;
	}

	for (const result of results) {
		for (const step of result.steps) {
			line(step);
		}
	}
	if (excluded?.kind === "failed") {
		line(
			`Add these to .git/info/exclude yourself so they stay out of commits: ${excluded.entries.join(", ")}`,
		);
	}
	if (!detected.detected && explicit === undefined) {
		line(
			"No coding tool was found on this machine, so Claude Code was set up. Pass --tool codex for Codex.",
		);
	}
	if (launcher.warning !== null) {
		line(launcher.warning);
	}
	switch (gateway.kind) {
		case "removed":
			line(
				`Removed the earlier Claude Code registration ${gateway.name} (this folder's local scope): the plugin carries the project's MCP server, and keeping both would show two sets of tools.`,
			);
			break;
		case "failed":
			line(
				`The earlier Claude Code registration ${gateway.name} could not be removed, so agents may see two sets of tools. Run: claude mcp remove ${gateway.name} --scope local`,
			);
			break;
		case "none":
		case "unchecked":
			break;
		default:
			assertNever(gateway);
	}
	if (approval.kind === "approved") {
		line("Approved the plugin's command in Claude Code.");
	} else if (approval.kind === "manual") {
		line(
			"Claude Code asks you to approve the plugin's command once, in your own terminal. Run, from this folder:",
		);
		for (const command of approval.lines) {
			line(`  ${command}`);
		}
		line(
			"Claude Code shows the exact command that will run and asks you to confirm; it will not accept it from inside a coding session.",
		);
	}
	switch (memory) {
		case "ready":
			line(
				"Memory folders are ready: files agents write there reach the repository through Fabric.",
			);
			break;
		case "no-folders":
			line(
				"This project has no memory folders yet. A project admin adds them in the project's Context tab.",
			);
			break;
		case "needs-sign-in":
			line(
				`This sign-in cannot reach the memory folders yet. Sign in again and approve the memory permission: ${fabricCommand(`auth login --project ${options.project}`, options.origin)}`,
			);
			break;
		case "unavailable":
			line("The memory folders could not be checked just now.");
			break;
	}
	line(
		`Set up ${results.map((result) => result.tool).join(" and ")} for project ${options.project} as a plugin. Start a new session to use it.`,
	);
}

function assertNever(value: never): never {
	throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
