/**
 * fabric context reset --project <id> [dir]
 *
 * Reset the project's Living Memory: delete EVERY file synced into its
 * Context, for everyone, through `POST /api/v1/projects/:projectId/contexts/reset`.
 * The escape hatch for a project whose synced files are in a state a push
 * cannot untangle; afterwards `fabric context push --init <dir>` repopulates
 * it from a local folder.
 *
 * Destructive, so it is confirmed: `--yes` says so up front, and is required
 * when no person is at a terminal to answer; otherwise the person types the
 * project's name (its id, when the name cannot be read). Anything else
 * cancels and sends nothing.
 *
 * With `[dir]`, that folder's `.fabric/context.lock` is replaced by an empty
 * one for the project after the server reset, so its next push sends every
 * file as new. A lock that belongs to another project is refused before
 * anything is sent.
 *
 * Refused by the server while a repository sync is connected (409
 * `REPOSITORY_SYNC_ACTIVE`): disconnect it in the project's Context tab first.
 */
import type { FabricClient } from "@fabricorg/sdk";
import type { Command } from "commander";
import {
	CliFailure,
	describeError,
	outputFormatFor,
} from "../../lib/command-boundary.js";
import { contextCliFailure } from "../../lib/context-sync/failure.js";
import {
	contextLockPath,
	emptyContextLock,
	readContextLock,
	writeContextLock,
} from "../../lib/context-sync/lock.js";
import { askLine, canPrompt } from "../../lib/instructions/prompt.js";
import { fabricCommand } from "../../lib/launcher.js";
import { printOutput } from "../../lib/output.js";

interface ResetOptions {
	project: string;
	org?: string;
	yes?: boolean;
	/** Read through `optsWithGlobals()`, never off this object. */
	format?: string;
}

export interface ContextResetDependencies {
	run: (
		opts: { hook?: boolean },
		body: () => Promise<void>,
		subcommand?: string,
	) => Promise<void>;
	client: (opts: { hook?: boolean }) => FabricClient;
	resolveFolder: (dir: string) => Promise<string>;
	/** Whether a person can answer; the terminal check unless a test sets it. */
	canPrompt?: () => boolean;
	/** Reads the typed confirmation; the terminal unless a test sets it. */
	ask?: (question: string) => Promise<string>;
}

/** The folder's lock may be cleared for this project: none, damaged, or its own. */
async function assertLockClearable(
	root: string,
	projectId: string,
): Promise<void> {
	const lock = await readContextLock(root).catch(() => null);
	if (lock !== null && lock.projectId !== projectId) {
		throw new CliFailure(
			`${contextLockPath(root)} belongs to project ${lock.projectId}, not ${projectId}. Nothing was reset.`,
			7,
		);
	}
}

/** The name the person must type: the project's, or its id when unreadable. */
async function confirmationWord(
	client: FabricClient,
	opts: ResetOptions,
): Promise<{ word: string; label: string }> {
	try {
		const project = await client.projects.get(
			opts.project,
			opts.org ? { org: opts.org } : {},
		);
		if (project.name.trim()) {
			return { word: project.name.trim(), label: "the project name" };
		}
	} catch {
		// A guest of the project may not read it here; the id still confirms.
	}
	return { word: opts.project, label: "the project id" };
}

export function registerContextResetCommand(
	context: Command,
	deps: ContextResetDependencies,
): void {
	context
		.command("reset")
		.description(
			"Delete EVERY file synced into the project's Living Memory, for everyone, after confirmation",
		)
		.argument(
			"[dir]",
			"Also clear this folder's .fabric/context.lock, so its next push sends every file as new",
		)
		.requiredOption("--project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option(
			"--yes",
			"Confirm without a prompt (required when stdin is not a terminal)",
		)
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			dir: string | undefined,
			opts: ResetOptions,
		) {
			const format = outputFormatFor(this);
			await deps.run(
				{},
				() => runReset(dir, opts, format === "json", deps),
				"reset",
			);
		});
}

export async function runReset(
	dir: string | undefined,
	opts: ResetOptions,
	json: boolean,
	deps: ContextResetDependencies,
): Promise<void> {
	const root = dir === undefined ? null : await deps.resolveFolder(dir);
	if (root !== null) {
		await assertLockClearable(root, opts.project);
	}
	const client = deps.client({});

	if (!opts.yes) {
		if (!(deps.canPrompt ?? canPrompt)()) {
			throw new CliFailure(
				"Refusing to reset without --yes: no terminal to confirm at. A reset deletes every file synced into the project's Living Memory, for everyone. Nothing was sent.",
				2,
			);
		}
		const { word, label } = await confirmationWord(client, opts);
		process.stderr.write(
			`This deletes EVERY file synced into the Living Memory of project ${opts.project}, for everyone. It cannot be undone.\n`,
		);
		const typed = await (deps.ask ?? askLine)(
			`Type ${label} (${word}) to confirm: `,
		);
		if (typed !== word) {
			throw new CliFailure("Not confirmed. Nothing was sent.", 2);
		}
	}

	let deleted: number;
	try {
		({ deleted } = await client.contexts.resetSyncedFiles(
			opts.project,
			opts.org ? { org: opts.org } : {},
		));
	} catch (error) {
		throw contextCliFailure(error);
	}

	let lockCleared = false;
	if (root !== null) {
		try {
			await writeContextLock(
				root,
				emptyContextLock(opts.project, new Date()),
			);
			lockCleared = true;
		} catch (error) {
			throw new CliFailure(
				`The project was reset (${deleted} synced ${deleted === 1 ? "file" : "files"} deleted), but ${contextLockPath(root)} could not be cleared: ${describeError(error)}. Push with --init instead.`,
				1,
			);
		}
	}

	if (json) {
		printOutput(
			{
				projectId: opts.project,
				deleted,
				lockPath: root === null ? null : contextLockPath(root),
				lockCleared,
			},
			{ format: "json" },
		);
		return;
	}
	const lines = [
		`Reset the Living Memory of project ${opts.project}: ${deleted} synced ${deleted === 1 ? "file" : "files"} deleted.`,
	];
	if (root !== null) {
		lines.push(
			`Cleared ${contextLockPath(root)}. Repopulate with: ${fabricCommand(`context push ${dir} --project ${opts.project}`)}`,
		);
	} else {
		lines.push(
			`Repopulate with: ${fabricCommand(`context push --init <dir> --project ${opts.project}`)}`,
		);
	}
	process.stdout.write(`${lines.join("\n")}\n`);
}
