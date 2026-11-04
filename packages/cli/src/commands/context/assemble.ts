import { open } from "node:fs/promises";
import type { ContextSelectionInput } from "@fabricorg/sdk";
import type { Command } from "commander";
import { getClient } from "../../lib/client.js";
import { printError, printOutput } from "../../lib/output.js";

/** Bounded local input; the server validates references and all current access. */
export async function readContextSelectionFile(
	path: string,
): Promise<ContextSelectionInput> {
	const file = await open(path, "r");
	try {
		const stat = await file.stat();
		if (!stat.isFile())
			throw new Error("Selection must be a regular JSON file.");
		const bytes = Buffer.alloc(16 * 1024 + 1);
		let bytesRead = 0;
		while (bytesRead < bytes.length) {
			const chunk = await file.read(
				bytes,
				bytesRead,
				bytes.length - bytesRead,
				bytesRead,
			);
			if (chunk.bytesRead === 0) break;
			bytesRead += chunk.bytesRead;
		}
		if (bytesRead > 16 * 1024)
			throw new Error("Selection JSON must be at most 16 KiB.");
		const input: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(
				bytes.subarray(0, bytesRead),
			),
		);
		if (
			!input ||
			typeof input !== "object" ||
			Array.isArray(input) ||
			Object.keys(input).some((key) => key !== "selections") ||
			!("selections" in input) ||
			!Array.isArray(input.selections) ||
			input.selections.length < 1 ||
			input.selections.length > 12
		)
			throw new Error(
				"Use { selections: [...] } with 1 to 12 explicit source references.",
			);
		return input as ContextSelectionInput;
	} finally {
		await file.close();
	}
}
export function registerContextAssembleCommand(context: Command) {
	context
		.command("assemble")
		.description(
			"Read selected current Project/Workspace sources with citations and revision checks; prints untrusted reference data, creates no run or snapshot",
		)
		.requiredOption("--project <id>", "Project ID")
		.requiredOption(
			"--selection-file <path>",
			"JSON { selections: [...] }; at most 16 KiB, 12 sources",
		)
		.option("--org <slug>", "Organization context")
		.action(async (opts) => {
			try {
				const input = await readContextSelectionFile(
					opts.selectionFile,
				);
				const packet = await getClient()
					.withoutContext()
					.contexts.assemble(opts.project, input, { org: opts.org });
				printOutput(packet, { format: "json" });
			} catch (error) {
				printError((error as Error).message, 1);
			}
		});
}
