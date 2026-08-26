/**
 * fabric frames
 *
 *   fabric frames list          List frames and slideshows
 *   fabric frames show <id>     Show frame details
 */

import type { FabricFrame } from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput, printRecord } from "../../lib/output.js";

export function buildFramesCommand(): Command {
	const frames = new Command("frames").description(
		"Manage AI-generated frames and slideshows",
	);

	// -- list ----------------------------------------------------------------
	frames
		.command("list")
		.description("List frames and slideshows")
		.option("--org <slug>", "Organization context")
		.option("--personal", "Personal context")
		.option("--limit <n>", "Max results (default 50)", "50")
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
				let list: FabricFrame[];
				try {
					list = await client.frames.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
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
					columns: [
						"id",
						"title",
						"fileType",
						"status",
						"isPublic",
						"updatedAt",
					],
				});
			},
		);

	// -- show ----------------------------------------------------------------
	frames
		.command("show <id>")
		.description("Show frame details")
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
				let frame: FabricFrame;
				try {
					frame = await client.frames.get(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
						personal: ctx?.type === "personal" ? true : undefined,
					});
				} catch (err: unknown) {
					printError((err as Error).message, 1);
				}

				const fmt = opts.format as "table" | "json" | "yaml";
				if (fmt === "json" || fmt === "yaml") {
					printOutput(frame, { format: fmt });
					return;
				}

				printRecord({
					ID: frame.id,
					Title: frame.title,
					Kind: frame.kind ?? "(none)",
					"File Type": frame.fileType,
					Status: frame.status,
					Public: frame.isPublic ? "yes" : "no",
					"Share Token": frame.shareToken ?? "(none)",
					Description: frame.description ?? "(none)",
					Updated: frame.updatedAt.slice(0, 10),
				});
			},
		);

	return frames;
}
