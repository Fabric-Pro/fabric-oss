import { packPassageBlocks } from "../passage-packer";
import type { RetrievedContext } from "./retrieval";

// Measured on the serialized activity result, leaving room below the 12k
// summarizer threshold for the engine's tool-result envelope.
const RESULT_CHARS = 10_000;
const SEPARATOR = "\n\n---\n\n";

/** Reserve every source opening, then spend spare room by passage relevance. */
export function compactProjectContextPassages(
	results: RetrievedContext[],
	header: string,
	contextMetaHeader: (context: RetrievedContext) => string,
	options: {
		maxChars?: number;
		fullSourceNote?: (sourceId: string) => string;
	} = {},
): { context: string; chunkCount: number } {
	const budgetChars = options.maxChars ?? RESULT_CHARS;
	const fullSourceNote =
		options.fullSourceNote ??
		((id: string) =>
			`Read the full source with fabric_get_project_source({"source":${JSON.stringify(id)}}).`);
	const blocks = results.map((r, i) => {
		const source =
			r.sourcePath ||
			r.filename ||
			r.sourceTitle ||
			r.sourceUrl ||
			(r.metadata?.filename as string | undefined) ||
			`Context ${i + 1}`;
		const summary =
			r.type === "PROJECT_SUMMARY" || r.metadata?.isSummary === true;
		const matched = Boolean(r.matchedPassages?.length);
		const parent = r.metadata?.parentContextId;
		const readableId =
			typeof parent === "string" && parent.trim()
				? parent
				: !summary &&
						!r.metadata?.pageUrl &&
						!r.metadata?.conversationBundleId
					? r.id
					: undefined;
		const extent = matched
			? "Matched passages only."
			: summary
				? "Showing the start of the summary."
				: "Showing the start of the document.";
		const note = readableId
			? `${extent} ${fullSourceNote(readableId)}`
			: `${extent} This result id cannot be read by the project source tool.`;
		const referencesAt = summary
			? r.content.indexOf("SOURCE REFERENCES")
			: -1;
		const dividerAt =
			referencesAt >= 0 ? r.content.lastIndexOf("---", referencesAt) : -1;
		const splitAt = dividerAt >= 0 ? dividerAt : referencesAt;
		const body =
			splitAt >= 0 ? r.content.slice(0, splitAt).trimEnd() : r.content;
		const references = splitAt >= 0 ? r.content.slice(splitAt) : "";

		const passages = r.matchedPassages?.length
			? r.matchedPassages
			: [{ content: body, score: r.score }];
		return {
			header: `### From: ${source}\nResult id: ${r.id}\n${contextMetaHeader(r)}${note}\n`,
			passages,
			matched,
			references,
		};
	});
	return packPassageBlocks(blocks, {
		maxChars: budgetChars,
		omittedNote:
			"\n[Content omitted to fit the result budget; use the full-source route above where available.]",
		render: (rendered, omittedBlocks) => ({
			context: `${header}\n\n${rendered.join(SEPARATOR)}${omittedBlocks ? `\n[${omittedBlocks} source blocks omitted because their headers exceed the result budget; narrow the search to retrieve them.]` : ""}`,
			chunkCount: rendered.length,
		}),
		measure: (output) => JSON.stringify(output).length,
		metadataOverflow: {
			context:
				"[Search metadata exceeds the result budget; narrow the search.]",
			chunkCount: 0,
		},
	});
}
