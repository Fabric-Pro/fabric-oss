/**
 * The project and deployment a plugin location belongs to.
 *
 * A plugin is named from the last eight letters and digits of a project's id,
 * so two projects (or one id on two deployments) can ask for the same name. The
 * marketplace folder Claude Code reads and the folder Codex installs from are
 * both keyed by that name, so a second owner would silently repoint every
 * folder already set up for the first. Each location therefore carries a
 * `.fabric-binding.json` saying whose it is, and a write that would change the
 * owner is refused.
 *
 * A location written before the file existed is read for the same facts: the
 * Claude marketplace's render command names `--project` and `--base-url`, a
 * Codex folder's `.mcp.json` holds the project's gateway URL. Only a different
 * project or deployment that is positively identified is a conflict; what
 * cannot be read is taken as free and gets the file on the next write.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CliFailure } from "../command-boundary.js";
import { pluginNameFor } from "./layout.js";

export const BINDING_FILE = ".fabric-binding.json";

export interface PluginBinding {
	projectId: string;
	/** The deployment's origin, or `null` when it is not known. */
	origin: string | null;
}

export type PluginLocation = "claude-marketplace" | "codex-plugin";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function originOf(value: string): string | null {
	try {
		return new URL(value).origin;
	} catch {
		return null;
	}
}

export function bindingText(binding: PluginBinding): string {
	return `${JSON.stringify(binding, null, 2)}\n`;
}

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch {
		return null;
	}
}

function valueAfter(words: readonly string[], flag: string): string | null {
	const at = words.indexOf(flag);
	return at >= 0 ? (words[at + 1] ?? null) : null;
}

async function bindingFromSidecar(
	directory: string,
): Promise<PluginBinding | null> {
	const parsed = await readJson(path.join(directory, BINDING_FILE));
	if (!isRecord(parsed) || typeof parsed.projectId !== "string") {
		return null;
	}
	return {
		projectId: parsed.projectId,
		origin: typeof parsed.origin === "string" ? parsed.origin : null,
	};
}

async function legacyClaudeBinding(
	directory: string,
): Promise<PluginBinding | null> {
	const parsed = await readJson(
		path.join(directory, ".claude-plugin", "marketplace.json"),
	);
	if (!isRecord(parsed) || !Array.isArray(parsed.plugins)) {
		return null;
	}
	for (const plugin of parsed.plugins) {
		const source = isRecord(plugin) ? plugin.source : null;
		const command = isRecord(source) ? source.command : null;
		if (typeof command !== "string") {
			continue;
		}
		const words = command.split(/\s+/);
		const projectId = valueAfter(words, "--project");
		if (projectId !== null) {
			const baseUrl = valueAfter(words, "--base-url");
			return {
				projectId,
				origin: baseUrl === null ? null : originOf(baseUrl),
			};
		}
	}
	return null;
}

const GATEWAY_URL = /^(.+)\/api\/mcp-gateway\/projects\/([A-Za-z0-9_-]+)\/?$/;

async function legacyCodexBinding(
	directory: string,
): Promise<PluginBinding | null> {
	const parsed = await readJson(path.join(directory, ".mcp.json"));
	if (!isRecord(parsed) || !isRecord(parsed.mcpServers)) {
		return null;
	}
	for (const server of Object.values(parsed.mcpServers)) {
		const url = isRecord(server) ? server.url : null;
		if (typeof url !== "string") {
			continue;
		}
		const projectId = GATEWAY_URL.exec(url)?.[2];
		if (projectId !== undefined) {
			return { projectId, origin: originOf(url) };
		}
	}
	return null;
}

async function readBinding(
	directory: string,
	location: PluginLocation,
): Promise<PluginBinding | null> {
	return (
		(await bindingFromSidecar(directory)) ??
		(location === "claude-marketplace"
			? await legacyClaudeBinding(directory)
			: await legacyCodexBinding(directory))
	);
}

/**
 * Refuse to take over a location that belongs to another project or
 * deployment. `uninstall` is how the other setup's plugin is taken out of the
 * tool before its folder is removed.
 */
export async function assertLocationFree(input: {
	directory: string;
	location: PluginLocation;
	wanted: PluginBinding;
}): Promise<void> {
	const existing = await readBinding(input.directory, input.location);
	if (existing === null) {
		return;
	}
	const otherProject = existing.projectId !== input.wanted.projectId;
	const otherDeployment =
		existing.origin !== null &&
		input.wanted.origin !== null &&
		existing.origin !== input.wanted.origin;
	if (!otherProject && !otherDeployment) {
		return;
	}
	const name = pluginNameFor(input.wanted.projectId);
	const removal =
		input.location === "claude-marketplace"
			? `run \`claude plugin uninstall ${name}@${name} --scope local\` in the folders that use it, then delete ${input.directory}`
			: `delete ${input.directory} and remove ${name} from the Codex marketplace file that lists it`;
	throw new CliFailure(
		`The plugin name ${name} is already taken by project ${existing.projectId}${existing.origin === null ? "" : ` on ${existing.origin}`}, so it was not changed for project ${input.wanted.projectId}${input.wanted.origin === null ? "" : ` on ${input.wanted.origin}`}. Replacing it would repoint the folders already set up for that project. To use this one, remove the other setup first: ${removal}, then run this again.`,
		7,
	);
}
