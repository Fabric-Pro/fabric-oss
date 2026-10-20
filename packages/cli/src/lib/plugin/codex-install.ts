/**
 * Codex installs a COPY of a local plugin into its own cache, so a folder that
 * is rendered again is not what Codex runs until `codex plugin add
 * <plugin>@<marketplace>` is run again. That command is idempotent and asks
 * nothing, so `init` runs it once to install the plugin and the session hook
 * runs it whenever Codex does not hold the rendered version yet.
 */

import { stat } from "node:fs/promises";
import path from "node:path";
import type { AgentRunner } from "../instructions/agent-run.js";
import { pasteableLine } from "../shell-words.js";
import { pluginNameFor } from "./layout.js";
import { codexMarketplaceListing } from "./register.js";

const INSTALL_TIMEOUT_MS = 120_000;

/** A hook must not hold a session start for long. */
const REFRESH_TIMEOUT_MS = 25_000;

export type CodexPluginInstall =
	| { kind: "installed" }
	/** Not installed; `line` is what to run, or `null` when it cannot be written as a command. */
	| { kind: "manual"; line: string | null };

export function codexPluginReference(
	projectId: string,
	marketplaceName: string,
): string {
	return `${pluginNameFor(projectId)}@${marketplaceName}`;
}

export async function installCodexPlugin(input: {
	run: AgentRunner;
	projectId: string;
	marketplaceName: string;
	cwd: string;
}): Promise<CodexPluginInstall> {
	const args = [
		"plugin",
		"add",
		codexPluginReference(input.projectId, input.marketplaceName),
	];
	const result = await input.run("codex", args, {
		cwd: input.cwd,
		timeoutMs: INSTALL_TIMEOUT_MS,
	});
	return result.kind === "exited" && result.code === 0
		? { kind: "installed" }
		: { kind: "manual", line: pasteableLine(["codex", ...args]) };
}

/**
 * Bring Codex's installed copy up to date with the rendered version. Codex
 * keeps each installed version under `<codex home>/plugins/cache/<marketplace>/
 * <plugin>/<version>`, so the copy is current exactly when that folder exists;
 * checking it rather than whether this render was new means a refresh that
 * failed once is tried again at the next session start. Nothing is reported
 * and nothing throws: a plugin that is not listed, a missing `codex`, or a slow
 * one leaves the copy as it was.
 */
export async function refreshCodexInstall(input: {
	run: AgentRunner;
	home: string;
	/** `CODEX_HOME`, or `~/.codex`. */
	codexHome: string;
	projectId: string;
	/** The rendered plugin's version (`0.0.0-<pin>`). */
	version: string;
	cwd: string;
}): Promise<void> {
	try {
		const marketplaceName = await codexMarketplaceListing(input);
		if (marketplaceName === null) {
			return;
		}
		const installed = path.join(
			input.codexHome,
			"plugins",
			"cache",
			marketplaceName,
			pluginNameFor(input.projectId),
			input.version,
		);
		if (
			await stat(installed).then(
				(found) => found.isDirectory(),
				() => false,
			)
		) {
			return;
		}
		await input.run(
			"codex",
			[
				"plugin",
				"add",
				codexPluginReference(input.projectId, marketplaceName),
			],
			{ cwd: input.cwd, timeoutMs: REFRESH_TIMEOUT_MS },
		);
	} catch {
		// A refresh is housekeeping; the next session start tries again.
	}
}
