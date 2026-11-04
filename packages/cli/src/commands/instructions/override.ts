/**
 * fabric instructions override add|remove|list [<path>] [--dest <dir>]
 *
 * A developer's local overrides in an instructions checkout
 * (`lib/instructions/local-overrides.ts`): paths `sync` never writes or
 * deletes and `push` never sends. A path, or a gitignore-style pattern such
 * as `notes/**`. Nothing here talks to a deployment: the list is this
 * machine's alone, and is kept out of commits through `.git/info/exclude`.
 */
import path from "node:path";
import type { Command } from "commander";
import {
	CliFailure,
	describeError,
	type OutputFormat,
	outputFormatFor,
} from "../../lib/command-boundary.js";
import * as git from "../../lib/instructions/git.js";
import { excludeLocalFiles } from "../../lib/instructions/git-exclude.js";
import {
	addOverride,
	LOCAL_OVERRIDES_PATH,
	type LocalOverrides,
	readLocalOverrides,
	removeOverride,
	writeLocalOverrides,
} from "../../lib/instructions/local-overrides.js";
import { resolveExistingRoot } from "../../lib/instructions/safe-write.js";
import { printOutput } from "../../lib/output.js";

interface OverrideOptions {
	dest?: string;
	/**
	 * Declared for `--help` and read through `outputFormatFor`: Commander
	 * stores a flag both a parent and a subcommand declare on the parent.
	 */
	format?: string;
}

const GIT_DEADLINE_MS = 8_000;

function rootOf(opts: OverrideOptions): Promise<string> {
	return resolveExistingRoot(path.resolve(opts.dest ?? process.cwd()));
}

function report(
	overrides: LocalOverrides,
	format: OutputFormat,
	headline: string,
): void {
	if (format === "json") {
		printOutput(
			{ paths: overrides.paths, patterns: overrides.patterns },
			{ format: "json" },
		);
		return;
	}
	process.stdout.write(`${headline}\n`);
	for (const entry of [...overrides.paths, ...overrides.patterns].sort()) {
		process.stdout.write(`  ${entry}\n`);
	}
}

/** Keep the list out of commits; a checkout that is not in git has nothing to keep it out of. */
async function excludeOverridesFile(root: string): Promise<void> {
	const tree = await git.findWorkTree(root, Date.now() + GIT_DEADLINE_MS);
	if (tree.kind !== "ok") {
		return;
	}
	const excluded = await excludeLocalFiles({
		toplevel: tree.value.toplevel,
		directory: root,
		files: [LOCAL_OVERRIDES_PATH],
		deadline: Date.now() + GIT_DEADLINE_MS,
	});
	if (excluded.kind === "failed") {
		process.stderr.write(
			`Could not keep ${LOCAL_OVERRIDES_PATH} out of commits. Add it to .git/info/exclude yourself.\n`,
		);
	}
}

async function runAction(action: () => Promise<void>): Promise<void> {
	try {
		await action();
	} catch (error) {
		process.stderr.write(
			`${error instanceof CliFailure ? error.message : describeError(error)}\n`,
		);
		process.exit(error instanceof CliFailure ? error.exitCode : 1);
	}
}

export function registerOverrideCommand(instructions: Command): void {
	const override = instructions
		.command("override")
		.description(
			"Keep files of this checkout as your own: sync never overwrites or deletes them, and push never sends them",
		);

	override
		.command("add <path>")
		.description(
			"Keep a file (or a pattern such as notes/**) as a local override",
		)
		.option("--dest <dir>", "The instructions checkout (default: cwd)")
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			entry: string,
			opts: OverrideOptions,
		) {
			const format = outputFormatFor(this);
			await runAction(async () => {
				const root = await rootOf(opts);
				let added: ReturnType<typeof addOverride>;
				try {
					added = addOverride(await readLocalOverrides(root), entry);
				} catch (error) {
					throw new CliFailure(describeError(error), 2);
				}
				if (added.changed) {
					await writeLocalOverrides(root, added.overrides);
					await excludeOverridesFile(root);
				}
				report(
					added.overrides,
					format,
					added.changed
						? `${entry} is now a local override: sync leaves it alone and push never sends it.`
						: `${entry} was already a local override.`,
				);
			});
		});

	override
		.command("remove <path>")
		.description(
			"Stop keeping a file as a local override; the next sync treats it like any other",
		)
		.option("--dest <dir>", "The instructions checkout (default: cwd)")
		.option("--format <format>", "Output format: text|json")
		.action(async function (
			this: Command,
			entry: string,
			opts: OverrideOptions,
		) {
			const format = outputFormatFor(this);
			await runAction(async () => {
				const root = await rootOf(opts);
				const removed = removeOverride(
					await readLocalOverrides(root),
					entry,
				);
				if (removed.changed) {
					await writeLocalOverrides(root, removed.overrides);
				}
				report(
					removed.overrides,
					format,
					removed.changed
						? `${entry} is no longer a local override.`
						: `${entry} was not a local override.`,
				);
			});
		});

	override
		.command("list")
		.description("List this checkout's local overrides")
		.option("--dest <dir>", "The instructions checkout (default: cwd)")
		.option("--format <format>", "Output format: text|json")
		.action(async function (this: Command, opts: OverrideOptions) {
			const format = outputFormatFor(this);
			await runAction(async () => {
				const overrides = await readLocalOverrides(await rootOf(opts));
				const count =
					overrides.paths.length + overrides.patterns.length;
				report(
					overrides,
					format,
					count === 0
						? "No local overrides in this checkout."
						: `${count} local override(s):`,
				);
			});
		});
}
