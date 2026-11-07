/**
 * fabric workflows
 *
 *   fabric workflows list                      List workflows
 *   fabric workflows show <id>                 Show workflow details
 *   fabric workflows trigger <id>              Trigger a workflow execution
 *   fabric workflows status <id> <execId>      Get execution status
 */

import { readFile } from "node:fs/promises";
import type {
	AgentTestChecks,
	FabricExecution,
	FabricWorkflow,
	WorkflowStarter,
} from "@fabricorg/sdk";
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

	workflows
		.command("starters")
		.description("List delivery workflow starters")
		.option("--org <slug>", "Organization context")
		.action(async (opts) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.listStarters({
						org: ctx?.type === "org" ? ctx.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	workflows
		.command("from-starter <starterId>")
		.description(
			"Create a draft from a delivery starter; does not run or publish",
		)
		.option("--org <slug>", "Organization context")
		.option("--name <name>", "Draft name")
		.action(async (starterId: WorkflowStarter["id"], opts) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.createFromStarter(
						{ starterId, name: opts.name },
						{ org: ctx?.type === "org" ? ctx.slug : undefined },
					),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	workflows
		.command("check <id>")
		.description("Check saved configuration; no live external requests")
		.option("--org <slug>", "Organization context")
		.action(async (id: string, opts) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.checkReadiness(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	for (const action of ["publish", "unpublish", "pause", "resume"] as const) {
		const command = workflows
			.command(`${action} <id>`)
			.description(
				action === "publish"
					? "Publish the saved graph as a version and enable its triggers"
					: `${action} future workflow triggers; current runs keep their state`,
			)
			.option("--org <slug>", "Organization context");
		if (action === "publish") {
			command
				.option("--changelog <text>", "Publish change note")
				.option(
					"--enable-webhook",
					"Enable a webhook and return its signing secret",
				);
		}
		command.action(async (id: string, opts) => {
			const context = resolveContext(false, opts.org, false);
			const options = {
				org: context?.type === "org" ? context.slug : undefined,
			};
			try {
				const resource = getClient().workflows;
				const result =
					action === "publish"
						? await resource.publish(
								id,
								{
									changelog: opts.changelog,
									enableWebhook: opts.enableWebhook,
								},
								options,
							)
						: await resource[action](id, options);
				printOutput(result, { format: "json" });
				if (result.success === false) {
					printError(
						"Publication was refused. Fix the reported validation issues.",
						1,
					);
				}
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	}
	workflows
		.command("versions <id>")
		.description("List saved workflow versions")
		.option("--org <slug>", "Organization context")
		.option("--limit <n>", "Page size", "20")
		.option("--offset <n>", "Page offset", "0")
		.action(async (id: string, opts) => {
			const context = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.listVersions(id, {
						org: context?.type === "org" ? context.slug : undefined,
						limit: Number(opts.limit),
						offset: Number(opts.offset),
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	workflows
		.command("rollback <id> <version>")
		.description(
			"Restore a published version after current authorization and validation checks",
		)
		.option("--org <slug>", "Organization context")
		.action(async (id: string, version: string, opts) => {
			const context = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.rollback(id, Number(version), {
						org: context?.type === "org" ? context.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	const schedule = workflows
		.command("schedule")
		.description("Inspect live schedules and configure draft schedules");
	schedule
		.command("show <id>")
		.option("--org <slug>", "Organization context")
		.action(async (id: string, opts) => {
			const context = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.getSchedule(id, {
						org: context?.type === "org" ? context.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	schedule
		.command("set <id>")
		.description("Save a draft schedule; publish separately to activate it")
		.requiredOption("--cron <expression>", "Cron expression")
		.option("--timezone <zone>", "IANA time zone", "UTC")
		.option("--org <slug>", "Organization context")
		.action(async (id: string, opts) => {
			const context = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().workflows.configureSchedule(
						id,
						{ cron: opts.cron, timezone: opts.timezone },
						{
							org:
								context?.type === "org"
									? context.slug
									: undefined,
						},
					),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});

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

	const checks = workflows
		.command("checks")
		.description(
			"Check recorded workflow results; no workflow or model is invoked",
		);
	const collect = (value: string, previous: string[]) => [...previous, value];
	const orgOptions = (org?: string) => {
		const ctx = resolveContext(false, org, false);
		return { org: ctx?.type === "org" ? ctx.slug : undefined };
	};
	checks
		.command("list <id>")
		.option("--org <slug>", "Organization context")
		.action(async (id: string, opts) => {
			try {
				printOutput(
					await getClient().workflows.listChecks(
						id,
						orgOptions(opts.org),
					),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	checks
		.command("inspect <id> <executionId> <nodeId>")
		.option("--org <slug>", "Organization context")
		.action(
			async (id: string, executionId: string, nodeId: string, opts) => {
				try {
					printOutput(
						await getClient().workflows.inspectResult(
							id,
							{ executionId, nodeId },
							orgOptions(opts.org),
						),
						{ format: "json" },
					);
				} catch (error) {
					printError((error as Error).message, 1);
				}
			},
		);
	for (const action of ["preview", "save"] as const) {
		const command = checks
			.command(`${action} <id> <executionId> <nodeId>`)
			.option("--org <slug>", "Organization context")
			.requiredOption("--revision <sha256>", "Inspected result revision")
			.option(
				"--checks-file <path>",
				"Versioned JSON checks, including structured assertions; use instead of --require/--forbid",
			)
			.option(
				"--require <phrase>",
				"Required exact phrase; repeat for more",
				collect,
				[],
			)
			.option(
				"--forbid <phrase>",
				"Forbidden exact phrase; repeat for more",
				collect,
				[],
			);
		if (action === "save") {
			command.requiredOption("--name <name>", "Saved check name");
		}
		command.action(
			async (id: string, executionId: string, nodeId: string, opts) => {
				let checks: AgentTestChecks = {
					requiredPhrases: opts.require,
					forbiddenPhrases: opts.forbid,
				};
				try {
					if (opts.checksFile) {
						if (opts.require.length || opts.forbid.length) {
							throw new Error(
								"Use either --checks-file or phrase flags, not both.",
							);
						}
						const bytes = await readFile(opts.checksFile);
						if (bytes.byteLength > 128 * 1024) {
							throw new Error(
								"Check files must not exceed 128 KiB.",
							);
						}
						const raw: unknown = JSON.parse(bytes.toString("utf8"));
						if (
							!raw ||
							typeof raw !== "object" ||
							Array.isArray(raw) ||
							Object.keys(raw).some(
								(key) =>
									![
										"version",
										"requiredPhrases",
										"forbiddenPhrases",
										"jsonSchema",
										"jsonAssertions",
										"grounding",
									].includes(key),
							)
						) {
							throw new Error(
								"Check files may contain check fields only; execution, actor and organization fields are not accepted.",
							);
						}
						checks = raw as AgentTestChecks;
					}
				} catch (error) {
					printError((error as Error).message, 1);
					return;
				}
				const input = {
					executionId,
					nodeId,
					expectedRevision: opts.revision,
					...checks,
				};
				try {
					const resource = getClient().workflows;
					printOutput(
						await (action === "save"
							? resource.saveCheck(
									id,
									{ ...input, name: opts.name },
									orgOptions(opts.org),
								)
							: resource.previewCheck(
									id,
									input,
									orgOptions(opts.org),
								)),
						{ format: "json" },
					);
				} catch (error) {
					printError((error as Error).message, 1);
				}
			},
		);
	}
	checks
		.command("compare <id> <checkId> <executionId>")
		.option("--org <slug>", "Organization context")
		.requiredOption("--revision <sha256>", "Saved check revision")
		.action(
			async (id: string, checkId: string, executionId: string, opts) => {
				try {
					printOutput(
						await getClient().workflows.applyCheck(
							id,
							{
								checkId,
								executionId,
								expectedCaseRevision: opts.revision,
							},
							orgOptions(opts.org),
						),
						{ format: "json" },
					);
				} catch (error) {
					printError((error as Error).message, 1);
				}
			},
		);
	checks
		.command("remove <id> <checkId>")
		.description("Remove a saved check; original run remains available")
		.option("--org <slug>", "Organization context")
		.requiredOption("--revision <sha256>", "Saved check revision")
		.action(async (id: string, checkId: string, opts) => {
			try {
				printOutput(
					await getClient().workflows.removeCheck(
						id,
						{ checkId, expectedCaseRevision: opts.revision },
						orgOptions(opts.org),
					),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});

	return workflows;
}
