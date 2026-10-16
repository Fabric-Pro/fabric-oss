/**
 * The hooks `init --plugin` writes for the memory mirror and the plugin.
 *
 * Claude Code: `memory pull --hook` at session start (it settles anything the
 * last session sent, then brings the folders in) and `memory push --hook` when
 * a turn ends. Codex has no end-of-turn hook, so its session start also
 * flushes (`memory pull --flush`), and re-renders the plugin, because Codex
 * loads a plugin from a fixed folder rather than running a command.
 *
 * Each run describes the DESIRED state, as `init` always has: the entries for
 * the project are replaced, never stacked, and entries of anyone else's are
 * left as they are. An entry is recognised by its words, never by a substring
 * (`--project abc` is not `--project abc-extra`).
 */

import {
	type InstructionsHookTool,
	objectAt,
	parseHookCommand,
	updateHookConfig,
} from "../instructions/hook.js";
import { isIdentifier } from "../instructions/identifiers.js";

type Event = "SessionStart" | "Stop";

/** What a hook command is for; `instructions render` is Codex's plugin refresh. */
type Kind = "memory-pull" | "memory-push" | "plugin-render";

const HOOK_TIMEOUT_SECONDS = 15;

/** Render may fetch every file on a cold start. */
const RENDER_HOOK_TIMEOUT_SECONDS = 60;

interface Entry {
	event: Event;
	kind: Kind;
	command: string;
	timeout: number;
}

function projectOf(args: readonly string[]): string | null {
	const at = args.indexOf("--project");
	return at >= 0 ? (args[at + 1] ?? null) : null;
}

function kindOf(command: unknown): Kind | null {
	if (typeof command !== "string") {
		return null;
	}
	const args = parseHookCommand(command)?.args;
	if (args === undefined) {
		return null;
	}
	if (args[0] === "memory" && args[1] === "pull") {
		return "memory-pull";
	}
	if (args[0] === "memory" && args[1] === "push") {
		return "memory-push";
	}
	if (args[0] === "instructions" && args[1] === "render") {
		return "plugin-render";
	}
	return null;
}

function isOurs(
	hook: unknown,
	projectId: string,
	kinds: readonly Kind[],
): boolean {
	if (typeof hook !== "object" || hook === null) {
		return false;
	}
	const command = (hook as { command?: unknown }).command;
	const kind = kindOf(command);
	if (kind === null || !kinds.includes(kind)) {
		return false;
	}
	const args = parseHookCommand(command as string)?.args ?? [];
	return projectOf(args) === projectId;
}

function words(
	launcher: string,
	verb: string,
	projectId: string,
	binding: { baseUrl?: string; org?: string },
	extra: string,
): string {
	if (
		!isIdentifier(projectId) ||
		(binding.org && !isIdentifier(binding.org))
	) {
		throw new Error(
			"A project id and an organization slug in a hook command must be plain identifiers",
		);
	}
	const deployment = binding.baseUrl ? ` --base-url ${binding.baseUrl}` : "";
	const org = binding.org ? ` --org ${binding.org}` : "";
	return `${launcher} ${verb} --project ${projectId}${extra}${deployment}${org} --hook`;
}

/** The hooks a tool should have for a project. */
export function desiredHooks(input: {
	tool: InstructionsHookTool;
	projectId: string;
	/** How hooks start this CLI: `fabric`, or `node <kept copy>`. */
	launcher: string;
	baseUrl?: string;
	org?: string;
}): Entry[] {
	const binding = { baseUrl: input.baseUrl, org: input.org };
	if (input.tool === "codex") {
		return [
			{
				event: "SessionStart",
				kind: "plugin-render",
				command: words(
					input.launcher,
					"instructions render",
					input.projectId,
					binding,
					" --target codex",
				),
				timeout: RENDER_HOOK_TIMEOUT_SECONDS,
			},
			{
				event: "SessionStart",
				kind: "memory-pull",
				command: words(
					input.launcher,
					"memory pull",
					input.projectId,
					binding,
					" --flush",
				),
				timeout: HOOK_TIMEOUT_SECONDS,
			},
		];
	}
	return [
		{
			event: "SessionStart",
			kind: "memory-pull",
			command: words(
				input.launcher,
				"memory pull",
				input.projectId,
				binding,
				"",
			),
			timeout: HOOK_TIMEOUT_SECONDS,
		},
		{
			event: "Stop",
			kind: "memory-push",
			command: words(
				input.launcher,
				"memory push",
				input.projectId,
				binding,
				"",
			),
			timeout: HOOK_TIMEOUT_SECONDS,
		},
	];
}

type HookGroup = {
	hooks: Array<Record<string, unknown>>;
	[key: string]: unknown;
};

function groupsOf(
	hooks: Record<string, unknown>,
	event: Event,
	settingsPath: string,
): HookGroup[] {
	const value = hooks[event];
	if (value === undefined) {
		return [];
	}
	if (!Array.isArray(value)) {
		throw new Error(
			`${settingsPath} has a shape this tool does not recognise: "hooks.${event}" is not an array. It was left untouched.`,
		);
	}
	return value.map((group) => {
		if (
			typeof group !== "object" ||
			group === null ||
			Array.isArray(group)
		) {
			throw new Error(
				`${settingsPath} has a shape this tool does not recognise: a "hooks.${event}" entry is not an object. It was left untouched.`,
			);
		}
		const hooksOf = (group as { hooks?: unknown }).hooks;
		if (hooksOf !== undefined && !Array.isArray(hooksOf)) {
			throw new Error(
				`${settingsPath} has a shape this tool does not recognise: "hooks.${event}[].hooks" is not an array. It was left untouched.`,
			);
		}
		return {
			...(group as Record<string, unknown>),
			hooks: [...((hooksOf as Array<Record<string, unknown>>) ?? [])],
		};
	});
}

/** Drop our entries of `kinds` for the project from one event's groups. */
function without(
	groups: HookGroup[],
	projectId: string,
	kinds: readonly Kind[],
): HookGroup[] {
	const kept: HookGroup[] = [];
	for (const group of groups) {
		const rest = group.hooks.filter(
			(hook) => !isOurs(hook, projectId, kinds),
		);
		if (rest.length === 0 && group.hooks.length > 0) {
			continue;
		}
		kept.push({ ...group, hooks: rest });
	}
	return kept;
}

export async function installPluginHooks(input: {
	root: string;
	tool: InstructionsHookTool;
	projectId: string;
	launcher: string;
	baseUrl?: string;
	org?: string;
}) {
	const wanted = desiredHooks(input);
	const allKinds: Kind[] = ["memory-pull", "memory-push", "plugin-render"];
	return updateHookConfig({
		root: input.root,
		tool: input.tool,
		update: (settings, settingsPath) => {
			const hooks = objectAt(settings, "hooks", settingsPath);
			for (const event of ["SessionStart", "Stop"] as const) {
				const groups = without(
					groupsOf(hooks, event, settingsPath),
					input.projectId,
					allKinds,
				);
				for (const entry of wanted.filter(
					(hook) => hook.event === event,
				)) {
					groups.push({
						hooks: [
							{
								type: "command",
								command: entry.command,
								timeout: entry.timeout,
							},
						],
					});
				}
				if (groups.length > 0) {
					hooks[event] = groups;
				} else {
					delete hooks[event];
				}
			}
			return { ...settings, hooks };
		},
	});
}
