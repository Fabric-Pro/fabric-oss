/**
 * fabric ctx
 *
 *   fabric ctx current        Show active context
 *   fabric ctx use org <slug> Set an org as default
 *
 * `use personal` is retired (Fizzy #1875, PO-9). It is still REGISTERED rather
 * than deleted, so someone who types it — or has it in a script — is told what
 * replaced it instead of meeting "unknown command". A config written by an
 * earlier version can still hold a personal default; `current` reports it as
 * needing replacing rather than printing it as if it still worked.
 */

import { Command } from "commander";
import { getDefaultContext, saveDefaultContext } from "../../lib/config.js";
import { printError, printSuccess, printWarning } from "../../lib/output.js";

export function buildCtxCommand(): Command {
	const ctx = new Command("ctx").description(
		"Manage the organization commands run in",
	);

	// -- current ------------------------------------------------------------
	ctx.command("current")
		.description("Show the active default context")
		.action(() => {
			const stored = getDefaultContext();
			if (!stored) {
				printWarning(
					"No default context set. Use --org <slug> on each command, or run:\n  fabric ctx use org <slug>",
				);
				return;
			}
			if (stored.type === "personal") {
				// Reported, not hidden: it is set, the user can see it is set,
				// and saying "none" would send them looking for a setting that
				// is right there.
				printWarning(
					"Context: personal — retired, and no command will accept it.\nReplace it with:\n  fabric ctx use org <slug>",
				);
				return;
			}
			process.stdout.write(`Context: org:${stored.slug}\n`);
		});

	// -- use ----------------------------------------------------------------
	const use = new Command("use").description(
		"Set the default organization for commands",
	);

	use.command("personal")
		.description("Retired — context is organization-only")
		.action(() => {
			printError(
				"Personal context no longer exists — every command runs inside an organization.\nSet one with:\n  fabric ctx use org <slug>",
				2,
			);
		});

	use.command("org <slug>")
		.description("Use an org context by default")
		.action((slug: string) => {
			saveDefaultContext({ type: "org", slug });
			printSuccess(`Default context set to: org:${slug}`);
		});

	ctx.addCommand(use);

	return ctx;
}
