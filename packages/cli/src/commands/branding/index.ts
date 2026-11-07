import { readFile } from "node:fs/promises";
import type {
	ClientBrandUpdate,
	CompanyBrandUpdate,
	ProposalStyleUpdate,
} from "@fabricorg/sdk";
import { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput } from "../../lib/output.js";
export function buildBrandingCommand(): Command {
	const command = new Command("branding").description(
		"Read saved company/client branding and save reviewed brand text; catalog fonts and cover themes are supported; logo uploads are managed in Portal",
	);
	command
		.command("show")
		.option("--project <id>", "Project whose client brand to read")
		.option("--org <slug>", "Organization context")
		.action(async (options: { project?: string; org?: string }) => {
			try {
				printOutput(
					await getClient({ project: options.project }).branding.get({
						projectId: options.project,
						org: options.org,
					}),
					{ format: "json" },
				);
			} catch (error) {
				printError(
					error instanceof Error
						? error.message
						: "Could not read branding",
					1,
				);
			}
		});
	for (const kind of ["company", "client"] as const) {
		const write = command
			.command(`update-${kind}`)
			.description(
				"Save reviewed JSON including expectedVersion; assets are preserved",
			)
			.requiredOption(
				"--file <path>",
				"JSON with expectedVersion and reviewed brand text",
			)
			.option("--org <slug>", "Organization context");
		if (kind === "client") {
			write.requiredOption(
				"--project <id>",
				"Project receiving this client brand",
			);
		}
		write.action(
			async (options: {
				file: string;
				org?: string;
				project?: string;
			}) => {
				try {
					const input: unknown = JSON.parse(
						await readFile(options.file, "utf8"),
					);
					if (
						!input ||
						typeof input !== "object" ||
						Array.isArray(input) ||
						!("expectedVersion" in input) ||
						!Number.isInteger(input.expectedVersion) ||
						Number(input.expectedVersion) < 0
					) {
						throw new Error(
							"Include the non-negative expectedVersion returned by branding show.",
						);
					}
					const result =
						kind === "company"
							? await getClient().branding.updateCompany(
									input as CompanyBrandUpdate,
									{ org: options.org },
								)
							: await getClient({
									project: options.project,
								}).branding.updateClient(
									options.project as string,
									input as ClientBrandUpdate,
									{ org: options.org },
								);
					printOutput(result, { format: "json" });
					if (result.outcome === "conflict") {
						printError(
							"Brand changed. Read branding show and review again before saving.",
							1,
						);
					}
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "Could not save branding",
						1,
					);
				}
			},
		);
	}
	for (const write of [false, true]) {
		const operation = command
			.command(write ? "update-proposal-style" : "show-proposal-style")
			.description(
				write
					? "Save reviewed proposal Style JSON with expectedUpdatedAt from show-proposal-style"
					: "Read the proposal visual brand, cover treatment and presentation",
			)
			.requiredOption(
				"--project <id>",
				"Project containing this Proposal",
			)
			.requiredOption("--document <id>", "Proposal document")
			.option("--org <slug>", "Organization context");
		if (write) {
			operation.requiredOption(
				"--file <path>",
				"Reviewed JSON with expectedUpdatedAt (null before first save)",
			);
		}
		operation.action(
			async (options: {
				project: string;
				document: string;
				org?: string;
				file?: string;
			}) => {
				try {
					const client = getClient({ project: options.project });
					if (!write) {
						printOutput(
							await client.branding.getProposalStyle(
								options.project,
								options.document,
								{ org: options.org },
							),
							{ format: "json" },
						);
						return;
					}
					const input: unknown = JSON.parse(
						await readFile(options.file as string, "utf8"),
					);
					if (
						!input ||
						typeof input !== "object" ||
						Array.isArray(input) ||
						!("expectedUpdatedAt" in input) ||
						(input.expectedUpdatedAt !== null &&
							(typeof input.expectedUpdatedAt !== "string" ||
								!Number.isFinite(
									Date.parse(input.expectedUpdatedAt),
								)))
					) {
						throw new Error(
							"Include expectedUpdatedAt from show-proposal-style; use null before the first save.",
						);
					}
					printOutput(
						await client.branding.updateProposalStyle(
							options.project,
							options.document,
							input as ProposalStyleUpdate,
							{ org: options.org },
						),
						{ format: "json" },
					);
				} catch (error) {
					printError(
						error instanceof Error
							? error.message
							: "Could not access proposal Style",
						1,
					);
				}
			},
		);
	}
	return command;
}
