/**
 * fabric skills
 *
 *   fabric skills list        Browse skill definitions
 *   fabric skills show <id>   Show skill details
 */

import type { FabricSkill } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildSkillsCommand(): Command {
	const skills = new Command("skills").description(
		"Browse skill definitions",
	);

	// -- list ----------------------------------------------------------------
	skills
		.command("list")
		.description("List skills")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--search <query>", "Search by name")
		.option("--category <cat>", "Filter by category")
		.option("--limit <n>", "Max results", "50")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.option("-q, --quiet", "Print slugs only")
		.action(
			async (opts: {
				org?: string;
				personal?: boolean;
				search?: string;
				category?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricSkill[];
				try {
					list = await client.skills.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						search: opts.search,
						category: opts.category,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const s of list) {
						process.stdout.write(`${s.slug}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: ["slug", "name", "category", "scope", "useCount"],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	skills
		.command("show <id>")
		.description("Show skill details (accepts ID or slug)")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(async (id: string, opts: { format: string }) => {
			const client = getClient();
			let skill: FabricSkill;
			try {
				skill = await client.skills.get(id);
			} catch (err: unknown) {
				printError((err as Error).message, 1);
			}

			const fmt = opts.format as "table" | "json" | "yaml";
			if (fmt === "json" || fmt === "yaml") {
				printOutput(skill, { format: fmt });
				return;
			}

			printRecord({
				ID: skill.id,
				Slug: skill.slug,
				Name: skill.name,
				Category: skill.category ?? "(none)",
				Scope: skill.scope,
				Tags: skill.tags.join(", ") || "(none)",
				Published: skill.isPublished ? "yes" : "no",
				"Use Count": String(skill.useCount),
				Version: String(skill.version),
				Description: skill.description,
				Updated: skill.updatedAt.slice(0, 10),
			});
		});

	return skills;
}
