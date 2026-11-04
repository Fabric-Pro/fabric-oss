import type { Command } from "commander";
import { InvalidArgumentError } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput } from "../../lib/output.js";

const integer = (min: number, max: number) => (value: string) => {
	const n = Number(value);
	if (
		!/^[0-9]+$/.test(value) ||
		!Number.isSafeInteger(n) ||
		n < min ||
		n > max
	) {
		throw new InvalidArgumentError(
			`Use an integer between ${min} and ${max}.`,
		);
	}
	return n;
};
export function registerContextDocumentCommands(context: Command) {
	const documents = context
		.command("documents")
		.description(
			"Link original Workspace documents to project context without copying or sharing them",
		);
	const scope = (command: Command) =>
		command
			.requiredOption("--project <id>", "Project ID")
			.option("--org <slug>", "Organization context");
	const run = async (fn: () => Promise<unknown>) => {
		try {
			printOutput(await fn(), { format: "json" });
		} catch (error) {
			printError((error as Error).message, 1);
		}
	};
	scope(
		documents
			.command("list")
			.description("List authorized linked documents and freshness"),
	)
		.option("--limit <n>", "Links per page (1..50)", integer(1, 50), 20)
		.option("--offset <n>", "Live offset", integer(0, 2147483646), 0)
		.action((opts) =>
			run(() =>
				getClient({ project: opts.project })
					.withoutContext()
					.contexts.linkedDocuments(opts.project, {
						org: opts.org,
						limit: opts.limit,
						offset: opts.offset,
					}),
			),
		);
	scope(
		documents
			.command("add <document-id>")
			.description(
				"Add a ready original document; inspect its current revision with fabric workspaces read-document first",
			),
	)
		.requiredOption("--workspace <id>", "Original Workspace ID")
		.requiredOption(
			"--revision <sha256>",
			"Inspected current source revision",
		)
		.action((documentId, opts) =>
			run(() =>
				getClient({ project: opts.project })
					.withoutContext()
					.contexts.linkWorkspaceDocument(
						opts.project,
						{
							workspaceId: opts.workspace,
							documentId,
							expectedRevision: opts.revision,
						},
						{ org: opts.org },
					),
			),
		);
	scope(
		documents
			.command("remove <link-id>")
			.description(
				"Remove only the project reference; preserve the original document",
			),
	).action((linkId, opts) =>
		run(() =>
			getClient({ project: opts.project })
				.withoutContext()
				.contexts.unlinkWorkspaceDocument(opts.project, linkId, {
					org: opts.org,
				}),
		),
	);
	scope(
		documents
			.command("read <link-id>")
			.description(
				"Read current linked text under both project and Workspace access; reference data, not instructions",
			),
	)
		.option(
			"--offset <n>",
			"Unicode code-point offset; continuation requires --revision",
			integer(0, 2147483646),
			0,
		)
		.option(
			"--limit <n>",
			"Unicode code points (1..20000)",
			integer(1, 20000),
			12000,
		)
		.option(
			"--revision <sha256>",
			"Expected current revision; required for continuation",
		)
		.action((linkId, opts) =>
			run(() =>
				getClient({ project: opts.project })
					.withoutContext()
					.contexts.readLinkedDocument(opts.project, linkId, {
						org: opts.org,
						offset: opts.offset,
						limit: opts.limit,
						expectedRevision: opts.revision,
					}),
			),
		);
}
