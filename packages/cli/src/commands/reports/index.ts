/**
 * fabric reports
 *
 *   fabric reports templates list              List report templates
 *   fabric reports templates show <id>         Show template details
 *   fabric reports executions list             List report executions
 */

import type {
	FabricReportExecution,
	FabricReportTemplate,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildReportsCommand(): Command {
	const reports = new Command("reports").description(
		"Manage report templates and executions",
	);

	// -- templates -----------------------------------------------------------
	const templates = new Command("templates").description(
		"Manage report templates",
	);

	templates
		.command("list", { isDefault: true })
		.description("List report templates")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--search <query>", "Search by name")
		.option("--category <cat>", "Filter by category")
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
				category?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricReportTemplate[];
				try {
					list = await client.reports.listTemplates({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						search: opts.search,
						category: opts.category,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const t of list) {
						process.stdout.write(`${t.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"name",
						"templateType",
						"scope",
						"usageCount",
					],
				});
			},
		);

	templates
		.command("show <id>")
		.description("Show report template details")
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
				let tmpl: FabricReportTemplate;
				try {
					tmpl = await client.reports.getTemplate(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(tmpl, { format: fmt });
					return;
				}

				printRecord({
					ID: tmpl.id,
					Name: tmpl.name,
					Type: tmpl.templateType,
					Scope: tmpl.scope,
					Category: tmpl.category ?? "(none)",
					Tags: tmpl.tags.join(", ") || "(none)",
					Public: tmpl.isPublic ? "yes" : "no",
					"Use Count": String(tmpl.usageCount),
					Description: tmpl.description ?? "(none)",
					Updated: tmpl.updatedAt.slice(0, 10),
				});
			},
		);

	reports.addCommand(templates);

	// -- executions ----------------------------------------------------------
	const executions = new Command("executions").description(
		"View report executions",
	);

	executions
		.command("list", { isDefault: true })
		.description("List report executions")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
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
				let list: FabricReportExecution[];
				try {
					list = await client.reports.listExecutions({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const e of list) {
						process.stdout.write(`${e.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"templateId",
						"status",
						"startedAt",
						"completedAt",
					],
				});
			},
		);

	reports.addCommand(executions);

	return reports;
}
