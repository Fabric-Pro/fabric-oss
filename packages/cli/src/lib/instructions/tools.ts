/**
 * Which coding tools `init` should write a hook for when the person did not
 * say.
 *
 * A tool counts as present when any of three things says so: its directory in
 * the checkout (`.claude`, `.codex`), its directory in the home folder, or its
 * command on PATH (found by `stat`, never run). Every present tool gets a hook
 * in the one run; none present means Claude Code, with a hint, because a hook
 * that is never read costs nothing and the person can pass `--tool` for the
 * other.
 */
import { stat } from "node:fs/promises";
import path from "node:path";
import type { InstructionsHookTool } from "./hook.js";
import { isOnPath, type PathLookupEnvironment } from "./path-lookup.js";

interface ToolFacts {
	tool: InstructionsHookTool;
	directory: string;
	command: string;
}

/** In the order hooks are written and named. */
const TOOLS: readonly ToolFacts[] = [
	{ tool: "claude-code", directory: ".claude", command: "claude" },
	{ tool: "codex", directory: ".codex", command: "codex" },
];

export interface DetectedTools {
	tools: InstructionsHookTool[];
	/** False when nothing was found and Claude Code is only the fallback. */
	detected: boolean;
}

async function isDirectory(target: string): Promise<boolean> {
	return (await stat(target).catch(() => null))?.isDirectory() ?? false;
}

export async function detectTools(input: {
	/** The checkout the hook files go into. */
	root: string;
	/** The home folder, or `null` when there is none to look in. */
	home: string | null;
	lookup: PathLookupEnvironment;
}): Promise<DetectedTools> {
	const present: InstructionsHookTool[] = [];
	for (const facts of TOOLS) {
		const found =
			(await isDirectory(path.join(input.root, facts.directory))) ||
			(input.home !== null &&
				(await isDirectory(path.join(input.home, facts.directory)))) ||
			(await isOnPath(facts.command, input.lookup));
		if (found) {
			present.push(facts.tool);
		}
	}
	return present.length > 0
		? { tools: present, detected: true }
		: { tools: ["claude-code"], detected: false };
}
