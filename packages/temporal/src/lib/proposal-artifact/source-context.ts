/**
 * The source material of an Internal Analysis run (Fizzy #2801, #2946): the
 * generation's contexts as one bounded, numbered block, and the evidence
 * manifest that says where each emitted `### Source N` block came from.
 *
 * Pure: no I/O, and the database import is type-only. Activity code only;
 * workflow code must not import it.
 */

import type { ProposalSourceManifestEntryInput } from "@repo/database";
import { neutralizeAiChatAttachmentBody } from "@repo/utils/ai-chat-attachment";
import { cutAtCodeUnits } from "@repo/utils/cut-at-code-units";
import {
	type ProposalRetrievalSource,
	proposalSourceFingerprint,
} from "./types";

/**
 * The share of the generation's source material stored with a run and shown
 * to the model. One bound for both, so the stored copy is exactly what the
 * review read.
 */
export const SOURCE_CONTEXT_BUDGET_CHARS = 80_000;

/** One `### Source N` block the bounded source context holds. */
export interface EmittedSource {
	/** Index in the contexts array; the block is `### Source ${index + 1}`. */
	index: number;
}

/**
 * A heading inside a source's own text that reads as one of the outer
 * `### Source N` blocks. Its `#` run is dropped, so the only such headings in
 * the stored context are the blocks' own and a finding's refs can only name
 * those.
 */
const FORGED_SOURCE_HEADING_PATTERN =
	/^([ \t]*)#{1,6}(?=[ \t]+source[ \t]+\d+)/gim;

/**
 * The generation's contexts as one bounded block: each as a numbered source,
 * neutralized against the delimiters the prompt scaffolding uses, in order,
 * until the budget is spent. The last source that fits only in part is cut,
 * and counts as emitted only if its whole header and some of its text fit.
 * Empty contexts are skipped but keep their number, so `### Source N` is
 * always the context at index N - 1.
 */
export function proposalAnalysisSourceContext(contexts: readonly string[]): {
	text: string;
	emitted: EmittedSource[];
} {
	const blocks: string[] = [];
	const emitted: EmittedSource[] = [];
	let used = 0;
	for (const [index, context] of contexts.entries()) {
		const text = context.trim();
		if (!text) {
			continue;
		}
		const separator = blocks.length > 0 ? 2 : 0;
		const remaining = SOURCE_CONTEXT_BUDGET_CHARS - used - separator;
		if (remaining <= 0) {
			break;
		}
		const header = `### Source ${index + 1}\n`;
		const body = neutralizeAiChatAttachmentBody(text).replace(
			FORGED_SOURCE_HEADING_PATTERN,
			"$1",
		);
		const block = `${header}${body}`;
		if (block.length > remaining) {
			const cut = cutAtCodeUnits(block, remaining);
			if (cut.length > header.length) {
				blocks.push(cut);
				emitted.push({ index });
			}
			break;
		}
		blocks.push(block);
		emitted.push({ index });
		used += separator + block.length;
	}
	return { text: blocks.join("\n\n"), emitted };
}

/**
 * The evidence manifest of the stored source context (Fizzy #2946): one
 * entry per emitted `### Source N` block, numbered by the context's original
 * index. It names where each source came from and fingerprints it, but
 * holds none of its text: evidence is read from the source's current row
 * when it is shown, so text later removed from a source never resurfaces.
 *
 * Retrieval's own manifest describes only the retrieval strings, which sit at
 * the END of `contexts` (the child prepends supplied, Slack, Teams and
 * episodic context after retrieval), so it is aligned to the tail and each
 * entry is trusted only while its fingerprint matches the string at its
 * position. Every other position, a mismatched one, and every position of a
 * run with no retrieval manifest (direct context, failed retrieval) is
 * `other`, with no id or label.
 */
export function proposalSourceManifest(
	contexts: readonly string[],
	emitted: readonly EmittedSource[],
	retrievalManifest: readonly ProposalRetrievalSource[] | undefined,
): ProposalSourceManifestEntryInput[] {
	const described = alignRetrievalManifest(contexts, retrievalManifest);
	return emitted.map(({ index }) => {
		const source = described.get(index);
		return {
			source: index + 1,
			kind: source?.kind ?? "other",
			id: source?.id ?? null,
			contextType: source?.contextType ?? null,
			title: source?.title ?? null,
			sourceName: source?.sourceName ?? null,
			fingerprint: proposalSourceFingerprint(contexts[index] ?? ""),
		};
	});
}

/**
 * Retrieval's manifest entries by the position of the string each one
 * describes, keeping only those whose fingerprint matches that string. A
 * manifest longer than `contexts` cannot be aligned at all.
 */
export function alignRetrievalManifest(
	contexts: readonly string[],
	manifest: readonly ProposalRetrievalSource[] | undefined,
): Map<number, ProposalRetrievalSource> {
	const described = new Map<number, ProposalRetrievalSource>();
	if (!manifest || manifest.length > contexts.length) {
		return described;
	}
	const offset = contexts.length - manifest.length;
	for (const [i, entry] of manifest.entries()) {
		const position = offset + i;
		if (
			entry?.fingerprint ===
			proposalSourceFingerprint(contexts[position] ?? "")
		) {
			described.set(position, entry);
		}
	}
	return described;
}
