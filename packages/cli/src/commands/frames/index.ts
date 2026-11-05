/**
 * fabric frames
 *
 *   fabric frames list          List frames and slideshows
 *   fabric frames show <id>     Show frame details
 */

import { readFile } from "node:fs/promises";
import type {
	FabricFrame,
	FrameContentEdit,
	FrameRevokeSharingInput,
	FrameShareInput,
} from "@fabricorg/sdk";
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
		.option("--personal", "Retired — context is organization-only")
		.option("--limit <n>", "Max results (default 50)", "50")
		.option("--offset <n>", "Result offset", "0")
		.option("--conversation <id>", "Only pages from this conversation")
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
				offset: string;
				conversation?: string;
				format: string;
				quiet?: boolean;
			}) => {
				const limit = Number(opts.limit);
				const offset = Number(opts.offset);
				if (
					!Number.isInteger(limit) ||
					limit < 1 ||
					limit > 200 ||
					!Number.isInteger(offset) ||
					offset < 0
				) {
					printError(
						"Use --limit from 1 to 200 and a non-negative integer --offset.",
						2,
					);
				}
				const ctx = resolveContext(opts.personal, opts.org, false);
				const client = getClient();
				let list: FabricFrame[];
				try {
					list = await client.frames.list({
						org: ctx?.type === "org" ? ctx.slug : undefined,
						limit,
						offset,
						conversationId: opts.conversation,
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
		.option("--personal", "Retired — context is organization-only")
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
					Description: frame.description ?? "(none)",
					Updated: frame.updatedAt.slice(0, 10),
				});
			},
		);

	frames
		.command("history <id>")
		.description("List saved versions of a frame")
		.option("--org <slug>", "Organization context")
		.action(async (id: string, opts: { org?: string }) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().frames.history(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	frames
		.command("update <id> <file>")
		.description("Save content JSON with its expectedUpdatedAt revision")
		.option("--org <slug>", "Organization context")
		.action(async (id: string, file: string, opts: { org?: string }) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				const edit = JSON.parse(
					await readFile(file, "utf8"),
				) as FrameContentEdit;
				printOutput(
					await getClient().frames.update(id, edit, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	frames
		.command("restore <id> <history-entry-id>")
		.description(
			"Restore saved content while preserving current sharing and tools",
		)
		.requiredOption(
			"--expected-updated-at <timestamp>",
			"Revision you reviewed",
		)
		.option("--org <slug>", "Organization context")
		.action(
			async (
				id: string,
				entry: string,
				opts: { org?: string; expectedUpdatedAt: string },
			) => {
				const ctx = resolveContext(false, opts.org, false);
				try {
					printOutput(
						await getClient().frames.restore(
							id,
							{
								historyEntryId: entry,
								expectedUpdatedAt: opts.expectedUpdatedAt,
							},
							{ org: ctx?.type === "org" ? ctx.slug : undefined },
						),
						{ format: "json" },
					);
				} catch (error) {
					printError((error as Error).message, 1);
				}
			},
		);

	const exports = frames
		.command("exports")
		.description(
			"Export reviewed page content through durable background jobs",
		);
	exports
		.command("start <id>")
		.description(
			"Start a PDF export; retain the request ID to recover a lost response",
		)
		.requiredOption(
			"--expected-updated-at <timestamp>",
			"Reviewed page revision",
		)
		.requiredOption(
			"--request-id <uuid>",
			"Stable UUID for this export request",
		)
		.option(
			"--orientation <orientation>",
			"portrait or landscape",
			"portrait",
		)
		.option("--org <slug>", "Organization context")
		.action(
			async (
				id: string,
				opts: {
					expectedUpdatedAt: string;
					requestId: string;
					orientation: string;
					org?: string;
				},
			) => {
				if (!["portrait", "landscape"].includes(opts.orientation)) {
					printError("Use portrait or landscape orientation.", 2);
				}
				const ctx = resolveContext(false, opts.org, false);
				try {
					printOutput(
						await getClient().frames.startExport(
							id,
							{
								expectedUpdatedAt: opts.expectedUpdatedAt,
								requestId: opts.requestId,
								orientation: opts.orientation as
									| "portrait"
									| "landscape",
							},
							{ org: ctx?.type === "org" ? ctx.slug : undefined },
						),
						{ format: "json" },
					);
				} catch (error) {
					printError((error as Error).message, 1);
				}
			},
		);
	for (const action of ["status", "cancel", "download"] as const) {
		exports
			.command(`${action} <id> <export-id>`)
			.description(
				action === "status"
					? "Inspect export progress"
					: action === "cancel"
						? "Cancel an export and remove its stored result"
						: "Get a short-lived download link after checking current access",
			)
			.option("--org <slug>", "Organization context")
			.action(
				async (
					id: string,
					exportId: string,
					opts: { org?: string },
				) => {
					const ctx = resolveContext(false, opts.org, false);
					const client = getClient();
					const options = {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					};
					try {
						printOutput(
							await (action === "status"
								? client.frames.getExport(id, exportId, options)
								: action === "cancel"
									? client.frames.cancelExport(
											id,
											exportId,
											options,
										)
									: client.frames.downloadExport(
											id,
											exportId,
											options,
										)),
							{ format: "json" },
						);
					} catch (error) {
						printError((error as Error).message, 1);
					}
				},
			);
	}
	frames
		.command("sharing <id>")
		.description(
			"Inspect sharing without revealing public link credentials",
		)
		.option("--org <slug>", "Organization context")
		.action(async (id: string, opts: { org?: string }) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				printOutput(
					await getClient().frames.sharing(id, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	frames
		.command("share <id> <file>")
		.description(
			"Apply explicit sharing JSON with reviewed revision; does not send email",
		)
		.option("--org <slug>", "Organization context")
		.action(async (id: string, file: string, opts: { org?: string }) => {
			const ctx = resolveContext(false, opts.org, false);
			try {
				const input = JSON.parse(
					await readFile(file, "utf8"),
				) as FrameShareInput;
				printOutput(
					await getClient().frames.share(id, input, {
						org: ctx?.type === "org" ? ctx.slug : undefined,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
	frames
		.command("revoke-sharing <id>")
		.description(
			"Remove a public link, individual invitation, or all explicit sharing",
		)
		.requiredOption("--mode <mode>", "public-link, invitation, or all")
		.requiredOption(
			"--expected-updated-at <timestamp>",
			"Reviewed page revision",
		)
		.option("--email <email>", "Required only for invitation mode")
		.option("--org <slug>", "Organization context")
		.action(
			async (
				id: string,
				opts: {
					mode: string;
					expectedUpdatedAt: string;
					email?: string;
					org?: string;
				},
			) => {
				if (
					!["public-link", "invitation", "all"].includes(opts.mode) ||
					(opts.mode === "invitation") !== Boolean(opts.email)
				) {
					printError(
						"Choose public-link, invitation with --email, or all.",
						2,
					);
				}
				const ctx = resolveContext(false, opts.org, false);
				try {
					printOutput(
						await getClient().frames.revokeSharing(
							id,
							{
								mode: opts.mode as FrameRevokeSharingInput["mode"],
								expectedUpdatedAt: opts.expectedUpdatedAt,
								email: opts.email,
							},
							{ org: ctx?.type === "org" ? ctx.slug : undefined },
						),
						{ format: "json" },
					);
				} catch (error) {
					printError((error as Error).message, 1);
				}
			},
		);

	return frames;
}
