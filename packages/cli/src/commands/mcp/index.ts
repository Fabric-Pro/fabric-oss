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
import { getClient, getMcpAuthenticatedFetch } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export async function resolveMcpOrganizationId(
	organization: string | undefined,
	client?: Pick<ReturnType<typeof getClient>, "orgs">,
): Promise<string | undefined> {
	if (!organization) {
		return undefined;
	}
	const organizationClient = client ?? getClient();
	let organizations: Awaited<ReturnType<typeof organizationClient.orgs.list>>;
	try {
		organizations = await organizationClient.orgs.list();
	} catch (error) {
		printError((error as Error).message, 1);
	}
	const match = organizations.find(
		(candidate) =>
			candidate.id === organization || candidate.slug === organization,
	);
	if (!match) {
		printError(`Organization not found: ${organization}`, 4);
	}
	return match.id;
}

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

	// -- tools ---------------------------------------------------------------
	mcp.command("tools")
		.description(
			"List MCP tools exposed by the Fabric MCP Gateway (supports stateless MCP mode)",
		)
		.option("--org <slug>", "Organization ID or slug")
		.option("--project <id>", "Project ID to scope the gateway connection")
		.option("--mode <mode>", "Tool list mode: full|discovery", "full")
		.option(
			"--stateless",
			"Send stateless MCP JSON-RPC request (X-Mcp-Stateless: true)",
			true,
		)
		.option(
			"--no-stateless",
			"Use a persistent MCP session instead of stateless mode",
		)
		.option("--format <format>", "Output format: table|json|yaml|plain")
		.option("-q, --quiet", "Print tool names only")
		.action(
			async (opts: {
				org?: string;
				project?: string;
				mode: string;
				stateless?: boolean;
				format?: string;
				quiet?: boolean;
			}) => {
				const auth = getMcpAuthenticatedFetch({
					project: opts.project,
				});
				const organizationId = await resolveMcpOrganizationId(opts.org);
				const base = auth.origin.replace(/\/+$/, "");
				const path = opts.project
					? `/api/mcp-gateway/projects/${encodeURIComponent(opts.project)}`
					: "/api/mcp-gateway";
				const url = new URL(`${base}${path}`);
				if (opts.mode === "discovery") {
					url.searchParams.set("mode", "discovery");
				}
				if (opts.stateless) {
					url.searchParams.set("stateless", "1");
				}

				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "application/json",
				};
				headers.Authorization = auth.authorizationHeader;
				if (organizationId) {
					headers["X-Organization-Id"] = organizationId;
				}
				if (opts.stateless) {
					headers["X-Mcp-Stateless"] = "true";
				}

				let res: Response;
				try {
					res = await auth.fetch(url.toString(), {
						method: "POST",
						headers,
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/list",
							params: {},
						}),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const payload = (await res.json()) as {
					result?: {
						tools?: Array<{
							name: string;
							description?: string;
							_meta?: { ui?: { resourceUri?: string } };
						}>;
					};
					error?: { message?: string };
				};
				if (!res.ok || payload.error) {
					printError(
						payload.error?.message ??
							`MCP Gateway returned HTTP ${res.status}`,
						1,
					);
				}

				const tools = (payload.result?.tools ?? []).map((t) => ({
					name: t.name,
					uiApp: t._meta?.ui?.resourceUri ?? "",
					description: (t.description ?? "").slice(0, 72),
				}));

				if (opts.quiet) {
					for (const t of tools) {
						process.stdout.write(`${t.name}\n`);
					}
					return;
				}

				printOutput(tools, {
					format: opts.format as "table" | "json" | "yaml" | "plain",
					columns: ["name", "uiApp", "description"],
				});
			},
		);

	// -- call ----------------------------------------------------------------
	mcp.command("call <tool>")
		.description(
			"Execute a Fabric MCP tool over Streamable HTTP with optional 24-hour idempotent durable calls",
		)
		.option("--org <slug>", "Organization ID or slug")
		.option("--project <id>", "Project ID to scope the gateway connection")
		.option("--input <json>", "Tool arguments as JSON object", "{}")
		.option(
			"--stateless",
			"Execute without persisting server session (X-Mcp-Stateless: true)",
			true,
		)
		.option(
			"--no-stateless",
			"Use a persistent MCP session instead of stateless mode",
		)
		.option(
			"--durable",
			"Use the Fabric idempotency store (X-Mcp-Durable: true)",
		)
		.option(
			"--idempotency-key <key>",
			"Explicit key for 24-hour durable-call deduplication",
		)
		.option("--format <format>", "Output format: table|json|yaml|plain")
		.action(
			async (
				tool: string,
				opts: {
					org?: string;
					project?: string;
					input: string;
					stateless?: boolean;
					durable?: boolean;
					idempotencyKey?: string;
					format?: string;
				},
			) => {
				let toolArgs: Record<string, unknown> = {};
				try {
					toolArgs = JSON.parse(opts.input);
				} catch {
					printError("--input must be valid JSON", 2);
				}

				const auth = getMcpAuthenticatedFetch({
					project: opts.project,
				});
				const organizationId = await resolveMcpOrganizationId(opts.org);
				const base = auth.origin.replace(/\/+$/, "");
				const path = opts.project
					? `/api/mcp-gateway/projects/${encodeURIComponent(opts.project)}`
					: "/api/mcp-gateway";
				const url = new URL(`${base}${path}`);
				if (opts.stateless) {
					url.searchParams.set("stateless", "1");
				}

				const headers: Record<string, string> = {
					"Content-Type": "application/json",
					Accept: "application/json",
				};
				headers.Authorization = auth.authorizationHeader;
				if (organizationId) {
					headers["X-Organization-Id"] = organizationId;
				}
				if (opts.stateless) {
					headers["X-Mcp-Stateless"] = "true";
				}
				if (opts.durable) {
					headers["X-Mcp-Durable"] = "true";
				}
				if (opts.idempotencyKey) {
					headers["X-Mcp-Idempotency-Key"] = opts.idempotencyKey;
				}

				let res: Response;
				try {
					res = await auth.fetch(url.toString(), {
						method: "POST",
						headers,
						body: JSON.stringify({
							jsonrpc: "2.0",
							id: 1,
							method: "tools/call",
							params: {
								name: tool,
								arguments: toolArgs,
								...(opts.durable || opts.idempotencyKey
									? {
											_meta: {
												durable: Boolean(opts.durable),
												...(opts.idempotencyKey
													? {
															idempotencyKey:
																opts.idempotencyKey,
														}
													: {}),
											},
										}
									: {}),
							},
						}),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const payload = (await res.json()) as {
					result?: unknown;
					error?: { message?: string };
				};
				if (!res.ok || payload.error) {
					printError(
						payload.error?.message ??
							`MCP tool call failed with HTTP ${res.status}`,
						1,
					);
				}

				printOutput(payload.result ?? payload, {
					format: opts.format as "table" | "json" | "yaml" | "plain",
				});
			},
		);

	// -- apps ----------------------------------------------------------------
	mcp.command("apps")
		.description(
			"List or inspect built-in MCP Apps (ui://fabric/*) for native rendering in Fabric Desktop",
		)
		.option("--uri <uri>", "Read a specific ui://fabric/* MCP App resource")
		.option("--format <format>", "Output format: table|json|yaml|plain")
		.option("-q, --quiet", "Print MCP App URIs only")
		.action(
			async (opts: {
				uri?: string;
				format?: string;
				quiet?: boolean;
			}) => {
				const apps = [
					{
						uri: "ui://fabric/project-dashboard",
						name: "Fabric Project Overview & Desktop Launcher",
						mimeType: "text/html;profile=mcp-app",
						linkedTool: "fabric_get_project",
					},
					{
						uri: "ui://fabric/agent-delegation",
						name: "Fabric Agents Delegation & Subscription Credits",
						mimeType: "text/html;profile=mcp-app",
						linkedTool: "fabric_list_features",
					},
					{
						uri: "ui://fabric/workflow-visualizer",
						name: "Fabric Visual Data Prep & Durable Workflow Inspector",
						mimeType: "text/html;profile=mcp-app",
						linkedTool: "fabric_execute_workflow",
					},
					{
						uri: "ui://fabric/genie-insights",
						name: "Fabric Genie Agent & Lakebase Query Explorer",
						mimeType: "text/html;profile=mcp-app",
						linkedTool: "fabric_query_workspace",
					},
					{
						uri: "ui://fabric/visualize",
						name: "Fabric Interactive A2UI Card Composer",
						mimeType: "text/html;profile=mcp-app",
						linkedTool: "fabric_visualize",
					},
				];

				const filtered = opts.uri
					? apps.filter((a) => a.uri === opts.uri)
					: apps;

				if (opts.quiet) {
					for (const a of filtered) {
						process.stdout.write(`${a.uri}\n`);
					}
					return;
				}

				printOutput(filtered, {
					format: opts.format as "table" | "json" | "yaml" | "plain",
					columns: ["uri", "name", "mimeType", "linkedTool"],
				});
			},
		);

	return mcp;
}
