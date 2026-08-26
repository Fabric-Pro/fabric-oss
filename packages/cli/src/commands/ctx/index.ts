/**
 * fabric ctx
 *
 *   fabric ctx current        Show active context
 *   fabric ctx use personal   Set personal as default
 *   fabric ctx use org <slug> Set an org as default
 */

import { Command } from "commander";
import { getDefaultContext, saveDefaultContext } from "../../lib/config.js";
import { printSuccess, printWarning } from "../../lib/output.js";

export function buildCtxCommand(): Command {
	const ctx = new Command("ctx").description(
		"Manage tenant context (personal vs org)",
	);

	// -- current ------------------------------------------------------------
	ctx.command("current")
		.description("Show the active default context")
		.action(() => {
			const stored = getDefaultContext();
			if (!stored) {
				printWarning(
					"No default context set. Use --personal or --org <slug> on each command, or run:\n  fabric ctx use personal\n  fabric ctx use org <slug>",
				);
				return;
			}
			if (stored.type === "personal") {
				process.stdout.write("Context: personal\n");
			} else {
				process.stdout.write(`Context: org:${stored.slug}\n`);
			}
		});

	// -- use ----------------------------------------------------------------
	const use = new Command("use").description(
		"Set the default context for commands",
	);

	use.command("personal")
		.description("Use personal context by default")
		.action(() => {
			saveDefaultContext({ type: "personal" });
			printSuccess("Default context set to: personal");
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
