import { randomUUID } from "node:crypto";
import { open, writeFile } from "node:fs/promises";
import type {
	ReportConfigurationUpdate,
	ReportDistributionInput,
	ReportSettings,
} from "@fabricorg/sdk";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { resolveContext } from "../../lib/context.js";
import { printError, printOutput } from "../../lib/output.js";

async function readSettings(path: string): Promise<Record<string, unknown>> {
	const file = await open(path, "r");
	try {
		const info = await file.stat();
		if (!info.isFile() || info.size > 128 * 1024) {
			throw new Error(
				"Report settings must be a JSON file no larger than 128 KiB",
			);
		}
		const buffer = Buffer.alloc(128 * 1024 + 1);
		const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
		if (bytesRead > 128 * 1024) {
			throw new Error("Report settings exceed 128 KiB");
		}
		const value: unknown = JSON.parse(
			buffer.subarray(0, bytesRead).toString("utf8"),
		);
		if (!value || typeof value !== "object" || Array.isArray(value)) {
			throw new Error("Provide a JSON object");
		}
		return value as Record<string, unknown>;
	} finally {
		await file.close();
	}
}
const org = (value?: string) => ({
	org: resolveContext(false, value, false)?.slug,
});
const run = (action: () => Promise<unknown>) =>
	Promise.resolve()
		.then(action)
		.then((value) => printOutput(value, { format: "json" }))
		.catch((error) =>
			printError(
				error instanceof Error ? error.message : String(error),
				1,
			),
		);
export function registerReportLifecycleCommands(
	reports: Command,
	executions: Command,
) {
	reports
		.command("list")
		.description("Find configured reports")
		.option("--org <slug>", "Organization")
		.option("--project <id>", "Project audience")
		.option("--search <text>", "Report name")
		.option("--limit <n>", "Page size", "20")
		.option("--offset <n>", "Page offset", "0")
		.action((opts) =>
			run(() =>
				getClient().reports.listInstances({
					...org(opts.org),
					projectId: opts.project,
					search: opts.search,
					limit: Number(opts.limit),
					offset: Number(opts.offset),
				}),
			),
		);
	reports
		.command("show <id>")
		.description("Read configuration and revision before changing it")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(() => getClient().reports.getInstance(id, org(opts.org))),
		);
	reports
		.command("create")
		.description("Create a report; does not execute or distribute")
		.requiredOption(
			"--file <path>",
			"JSON templateId, name, connections and optional reporting/schedule",
		)
		.option("--org <slug>", "Organization")
		.action((opts) =>
			run(async () =>
				getClient().reports.createInstance(
					(await readSettings(
						opts.file,
					)) as unknown as ReportSettings,
					org(opts.org),
				),
			),
		);
	reports
		.command("configure <id>")
		.description(
			"Save reviewed settings, requiring current expectedVersion and expectedUpdatedAt",
		)
		.requiredOption("--file <path>", "JSON changes and revision fence")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(async () =>
				getClient().reports.configureInstance(
					id,
					(await readSettings(
						opts.file,
					)) as unknown as ReportConfigurationUpdate,
					org(opts.org),
				),
			),
		);
	reports
		.command("run <id>")
		.description(
			"Execute once durably; reuse request ID after an uncertain response",
		)
		.option(
			"--request-id <uuid>",
			"Idempotency UUID; generated and printed when omitted",
		)
		.option("--file <path>", "JSON public execution parameters")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(async () => {
				const idempotencyKey = opts.requestId ?? randomUUID();
				process.stderr.write(`Request ID: ${idempotencyKey}\n`);
				return getClient().reports.executeInstance(
					id,
					{
						idempotencyKey,
						...(opts.file
							? { parameters: await readSettings(opts.file) }
							: {}),
					},
					org(opts.org),
				);
			}),
		);
	executions
		.command("show <id>")
		.description("Read a current execution and its exact artifact IDs")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(() => getClient().reports.getExecution(id, org(opts.org))),
		);
	executions
		.command("cancel <id>")
		.description("Cancel an active durable execution")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(() => getClient().reports.cancelExecution(id, org(opts.org))),
		);
	const artifacts = reports
		.command("artifacts")
		.description(
			"Review exact report outputs and explicitly distribute them",
		);
	artifacts
		.command("list <execution-id>")
		.description("Page through native saved report outputs")
		.option("--org <slug>", "Organization")
		.option("--cursor <token>", "Next cursor from previous page")
		.option("--limit <n>", "Page size", "20")
		.option("--type <type>", "Artifact type")
		.action((executionId, opts) =>
			run(() =>
				getClient().reports.listArtifacts(executionId, {
					...org(opts.org),
					cursor: opts.cursor,
					limit: Number(opts.limit),
					artifactType: opts.type,
				}),
			),
		);
	artifacts
		.command("download <id>")
		.description(
			"Get an authorized descriptor, or write output to a new file",
		)
		.option("--out <path>", "Write file; refuses overwrite")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(async () => {
				const descriptor = await getClient().reports.downloadArtifact(
					id,
					org(opts.org),
				);
				if (!opts.out) {
					return descriptor;
				}
				let bytes: Uint8Array;
				if (descriptor.type === "inline") {
					bytes = Buffer.from(descriptor.content);
				} else {
					const response = await fetch(descriptor.url, {
						redirect: "error",
					});
					if (!response.ok) {
						throw new Error(`Download failed (${response.status})`);
					}
					if (
						Number(response.headers.get("content-length") ?? 0) >
						20 * 1024 * 1024
					) {
						throw new Error("Report exceeds 20 MiB");
					}
					if (!response.body) {
						throw new Error("No report bytes returned");
					}
					const reader = response.body.getReader();
					const chunks: Uint8Array[] = [];
					let size = 0;
					while (true) {
						const chunk = await reader.read();
						if (chunk.done) {
							break;
						}
						size += chunk.value.length;
						if (size > 20 * 1024 * 1024) {
							await reader.cancel();
							throw new Error("Report exceeds 20 MiB");
						}
						chunks.push(chunk.value);
					}
					bytes = Buffer.concat(chunks);
				}
				await writeFile(opts.out, bytes, { flag: "wx", mode: 0o600 });
				return {
					path: opts.out,
					filename: descriptor.filename,
					artifactHash: descriptor.artifactHash,
					size: bytes.length,
				};
			}),
		);
	artifacts
		.command("distribute <id>")
		.description(
			"Explicitly share reviewed output to authorized Fabric inbox recipients; no external email",
		)
		.requiredOption(
			"--file <path>",
			"JSON requestId, expectedArtifactHash, recipientUserIds and optional message",
		)
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(async () =>
				getClient().reports.distributeArtifact(
					id,
					(await readSettings(
						opts.file,
					)) as unknown as ReportDistributionInput,
					org(opts.org),
				),
			),
		);
	artifacts
		.command("deliveries <id>")
		.description("Read inbox and email delivery history")
		.option("--org <slug>", "Organization")
		.action((id, opts) =>
			run(() =>
				getClient().reports.getArtifactDeliveries(id, org(opts.org)),
			),
		);
}
