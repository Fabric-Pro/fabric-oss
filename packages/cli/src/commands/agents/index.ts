/**
 * fabric agents
 *
 *   fabric agents list           List agents
 *   fabric agents show <id>      Show agent details
 */

import type { FabricAgent } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildAgentsCommand(): Command {
	const agents = new Command("agents").description("Manage agents");

	// -- list ----------------------------------------------------------------
	agents
		.command("list")
		.description("List agents")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--status <status>", "Filter: ACTIVE|INACTIVE|DEPRECATED")
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
				status?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricAgent[];
				try {
					list = await client.agents.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
						status: opts.status as
							| FabricAgent["status"]
							| undefined,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const a of list) {
						process.stdout.write(`${a.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"name",
						"displayName",
						"framework",
						"status",
						"createdAt",
					],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	agents
		.command("show <id>")
		.description("Show agent details")
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
				let agent: FabricAgent;
				try {
					agent = await client.agents.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(agent, { format: fmt });
					return;
				}

				printRecord({
					ID: agent.id,
					"Agent ID": agent.agentId,
					Name: agent.name,
					"Display name": agent.displayName,
					Framework: agent.framework,
					Status: agent.status,
					"Deployment URL": agent.deploymentUrl ?? "(none)",
					Created: agent.createdAt.slice(0, 10),
				});
			},
		);

	// -- execute -------------------------------------------------------------
	agents
		.command("execute <id>")
		.description("Execute an agent")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--input <json>", 'Input JSON (e.g. \'{"key":"value"}\')')
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: {
					org?: string;
					personal?: boolean;
					input?: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();

				let inputObj: Record<string, unknown> = {};
				if (opts.input) {
					try {
						inputObj = JSON.parse(opts.input);
					} catch {
						printError("--input must be valid JSON", 2);
					}
				}

				let result: import("@fabricorg/sdk").FabricAgentExecution;
				try {
					result = await client.agents.execute(id, {
						input: inputObj,
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(result, { format: fmt });
					return;
				}

				printRecord({
					"Task ID": result.taskId,
					"Workflow ID": result.workflowId,
					"Run ID": result.runId ?? "(pending)",
					Status: result.status,
					...(result.warning ? { Warning: result.warning } : {}),
				});
			},
		);

	return agents;
}
