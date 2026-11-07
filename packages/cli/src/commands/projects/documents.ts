import { readFile } from "node:fs/promises";
import type { FabricDocumentType } from "@fabricorg/sdk";
import { type Command, InvalidArgumentError } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput } from "../../lib/output.js";

const brand = (value: string): "CLIENT" | "COMPANY" => {
	if (value === "client") return "CLIENT";
	if (value === "company") return "COMPANY";
	throw new InvalidArgumentError("Choose client or company.");
};
const version = (value: string) => {
	const number = Number(value);
	if (!/^\d+$/.test(value) || !Number.isSafeInteger(number) || number < 1)
		throw new InvalidArgumentError(
			"Use the positive client brand version returned by fabric branding show.",
		);
	return number;
};

/** Calls the existing document API; this does not run a model or export a PDF. */
export function registerProjectDocumentCommands(projects: Command) {
	const documents = projects
		.command("documents")
		.description("Create saved project documents");
	documents
		.command("create <project-id>")
		.description(
			"Save a Markdown draft; client Proposal colors require a reviewed saved brand",
		)
		.requiredOption("--title <title>", "Document title")
		.requiredOption("--content-file <path>", "UTF-8 Markdown file")
		.option(
			"--type <type>",
			"Document type, for example PROPOSAL or GENERAL",
			"GENERAL",
		)
		.option(
			"--branding <brand>",
			"Proposal palette: client or company",
			brand,
		)
		.option(
			"--recipient-version <version>",
			"Reviewed client brand version, required for client palette",
			version,
		)
		.option("--org <slug>", "Organization context")
		.action(async (projectId, options) => {
			try {
				if (options.branding && options.type !== "PROPOSAL")
					throw new Error("Branding applies to PROPOSAL documents.");
				if (
					options.branding === "CLIENT"
						? !options.recipientVersion
						: options.recipientVersion !== undefined
				)
					throw new Error(
						"Use --recipient-version with --branding client only.",
					);
				const content = await readFile(options.contentFile, "utf8");
				if (content.length > 1_000_000)
					throw new Error(
						"Content must be under 1,000,000 characters.",
					);
				const result = await getClient({ project: projectId })
					.withoutContext()
					.projects.createDocument(projectId, {
						title: options.title,
						type: options.type as FabricDocumentType,
						content,
						org: options.org,
						...(options.branding
							? {
									proposalBranding: options.branding,
									recipientBrandVersion:
										options.recipientVersion,
								}
							: {}),
					});
				printOutput(result, { format: "json" });
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
}
