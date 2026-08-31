/**
 * fabric workflows
 *
 *   fabric workflows list                      List workflows
 *   fabric workflows show <id>                 Show workflow details
 *   fabric workflows trigger <id>              Trigger a workflow execution
 *   fabric workflows status <id> <execId>      Get execution status
 */

import type { FabricExecution, FabricWorkflow } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import {
	printError,
	printOutput,
	printRecord,
	printSuccess,
} from "../../lib/output.js";

export function buildWorkflowsCommand(): Command {
	const workflows = new Command("workflows").description("Manage workflows");

	// -- list ----------------------------------------------------------------
	workflows
		.command("list")
		.description("List workflows")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--status <status>", "Filter: DRAFT|ACTIVE|PAUSED|ARCHIVED")
		.option("--search <query>", "Search by name")
		.option("--limit <n>", "Max results", "20")
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
				search?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricWorkflow[];
				try {
					list = await client.workflows.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						status: opts.status as
							| FabricWorkflow["status"]
							| undefined,
						search: opts.search,
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
						"status",
						"triggerType",
						"createdAt",
					],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	workflows
		.command("show <id>")
		.description("Show workflow details")
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
				let wf: FabricWorkflow;
				try {
					wf = await client.workflows.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(wf, { format: fmt });
					return;
				}

				printRecord({
					ID: wf.id,
					Name: wf.name,
					Status: wf.status,
					Trigger: wf.triggerType,
					Version: String(wf.version),
					Created: wf.createdAt.slice(0, 10),
				});
			},
		);

	// -- trigger -------------------------------------------------------------
	workflows
		.command("trigger <id>")
		.description("Trigger a workflow execution")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--input <json>", "JSON input for triggerData", "{}")
		.option("--vars <json>", "JSON variables", "{}")
		.action(
			async (
				id: string,
				opts: {
					org?: string;
					personal?: boolean;
					input: string;
					vars: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();

				let triggerData: Record<string, unknown> = {};
				let variables: Record<string, unknown> = {};
				try {
					triggerData = JSON.parse(opts.input);
					variables = JSON.parse(opts.vars);
				} catch {
					printError("--input and --vars must be valid JSON", 2);
				}

				let result: {
					executionId: string;
					workflowId: string;
					status: string;
				};
				try {
					result = await client.workflows.trigger(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
						triggerData,
						variables,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				printSuccess("Workflow triggered");
				process.stdout.write(`  Execution ID: ${result.executionId}\n`);
				process.stdout.write(`  Status:       ${result.status}\n`);
			},
		);

	// -- status --------------------------------------------------------------
	workflows
		.command("status <id> <execId>")
		.description("Get workflow execution status")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				execId: string,
				opts: { org?: string; personal?: boolean; format: string },
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let exec: FabricExecution;
				try {
					exec = await client.workflows.getExecution(id, execId, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(exec, { format: fmt });
					return;
				}

				printRecord({
					ID: exec.id,
					"Workflow ID": exec.workflowId,
					Status: exec.status,
					"Trigger type": exec.triggerType,
					Started: exec.startedAt?.slice(0, 19) ?? "(not started)",
					Completed: exec.completedAt?.slice(0, 19) ?? "(running)",
					Error: exec.error ?? "(none)",
				});
			},
		);

	return workflows;
}
