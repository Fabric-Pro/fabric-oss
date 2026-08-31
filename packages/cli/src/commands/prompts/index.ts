/**
 * fabric prompts
 *
 *   fabric prompts list        List prompt templates
 *   fabric prompts get <id>    Get a prompt (prints latest version content)
 */

import type { FabricPrompt } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import {
	printError,
	printOutput,
	printRecord,
	printSuccess,
} from "../../lib/output.js";

export function buildPromptsCommand(): Command {
	const prompts = new Command("prompts").description(
		"Manage prompt templates",
	);

	// -- list ----------------------------------------------------------------
	prompts
		.command("list")
		.description("List prompt templates")
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
		.option("-q, --quiet", "Print IDs only")
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
				let list: FabricPrompt[];
				try {
					list = await client.prompts.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						search: opts.search,
						category: opts.category,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const p of list) {
						process.stdout.write(`${p.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"key",
						"name",
						"scope",
						"category",
						"updatedAt",
					],
				});
			},
		);

	// -- get -----------------------------------------------------------------
	prompts
		.command("get <id>")
		.description("Get a prompt (prints latest version content by default)")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option(
			"--format <format>",
			"Output format: raw|table|json|yaml (default: raw)",
			"raw",
		)
		.action(
			async (
				id: string,
				opts: { org?: string; personal?: boolean; format: string },
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let prompt: FabricPrompt;
				try {
					prompt = await client.prompts.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "raw" | "table" | "json" | "yaml";

				if (fmt === "json") {
					printOutput(prompt, { format: "json" });
					return;
				}
				if (fmt === "yaml") {
					printOutput(prompt, { format: "yaml" });
					return;
				}

				const content = prompt.versions?.[0]?.content ?? "(no content)";

				if (fmt === "raw") {
					process.stdout.write(`${content}\n`);
					return;
				}

				// table: metadata + content block
				printRecord({
					ID: prompt.id,
					Key: prompt.key,
					Name: prompt.name,
					Scope: prompt.scope,
					Category: prompt.category ?? "(none)",
					Tags: (prompt.tags ?? []).join(", ") || "(none)",
				});
				process.stdout.write(`\n--- Content ---\n${content}\n`);
			},
		);

	// -- create --------------------------------------------------------------
	prompts
		.command("create")
		.description("Create a new prompt")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.requiredOption("--key <key>", "Prompt key (unique identifier)")
		.requiredOption("--name <name>", "Prompt name")
		.option("-d, --description <text>", "Prompt description")
		.option("--content <text>", "Initial prompt content")
		.option("--category <cat>", "Category")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (opts: {
				org?: string;
				personal?: boolean;
				key: string;
				name: string;
				description?: string;
				content?: string;
				category?: string;
				format: string;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let prompt: FabricPrompt;
				try {
					prompt = await client.prompts.create({
						key: opts.key,
						name: opts.name,
						description: opts.description,
						content: opts.content,
						category: opts.category,
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(prompt, { format: fmt });
					return;
				}

				printSuccess(`Prompt "${prompt.name}" created`);
				printRecord({
					ID: prompt.id,
					Key: prompt.key,
					Name: prompt.name,
					Scope: prompt.scope,
					Created: prompt.createdAt.slice(0, 10),
				});
			},
		);

	// -- update --------------------------------------------------------------
	prompts
		.command("update <id>")
		.description("Update a prompt")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--name <name>", "New name")
		.option("-d, --description <text>", "New description")
		.option("--category <cat>", "Category")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: {
					org?: string;
					personal?: boolean;
					name?: string;
					description?: string;
					category?: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let prompt: FabricPrompt;
				try {
					prompt = await client.prompts.update(id, {
						name: opts.name,
						description: opts.description,
						category: opts.category,
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(prompt, { format: fmt });
					return;
				}

				printRecord({
					ID: prompt.id,
					Key: prompt.key,
					Name: prompt.name,
					Scope: prompt.scope,
					Updated: prompt.updatedAt.slice(0, 10),
				});
			},
		);

	return prompts;
}
