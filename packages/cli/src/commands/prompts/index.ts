import { readFile } from "node:fs/promises";
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

	prompts
		.command("response <id>")
		.description("Read or update a prompt's expected response contract")
		.option("--org <slug>", "Organization context")
		.option(
			"--file <path>",
			"Save a response contract JSON file as a new version; omit to read",
		)
		.action(async (id: string, opts: { org?: string; file?: string }) => {
			try {
				const ctx = resolveContext(false, opts.org, false);
				const client = getClient();
				const options = {
					org: ctx?.type === "org" ? ctx.slug : undefined,
				};
				let result: Awaited<
					ReturnType<typeof client.prompts.getResponseContract>
				>;
				if (opts.file) {
					const raw = await readFile(opts.file, "utf8");
					if (Buffer.byteLength(raw) > 512 * 1024) {
						throw new Error(
							"Response contract request exceeds 512 KiB.",
						);
					}
					result = await client.prompts.setResponseContract(
						id,
						JSON.parse(raw),
						options,
					);
				} else {
					result = await client.prompts.getResponseContract(
						id,
						options,
					);
				}
				printOutput(result, { format: "json" });
			} catch (error: unknown) {
				printError((error as Error).message, 1);
			}
		});

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

	for (const mode of ["assist", "preview"] as const) {
		prompts
			.command(`${mode} <request-file>`)
			.description(
				mode === "assist"
					? "Propose prompt changes for review; does not save"
					: "Try supplied prompt text and inputs with your configured AI provider; does not save",
			)
			.option("--org <slug>", "Organization context")
			.action(async (file: string, opts: { org?: string }) => {
				try {
					const bytes = await readFile(file);
					if (bytes.byteLength > 512 * 1024) {
						throw new Error("The prompt request exceeds 512 KiB.");
					}
					const ctx = resolveContext(false, opts.org, false);
					const input = JSON.parse(bytes.toString("utf8"));
					const client = getClient();
					const options = {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					};
					const result =
						mode === "assist"
							? await client.prompts.assist(input, options)
							: await client.prompts.preview(input, options);
					printOutput(result, { format: "json" });
					if (
						"validation" in result &&
						result.validation.status === "failed"
					) {
						process.exitCode = 1;
					}
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "The prompt request could not finish.",
						1,
					);
				}
			});
	}

	return prompts;
}
