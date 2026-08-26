/**
 * fabric workspaces
 *
 *   fabric workspaces list          List workspaces
 *   fabric workspaces show <id>     Show workspace details
 */

import type { FabricWorkspace, FabricWorkspaceDetail } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildWorkspacesCommand(): Command {
	const workspaces = new Command("workspaces").description(
		"Manage workspaces",
	);

	// -- list ----------------------------------------------------------------
	workspaces
		.command("list")
		.description("List workspaces")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--search <query>", "Search by name")
		.option("--status <status>", "Filter: ACTIVE|ARCHIVED")
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
				search?: string;
				status?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricWorkspace[];
				try {
					list = await client.workspaces.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
						search: opts.search,
						status: opts.status as
							| "ACTIVE"
							| "ARCHIVED"
							| undefined,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const w of list) {
						process.stdout.write(`${w.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"name",
						"type",
						"status",
						"documentCount",
						"updatedAt",
					],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	workspaces
		.command("show <id>")
		.description("Show workspace details")
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
				let ws: FabricWorkspaceDetail;
				try {
					ws = await client.workspaces.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(ws, { format: fmt });
					return;
				}

				printRecord({
					ID: ws.id,
					Name: ws.name,
					Type: ws.type,
					Status: ws.status,
					Description: ws.description ?? "(none)",
					Documents: String(ws.documentCount),
					Conversations: String(ws.conversationCount),
					Updated: ws.updatedAt.slice(0, 10),
				});
			},
		);

	return workspaces;
}
