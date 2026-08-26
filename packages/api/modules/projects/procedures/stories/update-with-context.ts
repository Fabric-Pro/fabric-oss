import { ORPCError } from "@orpc/client";
import { config } from "@repo/config";
import {
	type FeatureDraftingStage,
	getBoundPromptForAgent,
	getStoryById,
	setLastContextUpdateAt,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import {
	ContextUpdateTruncatedError,
	fetchProjectContextSources,
	runContextUpdate,
} from "@repo/temporal";
import { ACCEPTANCE_HEADING_RE } from "@repo/utils/clean-spec-content";
import { stripInlineDecoration } from "@repo/utils/markdown-heading";
import { z } from "zod";
import {
	Permissions,
	requireOrganizationMembership,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { mergeEntriesInto } from "../../lib/append-attachments-section";
import { enqueuePmSync } from "../../lib/enqueue-pm-sync";
import { extractStoryMediaKeysFromContent } from "../../lib/extract-story-media-keys";
import { logReinjectedAttachments } from "../../lib/log-reinjected-attachments";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";
import { fetchStoryPmComments } from "../shared/pm-comments-context";

/**
 * Catalog coordinates of the kind-scoped "Update using context" instructions
 * (Fizzy #2048). ONE agent key covers both kinds: `storyKind` resolution is
 * exact-match with no cross-kind fallback, so the item's stored kind alone picks
 * the record and there is no kind→agent mapping to keep in sync here. Same shape
 * `maturation_summary` / `bug_maturation_summary` already use.
 *
 * Seeded as `feature_context_update_instructions` and
 * `bug_context_update_instructions` in
 * `packages/database/prisma/seed-prompts-only.ts` — change one and change the
 * other.
 */
const CONTEXT_UPDATE_INSTRUCTIONS_AGENT = "context_update_instructions";
const CONTEXT_UPDATE_INSTRUCTIONS_DOCUMENT_TYPE = "CONTEXT_UPDATE";

/**
 * Wrap the work item's two stored columns into the single markdown document the
 * shared engine edits.
 *
 * The `## Description` / `## Acceptance Criteria` headings are LOAD-BEARING, not
 * presentation: `parseUpdatedDocument` splits the model's reply back on these
 * exact anchors. Drop the acceptance-criteria heading and a bug's returned
 * criteria parse as empty, which is written to `proposedAcceptanceCriteria` — a
 * proposal to wipe the stored column. What makes a bug survive this round trip
 * is the kind-scoped instruction addendum, not a different wrapper.
 */
function buildDocumentMarkdown(
	description: string,
	acceptanceCriteria: string | null | undefined,
): string {
	const desc = description?.trim() || "(empty)";
	if (acceptanceCriteria?.trim()) {
		return `## Description\n\n${desc}\n\n## Acceptance Criteria\n\n${acceptanceCriteria.trim()}`;
	}
	return `## Description\n\n${desc}`;
}

/**
 * The split point and the strippable `## Description` header, anchored exactly
 * as before. These are tested against a single line's DECORATION-STRIPPED form
 * (never against the raw line and never against a normalized whole document),
 * so the anchors stay strict — `stripInlineDecoration` makes a highlighted or
 * bolded heading visible to them instead of the anchors being loosened.
 */
const AC_HEADING_RE = /^##\s+Acceptance\s+Criteria\s*$/i;
const DESCRIPTION_HEADING_RE = /^##\s+Description\s*$/i;

/**
 * Find the first line whose decoration-stripped form matches `pattern`, and
 * return its offsets **into the original text**.
 *
 * Scanning the ORIGINAL lines while tracking a running offset is the whole
 * point: the normalized form of a line is shorter than the line (tags and
 * emphasis characters are deleted, runs of whitespace collapse), so an offset
 * taken from a normalized copy of the document does not map back onto the
 * original string. Callers slice the original with what this returns.
 *
 * `stripInlineDecoration`'s heading-forgery guard means a body line cannot be
 * promoted into heading shape here — `` `## Acceptance Criteria` `` comes back
 * untouched and fails the anchored pattern, so it can never move the boundary.
 */
function findHeadingLine(
	text: string,
	pattern: RegExp,
): { start: number; length: number } | null {
	let start = 0;
	for (const line of text.split("\n")) {
		if (pattern.test(stripInlineDecoration(line))) {
			return { start, length: line.length };
		}
		// +1 for the "\n" consumed by split. A trailing "\r" stays part of the
		// line, so CRLF documents keep correct offsets.
		start += line.length + 1;
	}
	return null;
}

/**
 * Remove the `## Description` header line (decorated or not) from a chunk of
 * the ORIGINAL document, leaving every other byte alone.
 *
 * Mirrors the trailing `\s*\n+` of the regex this replaced: the header is only
 * stripped when a newline follows it, and the whitespace run after it is
 * consumed up to and including its last newline — so a header in the middle of
 * the chunk does not leave a widened blank gap behind.
 */
function stripDescriptionHeading(chunk: string): string {
	const heading = findHeadingLine(chunk, DESCRIPTION_HEADING_RE);
	if (!heading) {
		return chunk;
	}

	let cursor = heading.start + heading.length;
	let lastNewline = -1;
	while (cursor < chunk.length && /\s/.test(chunk[cursor])) {
		if (chunk[cursor] === "\n") {
			lastNewline = cursor;
		}
		cursor += 1;
	}
	if (lastNewline === -1) {
		return chunk;
	}

	return chunk.slice(0, heading.start) + chunk.slice(lastNewline + 1);
}

/**
 * Split the AI-updated document back into description and acceptance criteria.
 * Uses the `## Acceptance Criteria` header as the split point. Any content
 * before an explicit `## Description` header (e.g. an "⚠️ Ambiguous Recent
 * Context" block prepended by the model) is preserved as part of the
 * description so conflict flags survive the round-trip.
 *
 * The header lookups tolerate inline decoration — a heading the user
 * highlighted in the editor (`## <mark data-color="…">Acceptance Criteria</mark>`)
 * or bolded still splits the document. Decoration is stripped for MATCHING
 * ONLY; both stored columns are sliced out of the original document, so what is
 * written back is byte-for-byte what the user wrote.
 *
 * Exported for unit test.
 */
export function parseUpdatedDocument(
	doc: string,
	hadAcceptanceCriteria: boolean,
): { description: string; acceptanceCriteria?: string } {
	// The strict anchor first — it matches the heading THIS file wrote, and
	// keeping it strict is what stops a body line moving the boundary.
	//
	// The reply comes back through a model, though, and models demote and
	// re-word headings (`### Acceptance Criteria`, a trailing colon). Without
	// the fallback that reply takes the branch below: every criterion stays in
	// `description` AND the column comes back `""` — a proposal to WIPE
	// criteria the user never asked to remove, which is the destructive half of
	// the same defect the shared splitter documents. Only consulted when the
	// story HAS criteria to lose, so a story that genuinely has none is
	// unaffected, and a model that deliberately removed the section still
	// clears the column (no acceptance heading survives anywhere).
	const acHeading =
		findHeadingLine(doc, AC_HEADING_RE) ??
		(hadAcceptanceCriteria
			? findHeadingLine(doc, ACCEPTANCE_HEADING_RE)
			: null);

	if (acHeading) {
		const before = doc.slice(0, acHeading.start);
		const after = doc.slice(acHeading.start + acHeading.length);
		return {
			description: stripDescriptionHeading(before).trim(),
			acceptanceCriteria: after.trim(),
		};
	}

	return {
		description: stripDescriptionHeading(doc).trim(),
		acceptanceCriteria: hadAcceptanceCriteria ? "" : undefined,
	};
}

/**
 * Diff the `story-media/` keys in the prior story description against the
 * AI-confirmed document. Any key present before but absent after is
 * re-signed via the storage provider and reinjected as a markdown image
 * under an `## Attachments` H2 at the end of the document so the asset
 * reference is preserved.
 *
 * The function is idempotent: a second invocation with the
 * already-reinjected description as input finds `droppedKeys === []` and
 * returns the input unchanged. Failed re-signs are skipped — the
 * extractor will still pick up the embedded `story-media/` substring on
 * the next mount, so the asset reference survives even when the URL
 * becomes unreachable. The key-prefix safety check belt-and-
 * braces the upstream tenant filter: any key whose path does not match
 * `story-media/{projectId}/{storyId}/` is logged at `error` and dropped.
 */
async function reinjectDroppedAttachments(params: {
	priorDescription: string | null | undefined;
	incomingDescription: string;
	projectId: string;
	storyId: string;
	draftingStage: FeatureDraftingStage | null;
}): Promise<string> {
	const {
		priorDescription,
		incomingDescription,
		projectId,
		storyId,
		draftingStage,
	} = params;

	const oldKeys = extractStoryMediaKeysFromContent(priorDescription);
	if (oldKeys.length === 0) {
		return incomingDescription;
	}

	const newKeys = new Set(
		extractStoryMediaKeysFromContent(incomingDescription),
	);
	const droppedKeys = oldKeys.filter((key) => !newKeys.has(key));
	if (droppedKeys.length === 0) {
		return incomingDescription;
	}

	const expectedPrefix = `story-media/${projectId}/${storyId}/`;
	const safeDroppedKeys: string[] = [];
	for (const key of droppedKeys) {
		if (key.startsWith(expectedPrefix)) {
			safeDroppedKeys.push(key);
		} else {
			logger.error(
				"[stage-transition] dropped attachment key failed prefix safety check",
				{
					storyId,
					projectId,
					surface: "update-with-context",
					key,
					expectedPrefix,
				},
			);
		}
	}

	if (safeDroppedKeys.length === 0) {
		return incomingDescription;
	}

	const storageProvider = getStorageProvider();
	const bucket = config.storage.bucketNames.projectContexts;
	const signed = await Promise.allSettled(
		safeDroppedKeys.map((key) =>
			storageProvider.getSignedUrl(key, { bucket, expiresIn: 3600 }),
		),
	);

	const reinjectedLines: string[] = [];
	const reinjectedKeys: string[] = [];
	for (let i = 0; i < safeDroppedKeys.length; i += 1) {
		const result = signed[i];
		const key = safeDroppedKeys[i];
		if (result.status === "fulfilled") {
			reinjectedLines.push(`![](${result.value})`);
			reinjectedKeys.push(key);
		} else {
			logger.error(
				"[stage-transition] failed to re-sign dropped attachment URL",
				{
					storyId,
					projectId,
					surface: "update-with-context",
					key,
					err:
						result.reason instanceof Error
							? result.reason.message
							: String(result.reason),
				},
			);
		}
	}

	if (reinjectedLines.length === 0) {
		return incomingDescription;
	}

	logReinjectedAttachments({
		storyId,
		projectId,
		surface: "update-with-context",
		targetStage: null,
		draftingStage,
		droppedKeys: reinjectedKeys,
	});

	// Hand the merge to the shared helper rather than deciding here. This path
	// used to append `## Attachments` unconditionally, so every apply that
	// re-injected a dropped image key opened ANOTHER section and a feature taken
	// through the flow repeatedly accumulated duplicate headings. The helper
	// already owns that decision — and owns it decoration-aware, so a heading the
	// user bolded or highlighted still counts as the same section.
	return mergeEntriesInto(incomingDescription, reinjectedLines.join("\n"));
}

/**
 * AUTHORIZATION: Uses canEditProject() - verifies org membership + editor role.
 *
 * Fetches recent meeting transcripts and Teams/Slack messages relevant to this
 * feature (since it was created), runs an AI pass to detect relevant changes,
 * and returns a preview for the user to review before applying.
 *
 * This is a two-phase flow:
 *  Phase 1 (preview=true):  Returns proposed changes WITHOUT saving. The caller
 *                           shows a diff dialog for user review.
 *  Phase 2 (preview=false): Applies the pre-computed changes and saves to DB.
 */
export const updateWithContextProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories/{storyId}/update-with-context",
		tags: ["Projects", "Features"],
		summary: "Update feature document with latest context",
		description:
			"Reviews recent meeting transcripts and team messages to update the feature document with new information",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
			/**
			 * When true (default), returns the proposed changes without saving.
			 * When false, applies the provided pre-computed changes to the story.
			 */
			preview: z.boolean().default(true),
			/**
			 * Current editor content sent by the client during preview so the AI
			 * works against what the user sees, not the last-saved DB state.
			 */
			currentDescription: z.string().optional(),
			currentAcceptanceCriteria: z.string().nullable().optional(),
			/**
			 * Pre-computed values to apply (only used when preview=false).
			 * This avoids re-running the expensive AI call on confirm.
			 */
			confirmedDescription: z.string().optional(),
			confirmedAcceptanceCriteria: z.string().nullable().optional(),
			/**
			 * Story version at the time the preview was generated.
			 * Used to detect concurrent edits between preview and apply.
			 */
			storyVersion: z.number().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		// `resolveOrganizationId` hands back the caller-supplied id VERBATIM — it
		// performs no membership check. This procedure now reads an ORG-scoped
		// prompt binding with that id (the kind-scoped instruction addendum
		// below), and it already passes it to the model resolver, so an
		// unverified id would reach tenant-authored content either way. Same
		// guard, same placement as `enhance-feature.ts` and `resolve-story-prompt.ts`.
		if (organizationId) {
			await requireOrganizationMembership(organizationId, user.id);
		}

		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			throw new ORPCError("NOT_FOUND", {
				message: "Feature not found",
			});
		}

		// ── Phase 2: Apply pre-confirmed changes ────────────────────────────────
		if (!input.preview) {
			if (
				input.confirmedDescription === undefined ||
				input.confirmedDescription === null
			) {
				throw new ORPCError("BAD_REQUEST", {
					message:
						"confirmedDescription is required when preview=false",
				});
			}

			// Reject apply without a preview baseline — callers must provide the
			// storyVersion returned by the preview phase so we can detect concurrent edits.
			if (input.storyVersion === undefined) {
				throw new ORPCError("BAD_REQUEST", {
					message: "storyVersion is required when preview=false",
				});
			}

			// Attachment-preservation guard.
			// The AI document rewriter occasionally strips inline
			// `![](…/story-media/…)` images even with the explicit preservation
			// clause in the system prompt. Diff the keys present in the
			// pre-update description against the keys in the user-confirmed
			// document; any key that survives the diff is reinjected as a
			// markdown image under an `## Attachments` section so the asset
			// reference never falls out of the saved description.
			//
			// Recovery action, not an error (per
			// `fabric/standards/global/error-handling.md`): observability picks
			// up the structured `warn` emitted by `logReinjectedAttachments`;
			// the user is not blocked.
			const finalDescription = await reinjectDroppedAttachments({
				priorDescription: story.description,
				incomingDescription: input.confirmedDescription,
				projectId: input.projectId,
				storyId: input.storyId,
				draftingStage: story.draftingStage,
			});

			// updateStory checks expectedVersion inside its transaction,
			// closing the TOCTOU gap between our read and the write.
			const updatedStory = await updateStory(
				input.storyId,
				input.projectId,
				{
					description: finalDescription,
					...(input.confirmedAcceptanceCriteria !== undefined && {
						acceptanceCriteria: input.confirmedAcceptanceCriteria,
					}),
				},
				{
					changedBy: user.id,
					changeDescription: "Updated with latest context",
					userId: user.id,
					organizationId,
					expectedVersion: input.storyVersion,
					lastEditedSource: "AI_MATURATION",
					lastEditedByName: user.name ?? null,
				},
			);

			// Freshly rebuilt by a context path → reset the staleness clock (#2/#3).
			await setLastContextUpdateAt({
				userStoryId: input.storyId,
				projectId: input.projectId,
			});

			enqueuePmSync({
				itemId: input.storyId,
				itemType: "story",
				projectId: input.projectId,
				userId: user.id,
				triggerSource: "manual-edit",
			}).catch((err) => {
				logger.warn("enqueuePmSync failed", {
					storyId: input.storyId,
					err: err instanceof Error ? err.message : String(err),
				});
			});

			return {
				applied: true,
				story: stripInternalStoryFields(updatedStory),
				hasRelevantContext: true,
				summary: "Context update applied successfully.",
				needsHumanResolution: false,
				proposedDescription: null,
				proposedAcceptanceCriteria: null,
				contextSourcesUsed: {
					transcriptCount: 0,
					teamsCount: 0,
					slackCount: 0,
					huddleNotesCount: 0,
					commentCount: 0,
				},
			};
		}

		// ── Phase 1: Fetch context and run AI preview ────────────────────────────

		const currentDescription =
			input.currentDescription ?? story.description ?? "";
		const currentAcceptanceCriteria =
			input.currentAcceptanceCriteria !== undefined
				? input.currentAcceptanceCriteria
				: story.acceptanceCriteria;

		const documentMarkdown = buildDocumentMarkdown(
			currentDescription,
			currentAcceptanceCriteria,
		);

		// Project context (RAG + Teams/Slack), the linked PM ticket's comments, and
		// the kind-scoped instruction addendum are fetched in parallel. Comment
		// retrieval is supplemental: a rejection degrades to no comments and never
		// blocks the AI Update.
		const [sourcesSettled, commentSettled, instructionsSettled] =
			await Promise.allSettled([
				fetchProjectContextSources({
					projectId: input.projectId,
					storyId: input.storyId,
					userId: user.id,
					organizationId,
					baselineDate: story.createdAt,
					specMarkdown: documentMarkdown,
				}),
				fetchStoryPmComments({
					projectId: input.projectId,
					story: {
						externalId: story.externalId,
						externalUrl: story.externalUrl,
					},
					userId: user.id,
					organizationId,
				}),
				// Fizzy #2048: the kind comes from the row we just loaded, never from
				// the client — a reviewer can convert an item from one surface while
				// another surface holds a stale copy. Exact-match on `storyKind`, so a
				// kind with nothing bound resolves to nothing rather than to the other
				// kind's record.
				getBoundPromptForAgent({
					agentName: CONTEXT_UPDATE_INSTRUCTIONS_AGENT,
					documentType: CONTEXT_UPDATE_INSTRUCTIONS_DOCUMENT_TYPE,
					storyKind: story.kind,
					userId: user.id,
					organizationId,
				}),
			]);

		if (sourcesSettled.status === "rejected") {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "Failed to fetch project context.",
			});
		}
		const sources = sourcesSettled.value;
		const commentItems =
			commentSettled.status === "fulfilled" ? commentSettled.value : [];
		const contextItems = [...sources.contextItems, ...commentItems];

		if (instructionsSettled.status === "rejected") {
			// Recovery action, not an error: the update still runs on the engine's
			// own system prompt. Logged because a lookup that fails is NOT the same
			// as a kind with nothing bound, and only the log tells them apart.
			logger.warn(
				"[UpdateWithContext] kind-scoped instruction lookup failed",
				{
					storyId: input.storyId,
					projectId: input.projectId,
					storyKind: story.kind,
					err:
						instructionsSettled.reason instanceof Error
							? instructionsSettled.reason.message
							: String(instructionsSettled.reason),
				},
			);
		}
		// Nothing bound for this kind → no addendum. The engine keeps its existing
		// system prompt; the other kind's instructions are never substituted.
		const instructionAddendum =
			instructionsSettled.status === "fulfilled"
				? instructionsSettled.value?.version?.content?.trim() ||
					undefined
				: undefined;

		// Fizzy #2048 (R13). A miss here is the failure mode that looks like
		// success: an environment whose prompts seed has not run produces
		// kind-agnostic updates forever, and every test still passes. Only the
		// rejected lookup was logged, so a genuine "nothing bound" was silent.
		// Keys and kinds only — never the addendum text.
		if (instructionsSettled.status === "fulfilled") {
			logger.info("[UpdateWithContext] instruction addendum resolved", {
				projectId: input.projectId,
				storyId: input.storyId,
				storyKind: story.kind,
				documentType: CONTEXT_UPDATE_INSTRUCTIONS_DOCUMENT_TYPE,
				agentName: CONTEXT_UPDATE_INSTRUCTIONS_AGENT,
				outcome: instructionAddendum ? "hit" : "miss",
				promptKey: instructionsSettled.value?.key ?? null,
				promptSource: "bound",
			});
		}

		let aiResult: Awaited<ReturnType<typeof runContextUpdate>>;
		try {
			aiResult = await runContextUpdate({
				title: story.title,
				baselineDate: story.createdAt,
				documentMarkdown,
				contextItems,
				userId: user.id,
				organizationId,
				projectId: input.projectId,
				...(instructionAddendum ? { instructionAddendum } : {}),
			});
		} catch (error) {
			if (error instanceof ContextUpdateTruncatedError) {
				throw new ORPCError("INTERNAL_SERVER_ERROR", {
					message:
						"The document is too large for the configured AI model's output limit — the update was truncated before completion. Try a model with a larger output limit or split the document.",
				});
			}
			throw error;
		}

		if (!aiResult) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message:
					"AI provider not configured or update failed. Please check your AI settings.",
			});
		}

		if (!aiResult.hasRelevantContext) {
			return {
				applied: false,
				story: null,
				storyVersion: story.version,
				hasRelevantContext: false,
				summary: aiResult.summary,
				needsHumanResolution: aiResult.needsHumanResolution,
				proposedDescription: null,
				proposedAcceptanceCriteria: null,
				contextSourcesUsed: {
					transcriptCount: sources.transcriptCount,
					teamsCount: sources.teamsCount,
					slackCount: sources.slackCount,
					huddleNotesCount: sources.huddleNotesCount,
					commentCount: commentItems.length,
				},
			};
		}

		const parsed = parseUpdatedDocument(
			aiResult.updatedDocument,
			Boolean(currentAcceptanceCriteria?.trim()),
		);

		return {
			applied: false,
			story: null,
			storyVersion: story.version,
			hasRelevantContext: true,
			summary: aiResult.summary,
			needsHumanResolution: aiResult.needsHumanResolution,
			proposedDescription: parsed.description,
			proposedAcceptanceCriteria: parsed.acceptanceCriteria ?? null,
			contextSourcesUsed: {
				transcriptCount: sources.transcriptCount,
				teamsCount: sources.teamsCount,
				slackCount: sources.slackCount,
				huddleNotesCount: sources.huddleNotesCount,
				commentCount: commentItems.length,
			},
		};
	});
