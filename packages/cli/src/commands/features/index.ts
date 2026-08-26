/**
 * fabric features
 *
 *   fabric features list --project <id>           List features in a project
 *   fabric features show --project <id> <id>      Show feature details
 *   fabric features create --project <id> <title> Create a feature
 */

import type { FabricFeature } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import {
	printError,
	printOutput,
	printRecord,
	printSuccess,
} from "../../lib/output.js";

export function buildFeaturesCommand(): Command {
	const features = new Command("features").description(
		"Manage project features",
	);

	// -- list ----------------------------------------------------------------
	features
		.command("list")
		.description("List features in a project")
		.requiredOption("-p, --project <id>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option(
			"--priority <priority>",
			"Filter: P0_CRITICAL|P1_HIGH|P2_MEDIUM|P3_LOW",
		)
		.option("--search <query>", "Search by title")
		.option("--limit <n>", "Max results (default 50)", "50")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.option("-q, --quiet", "Print IDs only")
		.action(
			async (opts: {
				project: string;
				org?: string;
				personal?: boolean;
				priority?: string;
				search?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricFeature[];
				try {
					list = await client.projects.listFeatures(opts.project, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
						priority: opts.priority as
							| FabricFeature["priority"]
							| undefined,
						search: opts.search,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const f of list) {
						process.stdout.write(`${f.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: ["identifier", "title", "priority", "createdAt"],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	features
		.command("show <id>")
		.description("Show feature details")
		.requiredOption("-p, --project <projectId>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: {
					project: string;
					org?: string;
					personal?: boolean;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let feature: FabricFeature;
				try {
					feature = await client.projects.getFeature(
						opts.project,
						id,
						{
							org: ctx?.type === "org" ? ctx.slug : undefined,
							personal:
								ctx?.type === "personal" ? true : undefined,
						},
					);
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(feature, { format: fmt });
					return;
				}

				printRecord({
					ID: feature.id,
					Identifier: feature.identifier,
					Title: feature.title,
					Priority: feature.priority,
					Description: feature.description ?? "(none)",
					"Acceptance Criteria":
						feature.acceptanceCriteria ?? "(none)",
					Project: feature.projectId,
					Assignee: feature.assigneeId ?? "(none)",
					Created: feature.createdAt.slice(0, 10),
				});
			},
		);

	// -- create --------------------------------------------------------------
	features
		.command("create <title>")
		.description("Create a feature in a project")
		.requiredOption("-p, --project <projectId>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("-d, --description <text>", "Feature description")
		.option(
			"--priority <priority>",
			"Priority: P0_CRITICAL|P1_HIGH|P2_MEDIUM|P3_LOW (default: P2_MEDIUM)",
		)
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				title: string,
				opts: {
					project: string;
					org?: string;
					personal?: boolean;
					description?: string;
					priority?: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let feature: FabricFeature;
				try {
					feature = await client.projects.createFeature(
						opts.project,
						{
							title,
							description: opts.description,
							priority: opts.priority as
								| FabricFeature["priority"]
								| undefined,
							org: ctx?.type === "org" ? ctx.slug : undefined,
							personal:
								ctx?.type === "personal" ? true : undefined,
						},
					);
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(feature, { format: fmt });
					return;
				}

				printSuccess(`Feature ${feature.identifier} created`);
				printRecord({
					ID: feature.id,
					Identifier: feature.identifier,
					Title: feature.title,
					Priority: feature.priority,
					Project: feature.projectId,
					Created: feature.createdAt.slice(0, 10),
				});
			},
		);

	// -- tasks ---------------------------------------------------------------
	features
		.command("tasks")
		.description("List tasks (sub-items) for a feature")
		.requiredOption("-p, --project <projectId>", "Project ID")
		.requiredOption("-f, --feature <featureId>", "Feature ID")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option(
			"--format <format>",
			"Output format: table|json|yaml|csv",
			"table",
		)
		.option("-q, --quiet", "Print IDs only")
		.action(
			async (opts: {
				project: string;
				feature: string;
				org?: string;
				personal?: boolean;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let tasks: import("@fabricorg/sdk").FabricTask[];
				try {
					tasks = await client.projects.listTasks(
						opts.project,
						opts.feature,
						{
							org: ctx?.type === "org" ? ctx.slug : undefined,
							personal:
								ctx?.type === "personal" ? true : undefined,
						},
					);
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const t of tasks) {
						process.stdout.write(`${t.id}\n`);
					}
					return;
				}

				printOutput(tasks, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: [
						"identifier",
						"title",
						"status",
						"estimatedHours",
					],
				});
			},
		);

	// -- update --------------------------------------------------------------
	features
		.command("update <id>")
		.description("Update a feature")
		.requiredOption("-p, --project <projectId>", "Project ID")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--title <title>", "New title")
		.option("-d, --description <text>", "New description")
		.option(
			"--priority <priority>",
			"Priority: P0_CRITICAL|P1_HIGH|P2_MEDIUM|P3_LOW",
		)
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: {
					project: string;
					org?: string;
					personal?: boolean;
					title?: string;
					description?: string;
					priority?: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let feature: FabricFeature;
				try {
					feature = await client.projects.updateFeature(
						opts.project,
						id,
						{
							title: opts.title,
							description: opts.description,
							priority: opts.priority as
								| FabricFeature["priority"]
								| undefined,
							org: ctx?.type === "org" ? ctx.slug : undefined,
							personal:
								ctx?.type === "personal" ? true : undefined,
						},
					);
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(feature, { format: fmt });
					return;
				}

				printRecord({
					ID: feature.id,
					Identifier: feature.identifier,
					Title: feature.title,
					Priority: feature.priority,
					Updated: feature.updatedAt.slice(0, 10),
				});
			},
		);

	return features;
}
