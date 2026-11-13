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
 *
 * A project with Coding Instructions sets gets the set this folder's
 * repository belongs to (`--set`, or `resolveInstructionSet`). A non-default
 * set is a plugin of its own, and its render command carries `--set`, so the
 * session-start render stays on the same set.
 */
import { existsSync } from "node:fs";
import { rm } from "node:fs/promises";
import path from "node:path";
import { getClient } from "../../lib/client.js";
import { CliFailure, describeError } from "../../lib/command-boundary.js";
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
	updateHookConfig,
} from "../../lib/instructions/hook.js";
import { resolveHookLauncher } from "../../lib/instructions/hook-launcher.js";
import { machine } from "../../lib/instructions/machine.js";
import {
	canPrompt,
	chooseInstructionSet,
} from "../../lib/instructions/prompt.js";
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
import { installCodexPlugin } from "../../lib/plugin/codex-install.js";
import {
	type GatewayRemoval,
	removeLocalClaudeGateway,
} from "../../lib/plugin/gateway.js";
import {
	isSetSlug,
	pluginSetSlug,
	resolveInstructionSet,
} from "../../lib/plugin/instruction-sets.js";
import { idPluginName, pluginNameFor } from "../../lib/plugin/layout.js";
import {
	assignedPluginName,
	assignPluginName,
	renamePluginName,
} from "../../lib/plugin/plugin-names.js";
import {
	claudeApprovalCommands,
	pluginIdFor,
	registerClaudePlugin,
	registerCodexPlugin,
	renderCommandLine,
	writeClaudeMarketplace,
} from "../../lib/plugin/register.js";
import { rulesFolderFor, rulesSyncLines } from "../../lib/plugin/rules-sync.js";
import type { Summary, SummaryStep } from "../../lib/summary.js";
import { refreshAgentsOverride, renderForProject } from "./render.js";
import { syncRulesForProject } from "./rules.js";

export interface PluginInitOptions {
	project: string;
	/** The deployment, as an origin. */
	origin: string;
	org?: string;
	tool?: string;
	dest?: string;
	/** False under `--no-mcp`: the old Claude Code gateway registration is left alone. */
	mcp?: boolean;
	/** `--rename`: move an existing install to the project's readable name. */
	rename?: boolean;
	/** `--set`: the Coding Instructions set to set up (default: the one this checkout's repository belongs to). */
	set?: string;
	format: "text" | "json";
	/** Where the text output's steps are collected; the caller renders it. */
	summary: Summary;
}

type MemoryAccess = "ready" | "no-folders" | "needs-sign-in" | "unavailable";

interface ToolResult {
	tool: InstructionsHookTool;
	settingsPath: string;
	pluginDirectory: string;
	pluginId: string;
}

