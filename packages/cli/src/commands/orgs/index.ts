/**
 * fabric orgs
 *
 *   fabric orgs list           List orgs you belong to
 *   fabric orgs show <slug>    Show org details
 */

import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildOrgsCommand(): Command {
	const orgs = new Command("orgs").description("Manage organizations");

	// -- list ----------------------------------------------------------------
	orgs.command("list")
		.description("List organizations you belong to")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.option("-q, --quiet", "Print slugs only")
		.action(async (opts: { format: string; quiet?: boolean }) => {
			const client = getClient();
			let list: Awaited<ReturnType<typeof client.orgs.list>>;
			try {
				list = await client.orgs.list();
			} catch (err: unknown) {
				printError((err as Error).message, 1);
			}

			if (opts.quiet) {
				for (const org of list) {
					process.stdout.write(`${org.slug}\n`);
				}
				return;
			}

			printOutput(list, {
				format: opts.format as "table" | "json" | "yaml" | "csv",
				columns: ["name", "slug", "role", "joinedAt"],
			});
		});

	// -- show ----------------------------------------------------------------
	orgs.command("show <slug>")
		.description("Show details for an organization")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(async (slug: string, opts: { format: string }) => {
			const client = getClient();
			let list: Awaited<ReturnType<typeof client.orgs.list>>;
			try {
				list = await client.orgs.list();
			} catch (err: unknown) {
				printError((err as Error).message, 1);
			}

			const org = list.find(
				(o: { slug: string; id: string }) =>
					o.slug === slug || o.id === slug,
			);
			if (!org) {
				printError(`Organization not found: ${slug}`, 4);
			}

			const fmt = opts.format as "table" | "json" | "yaml";
			if (fmt === "json" || fmt === "yaml") {
				printOutput(org, { format: fmt });
				return;
			}

			printRecord({
				Name: org.name,
				Slug: org.slug,
				Role: org.role,
				"Joined at": String(org.joinedAt).slice(0, 10),
				Logo: org.logo ?? "(none)",
			});
		});

	return orgs;
}
