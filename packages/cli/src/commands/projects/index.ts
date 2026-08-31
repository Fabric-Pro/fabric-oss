/**
 * fabric projects
 *
 *   fabric projects list           List projects
 *   fabric projects show <id>      Show project details
 *   fabric projects create <name>  Create a project
 */

import type { FabricProject } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import {
	printError,
	printOutput,
	printRecord,
	printSuccess,
} from "../../lib/output.js";

export function buildProjectsCommand(): Command {
	const projects = new Command("projects").description("Manage projects");

	// -- list ----------------------------------------------------------------
	projects
		.command("list")
		.description("List projects")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option(
			"--status <status>",
			"Filter by status: ACTIVE|DRAFT|COMPLETED|ARCHIVED",
		)
		.option("--search <query>", "Search by name")
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
				status?: string;
				search?: string;
				limit: string;
				format: string;
				quiet?: boolean;
			}) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricProject[];
				try {
					list = await client.projects.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						status: opts.status as
							| FabricProject["status"]
							| undefined,
						search: opts.search,
						limit: Number(opts.limit),
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				if (opts.quiet) {
					for (const p of list) {
						process.stdout.write(`${p.id}\n`);
					}
					return;
				}

				printOutput(list, {
					format: opts.format as "table" | "json" | "yaml" | "csv",
					columns: ["id", "name", "status", "createdAt"],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	projects
		.command("show <id>")
		.description("Show project details")
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
				let project: FabricProject;
				try {
					project = await client.projects.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(project, { format: fmt });
					return;
				}

				printRecord({
					ID: project.id,
					Name: project.name,
					Status: project.status,
					Description: project.description ?? "(none)",
					Repository: project.repositoryUrl ?? "(none)",
					Created: project.createdAt.slice(0, 10),
				});
			},
		);

	// -- create --------------------------------------------------------------
	projects
		.command("create <name>")
		.description("Create a new project")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("-d, --description <text>", "Project description")
		.option("--repo <url>", "Repository URL")
		.option(
			"--status <status>",
			"Initial status: DRAFT|ACTIVE (default: DRAFT)",
			"DRAFT",
		)
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				name: string,
				opts: {
					org?: string;
					personal?: boolean;
					description?: string;
					repo?: string;
					status: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let project: FabricProject;
				try {
					project = await client.projects.create({
						name,
						description: opts.description,
						repositoryUrl: opts.repo,
						status: opts.status as "DRAFT" | "ACTIVE",
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(project, { format: fmt });
					return;
				}

				printSuccess(`Project "${project.name}" created`);
				printRecord({
					ID: project.id,
					Name: project.name,
					Status: project.status,
					Description: project.description ?? "(none)",
					Created: project.createdAt.slice(0, 10),
				});
			},
		);

	// -- update --------------------------------------------------------------
	projects
		.command("update <id>")
		.description("Update a project")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Retired — context is organization-only")
		.option("--name <name>", "New name")
		.option("-d, --description <text>", "New description")
		.option("--repo <url>", "Repository URL")
		.option("--status <status>", "Status: DRAFT|ACTIVE|COMPLETED|ARCHIVED")
		.option("--format <format>", "Output format: table|json|yaml", "table")
		.action(
			async (
				id: string,
				opts: {
					org?: string;
					personal?: boolean;
					name?: string;
					description?: string;
					repo?: string;
					status?: string;
					format: string;
				},
			) => {
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let project: FabricProject;
				try {
					project = await client.projects.update(id, {
						name: opts.name,
						description: opts.description,
						repositoryUrl: opts.repo,
						status: opts.status as
							| "DRAFT"
							| "ACTIVE"
							| "COMPLETED"
							| "ARCHIVED"
							| undefined,
						org: ctx?.type === "org" ? ctx.slug : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(project, { format: fmt });
					return;
				}

				printRecord({
					ID: project.id,
					Name: project.name,
					Status: project.status,
					Description: project.description ?? "(none)",
					Updated: project.updatedAt.slice(0, 10),
				});
			},
		);

	return projects;
}
