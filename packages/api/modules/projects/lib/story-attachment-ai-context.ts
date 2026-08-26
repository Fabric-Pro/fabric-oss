/**
 * Turns a work item's context-only attachments into prompt-ready entries.
 *
 * ── What this is ────────────────────────────────────────────────────────────
 * The single place a `StoryAttachment`'s file content is allowed to become
 * prompt text. Two surfaces consume it and neither builds its own version:
 *
 * - `enhanceFeatureWithAI` (maturation, Clean Spec refresh, stage transitions)
 *   imports it directly — it already runs server-side.
 * - The ticket AI Assistant reaches it through
 *   `resolve-story-attachment-context-for-agent`, because the langgraph agent is
 *   deliberately stateless and cannot touch the database or storage itself.
 *
 * ── The gates, in order ─────────────────────────────────────────────────────
 * 1. Live only — `deletedAt: null`. A soft-deleted file is gone as far as the
 *    model is concerned.
 * 2. `UNLOCKED` only. LOCKED is the default and means "protected asset"; its
 *    content never reaches a prompt. This is the gate the prompt clause in
 *    `@repo/agent-prompts` promises the model is enforced.
 * 3. Text-bearing MIME only, per the shared eligible set. An eligible-looking
 *    file that is actually an image stays out.
 *
 * ── Why the text is cached ──────────────────────────────────────────────────
 * Extraction is the expensive step and attachment files are immutable — the
 * storage key is unique per upload and nothing rewrites it. So the first AI run
 * that needs a file extracts it and writes the result back; every later run
 * reads the column. Extraction deliberately does NOT happen at upload: rows that
 * predate this feature would still need a populate-on-miss path, and adding an
 * upload-time site would mean maintaining two.
 *
 * ── What this does NOT check ────────────────────────────────────────────────
 * Authorization. It takes a bare `storyId` and reads that story's attachments,
 * so the CALLER must have already proven the story belongs to a project the
 * user may read. Both callers do: `enhanceFeature` gates on
 * `getStoryById(storyId, projectId)` before reaching here, and the agent
 * procedure runs the same gate plus an org-context check. A third caller that
 * skips that gate turns this into an IDOR — pass an authorized story id, never
 * a client-supplied one.
 *
 * ── Failure posture ─────────────────────────────────────────────────────────
 * One unreadable file must not fail a ticket-level AI operation. A missing
 * object or a parse failure drops that attachment from the result and logs it;
 * the run proceeds with whatever else resolved. The model working without one
 * reference file beats the user's maturation run erroring out because a PDF was
 * malformed.
 *
 * Note what is NOT a bound here: `extractionDeadlineMs` and `maxInflatedBytes`
 * are passed to the extractor but ignored by every format this resolver accepts
 * (only the workbook walk reads them, and workbooks are excluded). A pathological
 * file is bounded by the upload size cap and by the character budget applied
 * after extraction — not by a timeout.
 */

import { config } from "@repo/config";
import { db } from "@repo/database";
import { logger } from "@repo/logs";
import { extractionFactory } from "@repo/rag";
import { downloadFile } from "@repo/storage";
import {
	applyAiChatTextBudget,
	buildAiChatAttachmentEntry,
	hasAiChatTextBudgetMarker,
} from "@repo/utils/ai-chat-attachment";
import { isAiContextEligibleAttachmentMime } from "@repo/utils/story-attachment-ai-context";
import { resolveAiChatAttachmentLimits } from "../../ai/lib/ai-chat-attachment-limits";

/** Tenant context for extraction model resolution and usage attribution. */
export interface StoryAttachmentAiContextTenant {
	userId: string;
	organizationId: string | null;
}

/**
 * Envelope-wrapped entries for a story's context-only text attachments, in
 * upload order. Empty when the story has none — which is the common case, and
 * callers must treat it as "add nothing" rather than "add an empty section".
 */
export async function resolveStoryAttachmentAiContexts(
	storyId: string,
	tenant: StoryAttachmentAiContextTenant,
): Promise<string[]> {
	const rows = await db.storyAttachment.findMany({
		where: {
			storyId,
			deletedAt: null,
			designation: "UNLOCKED",
		},
		orderBy: { createdAt: "asc" },
		select: {
			id: true,
			filename: true,
			mimeType: true,
			storageKey: true,
			extractedText: true,
		},
	});

	const eligible = rows.filter((row) =>
		isAiContextEligibleAttachmentMime(row.mimeType),
	);
	if (eligible.length === 0) {
		return [];
	}

	// Serial on purpose. Extraction runs inside the API request and inflates in
	// memory (a 25 MB upload can expand far beyond that), so N concurrent
	// extractions scale the process's peak footprint by N. The cost is bounded
	// anyway: only the first run for a given file extracts, and every run after
	// reads the cache. Latency here would be worth buying back with bounded
	// concurrency, not unbounded — and the repo has no pool helper to do it with.
	const totalBudget =
		resolveAiChatAttachmentLimits().extractedTextBudgetChars;
	const entries: string[] = [];
	const omitted: string[] = [];
	let spent = 0;

	for (const row of eligible) {
		const text =
			reusableCachedText(row.extractedText, totalBudget) ??
			(await extractAndCache(row, tenant, storyId));
		if (!text) {
			continue;
		}

		// The per-file budget bounds ONE attachment; this bounds the story. A
		// work item accepts 20 attachments, so per-file alone would allow
		// 20x the budget into a single prompt — and unlike the chat path this
		// text is persistent, riding along on every maturation run and every
		// assistant message rather than one pasted turn.
		//
		// The first eligible file is always admitted, because it is already
		// individually bounded and its truncation marker pushes it a few dozen
		// chars past the ceiling. Comparing it against the same number would
		// drop every single-large-attachment story outright — the exact failure
		// this budget exists to replace with honest truncation.
		if (entries.length > 0 && spent + text.length > totalBudget) {
			omitted.push(row.filename);
			continue;
		}
		spent += text.length;

		// The envelope builder is the only place the delimiter is written and
		// the only place a filename or body is neutralized. Building the entry
		// here instead would be a fifth un-guarded path to the model.
		entries.push(buildAiChatAttachmentEntry(row.filename, text));
	}

	if (omitted.length > 0) {
		// Say what was dropped, for the same reason a truncated file carries a
		// marker: a model that silently receives 3 of 8 attachments will answer
		// as though it saw all 8.
		logger.info("[StoryAttachmentAiContext] story budget exhausted", {
			storyId,
			delivered: entries.length,
			omitted: omitted.length,
		});
		entries.push(
			buildAiChatAttachmentEntry(
				"omitted-attachments",
				`The following attachments were NOT included because this work item's attachment text exceeded the per-request budget: ${omitted.join(", ")}. Do not describe or infer their contents.`,
			),
		);
	}

	return entries;
}

