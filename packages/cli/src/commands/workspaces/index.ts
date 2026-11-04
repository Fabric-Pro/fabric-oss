/**
 * fabric workspaces
 *
 *   fabric workspaces list          List workspaces
 *   fabric workspaces show <id>     Show workspace details
 */

import type { FabricWorkspace, FabricWorkspaceDetail } from "@fabricorg/sdk";
import { Command, InvalidArgumentError } from "commander";
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
		.option("--personal", "Retired — context is organization-only")
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
		.option("--personal", "Retired — context is organization-only")
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

	workspaces
		.command("documents <workspaceId>")
		.description(
			"List document IDs and extraction status (no AI provider required)",
		)
		.option("--org <slug>", "Organization context")
		.option(
			"--offset <n>",
			"Document offset",
			boundedInteger(0, 2147483646),
			0,
		)
		.option(
			"--limit <n>",
			"Maximum documents (1..100)",
			boundedInteger(1, 100),
			20,
		)
		.action(async (workspaceId, opts) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				const page = await getClient().workspaces.listDocuments(
					workspaceId,
					{
						org: ctx?.type === "org" ? ctx.slug : undefined,
						offset: opts.offset,
						limit: opts.limit,
					},
				);
				printOutput(page, { format: "json" });
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	workspaces
		.command("read-document <workspaceId> <documentId>")
		.description(
			"Read one bounded extracted-text page with revision and continuation metadata",
		)
		.option("--org <slug>", "Organization context")
		.option(
			"--offset <n>",
			"Unicode code point offset",
			boundedInteger(0, 2147483646),
			0,
		)
		.option(
			"--limit <n>",
			"Maximum Unicode code points (1..20000)",
			boundedInteger(1, 20000),
			12000,
		)
		.option(
			"--expected-revision <sha256>",
			"First-page revision; required when offset > 0",
		)
		.action(async (workspaceId, documentId, opts) => {
			const ctx = resolveContext(false, opts.org, false);
			if (opts.offset > 0 && !opts.expectedRevision)
				printError(
					"Continuation pages require --expected-revision from offset 0.",
					1,
				);
			if (
				opts.expectedRevision &&
				!/^[a-f0-9]{64}$/.test(opts.expectedRevision)
			)
				printError(
					"Expected revision must be a lowercase SHA-256 hash.",
					1,
				);
			try {
				const page = await getClient().workspaces.readDocument(
					workspaceId,
					documentId,
					{
						org: ctx?.type === "org" ? ctx.slug : undefined,
						offset: opts.offset,
						limit: opts.limit,
						expectedRevision: opts.expectedRevision,
					},
				);
				printOutput(page, { format: "json" });
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});

	return workspaces;
}

function boundedInteger(min: number, max: number) {
	return (value: string) => {
		if (
			!/^\d+$/.test(value) ||
			!Number.isSafeInteger(Number(value)) ||
			Number(value) < min ||
			Number(value) > max
		)
			throw new InvalidArgumentError(
				`Expected an integer between ${min} and ${max}.`,
			);
		return Number(value);
	};
}
