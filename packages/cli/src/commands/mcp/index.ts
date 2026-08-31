/**
 * fabric mcp
 *
 *   fabric mcp servers              List accessible MCP servers
 *   fabric mcp configs              List your MCP configurations
 *   fabric mcp configs show <id>    Show a specific MCP configuration
 */

import type {
	FabricMcpConfig,
	FabricMcpConfigDetail,
	FabricMcpServer,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildMcpCommand(): Command {
	const mcp = new Command("mcp").description(
		"Manage MCP servers and configurations",
	);

	// -- servers -------------------------------------------------------------
	mcp.command("servers")
		.description("List accessible MCP servers (system + custom)")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.option("-q, --quiet", "Print server keys only")
		.action(
			async (opts: {
				org?: string;
				personal?: boolean;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricMcpServer[];
				try {
					list = await client.mcp.listServers({
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const s of list) {
						process.stdout.write(`${s.key}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"key",
						"name",
						"transport",
						"category",
						"isSystemProvided",
					],
				});
			},
		);

	// -- configs -------------------------------------------------------------
	const configs = new Command("configs").description(
		"Manage MCP configurations",
	);

	configs
		.command("list", { isDefault: true })
		.description("List your MCP configurations")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
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
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricMcpConfig[];
				try {
					list = await client.mcp.listConfigs({
						org: ctx?.type === "org" ? ctx.slug : undefined,
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
					columns: [
						"id",
						"serverName",
						"displayName",
						"authType",
						"enabled",
						"status",
					],
				});
			},
		);

	configs
		.command("show <id>")
		.description("Show a specific MCP configuration")
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
				let config: FabricMcpConfigDetail;
				try {
					config = await client.mcp.getConfig(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(config, { format: fmt });
					return;
				}

				printRecord({
					ID: config.id,
					Server: config.serverName ?? config.mcpServerId,
					"Server Key": config.serverKey ?? "(none)",
					"Display Name": config.displayName ?? "(none)",
					"Base URL": config.baseUrl ?? "(none)",
					Transport: config.transport ?? "(default)",
					"Auth Type": config.authType,
					Enabled: config.enabled ? "yes" : "no",
					Status: config.status,
					"Last Health Check":
						config.lastHealthCheckAt?.slice(0, 19) ?? "(never)",
					Created: config.createdAt.slice(0, 10),
				});
			},
		);

	configs
		.command("delete <id>")
		.description("Delete an MCP configuration")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("-y, --yes", "Skip confirmation prompt")
		.action(
			async (
				id: string,
				opts: { org?: string; personal?: boolean; yes?: boolean },
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();

				if (!opts.yes) {
					process.stderr.write(
						`Delete MCP config ${id}? This cannot be undone. Pass --yes to confirm.\n`,
					);
					process.exit(2);
				}

				try {
					await client.mcp.deleteConfig(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				process.stdout.write(`MCP config ${id} deleted.\n`);
			},
		);

	mcp.addCommand(configs);

	// -- serve ---------------------------------------------------------------
	mcp.command("serve")
		.description(
			"Run a stdio MCP server exposing this workspace's whole integration catalog. " +
				"Point Claude Desktop, Cursor, or any MCP client at it.",
		)
		.action(async () => {
			// Lazy import — avoids loading the MCP SDK when running other commands
			// and keeps the CLI binary cold-start fast.
			const { runStdio } = await import("@fabricorg/sdk-mcp/stdio");
			await runStdio();
		});

	return mcp;
}