/**
 * The cached text, or null when it should be extracted again.
 *
 * Files are immutable, so the cache would normally never expire. The one thing
 * that does change underneath it is the budget: `extractedTextBudgetChars` is
 * operator-tunable, and text cut under a smaller value would otherwise be
 * served as though it were the whole document, forever — raising the limit
 * would silently do nothing for every file already extracted.
 *
 * So re-extract only when both are true: the cached copy is marked truncated,
 * AND it is shorter than the budget now allows. A truncated copy that still
 * fills the current budget has nothing to gain from the round trip.
 */
function reusableCachedText(
	cached: string | null,
	budget: number,
): string | null {
	if (!cached) {
		return null;
	}
	if (hasAiChatTextBudgetMarker(cached) && cached.length < budget) {
		return null;
	}
	return cached;
}

/**
 * Extract one attachment and persist the result. Returns null on any failure —
 * see the failure posture above.
 */
async function extractAndCache(
	row: {
		id: string;
		filename: string;
		mimeType: string;
		storageKey: string;
	},
	tenant: StoryAttachmentAiContextTenant,
	storyId: string,
): Promise<string | null> {
	try {
		const downloaded = await downloadFile(row.storageKey, {
			bucket: config.storage.bucketNames.projectContexts,
		});

		// Of the formats this resolver accepts, `local-text`, `local-pdf`,
		// `local-docx` and `local-html` ignore every bound in `_options`,
		// `extractionDeadlineMs` included — for those the budget is enforced at
		// the caller below. (`local-text` now reads one non-bound key,
		// `mimeType`, to decide whether to strip script bodies; it still ignores
		// the bounds.) `local-xlsx` is the exception: it reads
		// the workbook walk caps and the character budget itself, so pass the
		// full bound set (not just budget/inflation/deadline) or a large sheet
		// walks under the extractor's compiled defaults instead of the operator's
		// configured limits.
		const limits = resolveAiChatAttachmentLimits();
		const result = await extractionFactory.extract(
			downloaded.data,
			row.filename,
			row.mimeType,
			{
				strategy: "local-only",
				userId: tenant.userId,
				organizationId: tenant.organizationId ?? undefined,
				extractionOptions: {
					extractedTextBudgetChars: limits.extractedTextBudgetChars,
					maxInflatedBytes: limits.maxInflatedBytes,
					extractionDeadlineMs: limits.extractionDeadlineMs,
					maxSheets: limits.maxSheets,
					maxRows: limits.maxRows,
					maxCells: limits.maxCells,
				},
			},
		);

		// So the budget is enforced HERE, not by the extractor. Without this a
		// 300 KB transcript caches whole, then the story budget drops it
		// entirely on every run — named in the omission notice and never read,
		// permanently, because nothing marks it truncated so nothing re-extracts
		// it. Truncating with a marker turns "silently dropped forever" into
		// "shortened, and the model is told".
		//
		// Applied at the caller rather than inside the extractors for the same
		// reason the chat path does it: the Temporal ingestion activities share
		// those extractors and must keep receiving whole documents.
		const budgeted = applyAiChatTextBudget(
			result.text ?? "",
			limits.extractedTextBudgetChars,
		);
		const text = budgeted.text.trim();
		if (!text) {
			// A file that parsed cleanly and yielded nothing is not an error,
			// but it is also not worth caching as "" — leaving the column null
			// lets a later run retry after, say, an OCR provider is configured.
			logger.info(
				"[StoryAttachmentAiContext] extraction yielded no text",
				{
					storyId,
					attachmentId: row.id,
					mimeType: row.mimeType,
				},
			);
			return null;
		}

		await db.storyAttachment.update({
			where: { id: row.id },
			data: { extractedText: text, extractedAt: new Date() },
		});

		return text;
	} catch (error) {
		logger.warn("[StoryAttachmentAiContext] extraction failed; skipping", {
			storyId,
			attachmentId: row.id,
			mimeType: row.mimeType,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
}