/** The coding tool as a person names it. */
export function toolDisplayName(tool: string): string {
	return tool === "codex" ? "Codex" : "Claude Code";
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
	set: string | null;
	marketplaceDirectory: string;
	root: string;
	interactive: boolean;
}): Promise<PluginApproval> {
	const commands = claudeApprovalCommands({
		projectId: input.projectId,
		marketplaceDirectory: wordForPaste(input.marketplaceDirectory),
		set: input.set,
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
		[
			"plugin",
			"install",
			pluginIdFor(input.projectId, input.set),
			"--scope",
			"local",
		],
		{ cwd: input.root, timeoutMs: 180_000, interactive: true },
	);
	return installed.kind === "exited" && installed.code === 0
		? { kind: "approved" }
		: { kind: "manual", lines: [commands.install] };
}

/**
 * Put the project's rules in `.claude/rules/fabric-<id>/` so the first session
 * already has them. A failure is a line for the person, never a failed setup:
 * the session hook tries again every time.
 */
async function deliverRules(
	options: PluginInitOptions,
	root: string,
	set: string | null,
): Promise<void> {
	const label = "Project rules";
	const folder = `${rulesFolderFor(options.project, set)}/`;
	try {
		const result = await syncRulesForProject({
			set: set ?? undefined,
			project: options.project,
			baseUrl: options.origin,
			org: options.org,
			root,
		});
		const notes = rulesSyncLines(result);
		if (
			result.written.length + result.unchanged === 0 &&
			notes.length === 0
		) {
			options.summary.add("skipped", label, "none in this project");
			return;
		}
		const details = [
			`Project rules are delivered to ${folder} (kept out of commits; refreshed at each session start).`,
			...notes,
		];
		if (result.refused !== null) {
			options.summary.add(
				"action",
				label,
				`not delivered: ${folder} cannot be used`,
				details,
			);
			return;
		}
		const counts =
			result.written.length > 0 || result.removed.length > 0
				? `${result.written.length} written${result.removed.length > 0 ? `, ${result.removed.length} removed` : ""}`
				: "up to date";
		const kept = result.kept.length + result.skipped.length;
		options.summary.add(
			"ok",
			label,
			`${counts} → ${folder}${kept > 0 ? ` (${kept} left alone)` : ""}`,
			details,
		);
	} catch (error) {
		options.summary.add(
			"action",
			label,
			"not delivered now; retried at each session start",
			[
				`The project's rules could not be delivered now (${describeError(error)}); the session hook retries at each start.`,
			],
		);
	}
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

/**
 * The plugin's readable name (`plugin-names.ts`), chosen on the first set-up
 * of the project on this machine. A plugin already installed under its
 * id-based name (its marketplace folder exists) keeps that name.
 */
/**
 * The plugin name set in Fabric (the project's own, or its name as a slug),
 * or the project's name when an older deployment has no such setting.
 */
async function fabricPluginName(
	options: PluginInitOptions,
): Promise<string | null> {
	const org = options.org ? { org: options.org } : {};
	try {
		return (await getClient().projects.getPluginName(options.project, org))
			.name;
	} catch {
		try {
			return (
				(await getClient().projects.get(options.project, org)).name ??
				null
			);
		} catch {
			return null;
		}
	}
}

/**
 * `--rename`: gives the project its readable name and removes what the
 * old name left in this folder and in the CLI's cache: the Claude Code
 * marketplace entry and enabled plugin in the folder's settings, the cached
 * marketplace, and a rules folder Fabric manages. The set-up that follows
 * registers the plugin under the new name.
 */
async function renameInstalledPlugin(
	options: PluginInitOptions,
	root: string,
	configPath: string,
	set: string | null,
): Promise<{ from: string; to: string } | null> {
	const previous = pluginNameFor(options.project, set);
	const projectName = await fabricPluginName(options);
	const renamed = renamePluginName({
		projectId: options.project,
		projectName,
		previous: pluginNameFor(options.project),
	});
	if (renamed === null) {
		return null;
	}
	const oldId = `${previous}@${previous}`;
	await updateHookConfig({
		root,
		tool: "claude-code",
		update: (settings) => {
			const next = { ...settings };
			for (const key of ["extraKnownMarketplaces", "enabledPlugins"]) {
				const value = next[key];
				if (
					value &&
					typeof value === "object" &&
					!Array.isArray(value)
				) {
					const copy = { ...(value as Record<string, unknown>) };
					delete copy[previous];
					delete copy[oldId];
					next[key] = copy;
				}
			}
			return next;
		},
	});
	await rm(
		path.join(path.dirname(configPath), "cache", "marketplaces", previous),
		{
			recursive: true,
			force: true,
		},
	);
	const rules = path.join(root, ".claude", "rules", previous);
	if (existsSync(path.join(rules, ".fabric-managed.json"))) {
		await rm(rules, { recursive: true, force: true });
	}
	return {
		from: previous,
		to: pluginNameFor(options.project, set),
	};
}

/**
 * The Coding Instructions set this folder gets: `--set`, else the one its
 * repository belongs to; `null` for a project without sets. Asks when several
 * sets apply and a person is there to answer.
 */
async function chooseSet(
	options: PluginInitOptions,
	root: string,
	interactive: boolean,
): Promise<{ slug: string; name: string } | null> {
	if (options.set !== undefined && !isSetSlug(options.set)) {
		throw new CliFailure(
			"--set is a set slug: lowercase letters, digits and dashes",
			2,
		);
	}
	const org = options.org ? { org: options.org } : {};
	const client = getClient();
	const chosen = await resolveInstructionSet(options.set, {
		listSets: async () => {
			try {
				return (
					await client.projects.listInstructionSets(
						options.project,
						org,
					)
				).sets;
			} catch (error) {
				// A deployment that does not know sets has none.
				if (
					options.set === undefined &&
					(error as { status?: number }).status === 404
				) {
					return [];
				}
				throw error;
			}
		},
		listCodeRepositories: async () =>
			(await client.projects.listCodeRepositories(options.project, org))
				.repositories,
		remoteUrls: () => checkoutRemoteUrls(root),
		choose: interactive ? (sets) => chooseInstructionSet(sets) : undefined,
	});
	return chosen === null ? null : { slug: chosen.slug, name: chosen.name };
}

/** The fetch URLs of the checkout's remotes; `[]` when the folder is no git checkout. */
async function checkoutRemoteUrls(root: string): Promise<string[]> {
	const deadline = Date.now() + 8_000;
	const tree = await git.findWorkTree(root, deadline);
	if (tree.kind !== "ok") {
		return [];
	}
	const names = await git.remotes(tree.value.toplevel, deadline);
	if (names.kind !== "ok") {
		return [];
	}
	const urls: string[] = [];
	for (const name of names.value) {
		const url = await git.effectiveFetchUrl(
			tree.value.toplevel,
			name,
			deadline,
		);
		if (url.kind === "ok" && url.value !== null) {
			urls.push(url.value);
		}
	}
	return urls;
}

async function choosePluginName(
	options: PluginInitOptions,
	configPath: string,
): Promise<void> {
	if (assignedPluginName(options.project) !== null) {
		return;
	}
	const legacy = idPluginName(options.project);
	const installed = existsSync(
		path.join(path.dirname(configPath), "cache", "marketplaces", legacy),
	);
	const projectName = installed ? null : await fabricPluginName(options);
	assignPluginName({
		projectId: options.project,
		projectName,
		keep: installed ? legacy : null,
	});
}

/** Sets the plugin up; returns the tools it set up. */
export interface PluginInitResult {
	tools: InstructionsHookTool[];
	/**
	 * Whether the Claude Code plugin's MCP server takes its Authorization
	 * header from this CLI (`fabric mcp header`); `null` when no Claude Code
	 * plugin was set up.
	 */
	claudeMcpHeadersHelper: boolean | null;
	/** The non-default Coding Instructions set set up (its own plugin), else `null`. */
	set: string | null;
}

export async function runPluginInit(
	options: PluginInitOptions,
): Promise<PluginInitResult> {
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

	const interactive =
		options.format !== "json" &&
		canPrompt() &&
		process.stdout.isTTY === true &&
		!runningInCi();
	const chosenSet = await chooseSet(options, root, interactive);
	const set = pluginSetSlug(chosenSet?.slug);
	const renamed = options.rename
		? await renameInstalledPlugin(options, root, getConfigPath(), set)
		: null;
	await choosePluginName(options, getConfigPath());
	const summary = options.summary;
	if (chosenSet !== null) {
		summary.add(
			"ok",
			"Coding Instructions set",
			`${chosenSet.slug}${set === null ? " (the project's plugin)" : ` (plugin ${pluginNameFor(options.project, set)})`}`,
			[
				`This folder gets the Coding Instructions set ${chosenSet.slug}: its instructions only. Pass --set to choose another.`,
			],
		);
	}
	if (renamed !== null) {
		summary.add(
			"ok",
			"Plugin renamed",
			`${renamed.from} → ${renamed.to} (skills: /${renamed.to}:<skill>)`,
			[
				`Renamed the plugin ${renamed.from} to ${renamed.to}; its skills are now /${renamed.to}:<skill>. Claude Code drops the old one at its next start (to remove it at once: claude plugin uninstall ${renamed.from}@${renamed.from}).`,
			],
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
	const results: ToolResult[] = [];
	const excludes: string[] = [".fabric"];
	let marketplaceDirectory: string | null = null;
	let claudePlugin: SummaryStep | null = null;
	let claudeMcpHeadersHelper: boolean | null = null;
	for (const tool of tools) {
		const rendered = await renderForProject({
			project: options.project,
			baseUrl: options.origin,
			org: options.org,
			tool,
			set: chosenSet?.slug,
		});
		if (tool === "claude-code") {
			claudeMcpHeadersHelper = rendered.mcpHeadersHelper;
			const command = renderCommandLine({
				launcherPrefix: launcher.prefix,
				nodeWord: pathAsCommandWord(process.execPath),
				projectId: options.project,
				baseUrl: options.origin,
				org: options.org,
				set,
			});
			marketplaceDirectory = await writeClaudeMarketplace({
				cacheDirectory: path.join(
					path.dirname(getConfigPath()),
					"cache",
				),
				projectId: options.project,
				origin: options.origin,
				command,
				set,
			});
			const registered = await registerClaudePlugin({
				root,
				projectId: options.project,
				marketplaceDirectory,
				set,
			});
			excludes.push(CLAUDE_SETTINGS_RELATIVE_PATH);
			// Settled by the approval below; added first, so it leads the list.
			claudePlugin = summary.add(
				"ok",
				"Plugin registered",
				`${pluginIdFor(options.project, set)} (local)`,
				[
					`Registered the ${pluginNameFor(options.project, set)} plugin in ${path.relative(root, registered.settingsPath) || registered.settingsPath} (marketplace folder ${marketplaceDirectory}); Claude Code builds it from Fabric at the start of each session.`,
				],
			);
			await deliverRules(options, root, set);
		} else {
			const registration = await registerCodexPlugin({
				home: machine.home() ?? root,
				projectId: options.project,
				pluginDirectory: rendered.directory,
				set,
			});
			const listed = `Rendered the ${pluginNameFor(options.project, set)} plugin to ${rendered.directory} and listed it in ${registration.marketplaceFile} (marketplace "${registration.marketplaceName}").`;
			const installed = await installCodexPlugin({
				run,
				projectId: options.project,
				marketplaceName: registration.marketplaceName,
				cwd: root,
				set,
			});
			if (installed.kind === "installed") {
				summary.add(
					"ok",
					"Codex plugin",
					`${pluginNameFor(options.project, set)}@${registration.marketplaceName} installed`,
					[
						listed,
						`Installed the ${pluginNameFor(options.project, set)} plugin in Codex.`,
					],
				);
			} else {
				const install =
					installed.line ??
					`codex plugin add ${pluginNameFor(options.project, set)}@${registration.marketplaceName}`;
				summary.add(
					"action",
					"Codex plugin",
					"listed, but Codex did not install it (see below)",
					[
						listed,
						`Codex did not install the plugin. Run: ${install}`,
					],
				);
				summary.todo("Install the plugin in Codex:", [install]);
			}
			if (rendered.agentsText !== null) {
				await refreshAgentsOverride(root, rendered.agentsText);
				excludes.push("AGENTS.override.md");
				summary.add(
					"ok",
					"AGENTS.override.md",
					"written (kept out of commits)",
					[
						"Wrote AGENTS.override.md (kept out of commits): the project's AGENTS.md, then the instructions and the project's rules.",
					],
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
			set,
		});
		excludes.push(
			tool === "codex"
				? CODEX_HOOKS_RELATIVE_PATH
				: CLAUDE_SETTINGS_RELATIVE_PATH,
		);
		if (tool === "claude-code") {
			summary.add(
				"ok",
				"Hooks",
				"memory pull at start, push at turn end",
				[
					"Added hooks: memory files are pulled at session start and sent when a turn ends.",
				],
			);
		} else {
			summary.add(
				"ok",
				"Codex hooks",
				"plugin refresh and memory exchange at session start",
				[
					"Added hooks: the plugin is refreshed and memory files are exchanged at session start (Codex has no end-of-turn hook).",
				],
			);
		}
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
					? pluginIdFor(options.project, set)
					: pluginNameFor(options.project, set),
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
					set,
					marketplaceDirectory,
					root,
					interactive,
				});
	const memory = await probeMemory(options, root);

	if (options.format === "json") {
		printOutput(
			{
				projectId: options.project,
				instructionSet: chosenSet?.slug ?? null,
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
		return {
			tools: results.map((result) => result.tool),
			claudeMcpHeadersHelper,
			set,
		};
	}

	if (excluded?.kind === "failed") {
		summary.add(
			"action",
			"Git exclude",
			"could not be updated (see below)",
			[
				`Add these to .git/info/exclude yourself so they stay out of commits: ${excluded.entries.join(", ")}`,
			],
		);
		summary.todo(
			"Add these to .git/info/exclude so they stay out of commits:",
			excluded.entries,
		);
	}
	if (!detected.detected && explicit === undefined) {
		summary.add(
			"skipped",
			"Tool detection",
			"no coding tool found; set up Claude Code (--tool codex for Codex)",
			[
				"No coding tool was found on this machine, so Claude Code was set up. Pass --tool codex for Codex.",
			],
		);
	}
	if (launcher.warning !== null) {
		summary.add("action", "Session hook", "see below", [launcher.warning]);
		summary.todo(launcher.warning);
	}
	switch (gateway.kind) {
		case "removed":
			summary.add(
				"ok",
				"Earlier MCP entry",
				`${gateway.name} removed (the plugin carries the MCP server)`,
				[
					`Removed the earlier Claude Code registration ${gateway.name} (this folder's local scope): the plugin carries the project's MCP server, and keeping both would show two sets of tools.`,
				],
			);
			break;
		case "failed": {
			const remove = `claude mcp remove ${gateway.name} --scope local`;
			summary.add(
				"action",
				"Earlier MCP entry",
				`${gateway.name} not removed; agents may see two sets of tools`,
				[
					`The earlier Claude Code registration ${gateway.name} could not be removed, so agents may see two sets of tools. Run: ${remove}`,
				],
			);
			summary.todo("Remove the earlier MCP entry:", [remove]);
			break;
		}
		case "none":
		case "unchecked":
			break;
		default:
			assertNever(gateway);
	}
	if (claudePlugin !== null) {
		if (approval.kind === "approved") {
			claudePlugin.label = "Plugin installed";
			claudePlugin.details.push(
				"Approved the plugin's command in Claude Code.",
			);
		} else if (approval.kind === "manual") {
			claudePlugin.status = "action";
			claudePlugin.detail = `${pluginIdFor(options.project, set)}: approve its command once (see below)`;
			claudePlugin.details.push(
				"Claude Code asks you to approve the plugin's command once, in your own terminal; it shows the exact command and will not accept it from inside a coding session.",
			);
			summary.todo(
				"Approve the plugin's command in your own terminal, from this folder:",
				approval.lines,
			);
		}
	}
	const memoryLabel = "Memory access";
	switch (memory) {
		case "ready":
			summary.add("ok", memoryLabel, "memory folders ready", [
				"Memory folders are ready: files agents write there reach the repository through Fabric.",
			]);
			break;
		case "no-folders":
			summary.add(
				"skipped",
				memoryLabel,
				"no memory folders yet (a project admin adds them in the Context tab)",
				[
					"This project has no memory folders yet. A project admin adds them in the project's Context tab.",
				],
			);
			break;
		case "needs-sign-in": {
			const login = fabricCommand(
				`auth login --project ${options.project}`,
				options.origin,
			);
			summary.add(
				"action",
				memoryLabel,
				"needs one more sign-in (see below)",
				[
					`This sign-in cannot reach the memory folders yet. Sign in again and approve the memory permission: ${login}`,
				],
			);
			summary.todo("Sign in again and approve the memory permission:", [
				login,
			]);
			break;
		}
		case "unavailable":
			summary.add(
				"action",
				memoryLabel,
				"could not be checked just now",
				["The memory folders could not be checked just now."],
			);
			break;
	}
	return {
		tools: results.map((result) => result.tool),
		claudeMcpHeadersHelper,
		set,
	};
}

function assertNever(value: never): never {
	throw new Error(`unexpected value: ${JSON.stringify(value)}`);
}
