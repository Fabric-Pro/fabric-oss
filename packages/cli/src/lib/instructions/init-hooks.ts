/**
 * Writing `init`'s hooks: one SessionStart hook per coding tool, in one run.
 *
 * `init` describes the DESIRED state. Each run replaces its own SessionStart
 * entry for the project, and installs or removes the lesson-capture Stop hook
 * to match `--lessons`, so running it again never stacks a second hook and
 * never leaves a stale one. The Stop hook exists for Claude Code only; for
 * any other tool the removal is a no-op that writes nothing.
 */
import {
	type InstructionsHookTool,
	mergeCommandHook,
	mergeSessionStartHook,
	removeCommandHook,
} from "./hook.js";

export interface InstalledHook {
	tool: InstructionsHookTool;
	settingsPath: string;
	createdFile: boolean;
	replacedCount: number;
	/** What happened to the Stop hook for lesson capture, if anything. */
	lessons: "added" | "removed" | null;
}

export async function installHooks(input: {
	/** An already-canonical destination from `resolveDestinationRoot`. */
	root: string;
	projectId: string;
	tools: readonly InstructionsHookTool[];
	/** The SessionStart command, from `buildHookCommand`. */
	command: string;
	/** The Stop command, from `buildLessonPromptCommand`. */
	lessonsCommand: string;
	lessons: boolean;
}): Promise<InstalledHook[]> {
	const installed: InstalledHook[] = [];
	for (const tool of input.tools) {
		const merged = await mergeSessionStartHook({
			root: input.root,
			projectId: input.projectId,
			command: input.command,
			tool,
		});

		// After the SessionStart write, so a failure here never leaves that
		// one half-done; and always attempted, because removal is a no-op
		// that writes nothing when there is nothing to remove.
		let lessons: InstalledHook["lessons"] = null;
		if (input.lessons && tool === "claude-code") {
			await mergeCommandHook({
				root: input.root,
				projectId: input.projectId,
				command: input.lessonsCommand,
				tool,
				event: "Stop",
			});
			lessons = "added";
		} else {
			const removed = await removeCommandHook({
				root: input.root,
				projectId: input.projectId,
				subcommand: "lesson-prompt",
				tool,
				event: "Stop",
			});
			lessons = removed.changed ? "removed" : null;
		}

		installed.push({
			tool,
			settingsPath: merged.settingsPath,
			createdFile: merged.createdFile,
			replacedCount: merged.replacedCount,
			lessons,
		});
	}
	return installed;
}
