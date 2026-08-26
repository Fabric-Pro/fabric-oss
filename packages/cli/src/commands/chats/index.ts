/**
 * fabric chats
 *
 *   fabric chats list          List AI chat sessions
 *   fabric chats show <id>     Show chat details
 */

import type { FabricChat } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildChatsCommand(): Command {
	const chats = new Command("chats").description("Manage AI chat sessions");

	chats
		.command("list")
		.description("List AI chat sessions")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--limit <n>", "Max results (default 20)", "20")
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
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricChat[];
				try {
					list = await client.chats.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const c of list) {
						process.stdout.write(`${c.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: ["id", "title", "updatedAt"],
				});
			},
		);

	chats
		.command("show <id>")
		.description("Show chat details")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: { org?: string; personal?: boolean; format: string },
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let chat: FabricChat;
				try {
					chat = await client.chats.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(chat, { format: fmt });
					return;
				}

				printRecord({
					ID: chat.id,
					Title: chat.title ?? "(untitled)",
					Updated: chat.updatedAt.slice(0, 16).replace("T", " "),
					Created: chat.createdAt.slice(0, 10),
				});
			},
		);

	return chats;
}
