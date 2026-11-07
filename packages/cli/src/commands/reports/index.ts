import { readFile } from "node:fs/promises";
import type { ReportInstanceBrandingUpdate } from "@fabricorg/sdk";
import { registerReportLifecycleCommands } from "./lifecycle.js";
/**
 * fabric reports
 *
 *   fabric reports templates list              List report templates
 *   fabric reports templates show <id>         Show template details
 *   fabric reports executions list             List report executions
 */

import type {
	FabricReportTemplate,
	ReportHistoryExecution,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildReportsCommand(): Command {
	const reports = new Command("reports").description(
		"Manage report templates and executions",
	);

	const branding = reports
		.command("branding")
		.description("Review saved company/client report branding")
		.option("--org <slug>", "Organization context")
		.option("--project <id>", "Report audience project")
		.action(async (opts) => {
			try {
				printOutput(
					await getClient().reports.branding({
						org: resolveContext(false, opts.org, false)?.slug,
						projectId: opts.project,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError(
					error instanceof Error ? error.message : String(error),
					1,
				);
			}
		});
	branding
		.command("show <id>")
		.description("Review the report revision and saved branding choices")
		.option("--org <slug>", "Organization context")
		.action(async (id, opts) => {
			try {
				printOutput(
					await getClient().reports.getInstanceBranding(id, {
						org: resolveContext(false, opts.org, false)?.slug,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError(
					error instanceof Error ? error.message : String(error),
					1,
				);
			}
		});
	branding
		.command("apply <id>")
		.description("Save reviewed branding JSON; null branding removes it")
		.requiredOption(
			"--file <path>",
			"JSON with expectedInstanceVersion, expectedUpdatedAt and branding selection",
		)
		.option("--org <slug>", "Organization context")
		.action(async (id, opts) => {
			try {
				const text = await readFile(opts.file, "utf8");
				if (Buffer.byteLength(text) > 16384) {
					throw new Error("Brand request exceeds 16 KiB");
				}
				const input = JSON.parse(text) as ReportInstanceBrandingUpdate;
				printOutput(
					await getClient().reports.applyInstanceBranding(id, input, {
						org: resolveContext(false, opts.org, false)?.slug,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError(
					error instanceof Error ? error.message : String(error),
					1,
				);
			}
		});
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
		.description(
			"List legacy executions, or use --report for native cursor history",
		)
		.option(
			"--report <id>",
			"Configured report ID for native cursor history",
		)
		.option("--cursor <token>", "Next cursor from previous page")
		.option(
			"--offset <n>",
			"Legacy list offset; use cursor with --report",
			"0",
		)
		.option(
			"--status <status>",
			"Filter PENDING|RUNNING|COMPLETED|FAILED|CANCELLED",
		)
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
			async (
				opts: {
					org?: string;
					personal?: boolean;
					limit: string;
					report?: string;
					offset: string;
					cursor?: string;
					status?:
						| "PENDING"
						| "RUNNING"
						| "COMPLETED"
						| "FAILED"
						| "CANCELLED";
					format: string;
					quiet?: boolean;
				},
				command: Command,
			) => {
				const inherited = command.optsWithGlobals();
				const format = inherited.json
					? "json"
					: inherited.plain
						? "plain"
						: command.getOptionValueSource("format") === "cli"
							? opts.format
							: (inherited.format ?? opts.format);
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				if (!opts.report) {
					if (opts.cursor) {
						printError("Use --report for native cursor history", 1);
					}
					try {
						const legacy = await client.reports.listExecutions({
							org: ctx?.type === "org" ? ctx.slug : undefined,
							limit: Number(opts.limit),
							offset: Number(opts.offset),
							status: opts.status,
						});
						if (opts.quiet) {
							for (const execution of legacy) {
								process.stdout.write(`${execution.id}\n`);
							}
						} else {
							printOutput(legacy, {
								format: format as
									| "table"
									| "json"
									| "yaml"
									| "csv",
								columns: [
									"id",
									"templateId",
									"status",
									"startedAt",
									"completedAt",
								],
							});
						}
						return;
					} catch (error) {
						printError(
							error instanceof Error
								? error.message
								: String(error),
							1,
						);
					}
				}
				if (Number(opts.offset) !== 0) {
					printError(
						"Native report history uses --cursor; omit --offset",
						1,
					);
				}

				let list: ReportHistoryExecution[];
				try {
					const page = await client.reports.listInstanceExecutions(
						opts.report,
						{
							cursor: opts.cursor,
							status: opts.status,
							org: ctx?.type === "org" ? ctx.slug : undefined,
							limit: Number(opts.limit),
						},
					);
					list = page.executions;
					if (format === "json") {
						printOutput(page, { format: "json" });
						return;
					}
					if (page.nextCursor) {
						process.stderr.write(
							`Next cursor: ${page.nextCursor}\n`,
						);
					}
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
					format: format as "table" | "json" | "yaml" | "csv",
					columns: [
						"id",
						"instanceId",
						"status",
						"startedAt",
						"completedAt",
					],
				});
			},
		);

	reports.addCommand(executions);

	registerReportLifecycleCommands(reports, executions);
	return reports;
}
