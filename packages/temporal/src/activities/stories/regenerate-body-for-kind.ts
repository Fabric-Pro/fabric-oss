/**
 * Activity: rewrite a converted work item's body through its NEW type's
 * template, and persist it.
 *
 * Runs after a BUG ↔ FEATURE conversion has already flipped the stored row
 * (Fizzy #2048). It reads the kind back off that row — never off its input — and
 * redrafts the body through the template bound for it, so a bug converted to a
 * feature stops carrying bug sections and vice versa.
 *
 * This is the one AI rewrite in the product that lands with nobody looking at
 * the diff first, so three mechanisms stand in for that review, in this order:
 *   1. the prior body is snapshotted as a `FeatureVersion` before the write, so
 *      the pre-conversion content is always recoverable;
 *   2. a redraft that reports the model did not run writes NOTHING;
 *   3. a redraft that empties or collapses the body writes NOTHING and records
 *      why.
 * The write itself runs under the row's monotonic version, so a redraft that
 * lost a race — to another conversion or to a human edit — is discarded rather
 * than applied over newer content.
 */

import { config } from "@repo/config";
import {
	buildFabricStoryUrl,
	createFeatureVersion,
	db,
	type FeatureDraftingStage,
	getStoryById,
	type LastEditSource,
	placeFabricBackLink,
	type StoryKind,
	StoryVersionConflictError,
	updateStory,
} from "@repo/database";
import { logger } from "@repo/logs";
import { getStorageProvider } from "@repo/storage";
import { heartbeat } from "@temporalio/activity";
import {
	type DraftBodyByKindResolution,
	draftBodyByKind,
} from "../../lib/create-story-from-proposal";
import { detectContentFloorBreach } from "../../lib/structure-guards";
import { extractStoryMediaKeysFromContent } from "../pm-integration/story-sync-media";

/**
 * Names this path in the canonical resolution log when the caller supplies
 * nothing. The marker normally travels in the workflow arguments — the entry
 * point is the one NFR1 dimension this activity cannot derive, because every
 * caller of this workflow looks identical from in here.
 */
const ENTRY_POINT = "typeConversionRegeneration";

/**
 * TTL for the signed URLs of reinjected inline images. One hour, matching the
 * in-app rewrite paths (`enhance-feature.ts`, `reevaluate-bug.ts`): the editor
 * re-signs from the stored key on next mount, so the URL only has to survive
 * long enough to be saved.
 */
const REINJECTED_MEDIA_URL_TTL_SECONDS = 3600;

export interface RegenerateBodyForKindInput {
	storyId: string;
	projectId: string;
	/**
	 * Tenant of the conversion. Forwarded to `draftBodyByKind` so the template
	 * binding and the AI model settings resolve in the ORGANIZATION's scope —
	 * dropping it does not fail, it silently resolves the personal-context
	 * prompt instead, which is the quiet way an org's customized template stops
	 * being the one that runs.
	 */
	organizationId?: string | null;
	/** The user whose conversion triggered this. Tenant scope, not authorship. */
	userId: string;
	/**
	 * Which surface asked for this rewrite, for the resolution log's "from which
	 * entry point" dimension. Defaults to the conversion, which is the only
	 * caller today.
	 */
	entryPoint?: string;
}

export type RegenerateBodyForKindStatus =
	/** The regenerated body was persisted. */
	| "regenerated"
	/** The row disappeared between the conversion and this activity. */
	| "story_not_found"
	/** No template bound, or the model call failed — prior body left intact. */
	| "model_did_not_run"
	/** The redraft emptied or collapsed the body — prior body left intact. */
	| "below_content_floor"
	/** Another writer moved the row first — this redraft is stale, discarded. */
	| "stale";

export interface RegenerateBodyForKindResult {
	status: RegenerateBodyForKindStatus;
	/** Machine reason for a refusal. Never user-authored text. */
	reason?: string;
	/** The kind the body was regenerated for, read off the stored row. */
	kind?: StoryKind;
}

/**
 * The author of the body being replaced — NOT the actor who triggered the
 * conversion.
 *
 * Version history is the whole safety net here, so it has to read correctly once
 * an AI joins the writer set: attributing the pre-conversion snapshot to the
 * converting user would show that user's name against content they never wrote
 * and an AI has now replaced.
 *
 * `UserStory` carries `lastEditedByName` (a display name) and
 * `lastEditedSource`, but no last-editor id, so the id that can be attributed
 * honestly is the item's own author. When the last content edit came from an AI
 * path there is no human author at all and the snapshot carries none.
 */
function priorBodyAuthorId(story: {
	createdById: string;
	lastEditedSource: LastEditSource | null;
}): string | null {
	if (
		story.lastEditedSource === "AI_BACKLOG_UPDATE" ||
		story.lastEditedSource === "AI_MATURATION"
	) {
		return null;
	}
	return story.createdById;
}

/**
 * Re-append any `story-media/` keys the model dropped from the rewrite, as an
 * `## Attachments` section of signed image links.
 *
 * `draftBodyByKind` does no media handling of its own — it was built for the
 * non-persisting proposal preview. Once its output is written to a row, the
 * inline images the user pasted have to survive, so this mirrors the recovery
 * step `enhance-feature.ts` and `reevaluate-bug.ts` run after their model call
 * and before their persisted write. Best-effort throughout: a key that will not
 * sign is logged and skipped, never fatal.
 */
async function reinjectDroppedMedia({
	priorDescription,
	nextDescription,
	projectId,
	storyId,
}: {
	priorDescription: string | null;
	nextDescription: string;
	projectId: string;
	storyId: string;
}): Promise<string> {
	const priorKeys = extractStoryMediaKeysFromContent(priorDescription ?? "");
	if (priorKeys.length === 0) {
		return nextDescription;
	}
	const keptKeys = new Set(extractStoryMediaKeysFromContent(nextDescription));
	const droppedKeys = priorKeys.filter((key) => !keptKeys.has(key));
	if (droppedKeys.length === 0) {
		return nextDescription;
	}

	// Defense in depth: every reinjected key MUST belong to this work item's own
	// keyspace. The keys came out of the stored description, which the tenant
	// filter already validated, so an out-of-prefix key should be impossible —
	// skipping and logging keeps the path safe if that invariant ever drifts.
	const expectedPrefix = `story-media/${projectId}/${storyId}/`;
	const safeKeys = droppedKeys.filter((key) => {
		if (key.startsWith(expectedPrefix)) {
			return true;
		}
		logger.error(
			"[regenerateBodyForKind] skipped reinject of out-of-prefix key",
			{ storyId, projectId, key, expectedPrefix },
		);
		return false;
	});
	if (safeKeys.length === 0) {
		return nextDescription;
	}

	const storageProvider = getStorageProvider();
	const bucket = config.storage.bucketNames.projectContexts;
	const signed = await Promise.allSettled(
		safeKeys.map((key) =>
			storageProvider
				.getSignedUrl(key, {
					bucket,
					expiresIn: REINJECTED_MEDIA_URL_TTL_SECONDS,
				})
				.then((url) => ({ key, url })),
		),
	);

	// Pair each result back to its key so the recovery log reports only the keys
	// that actually landed in the persisted body.
	const reinjected: { key: string; url: string }[] = [];
	signed.forEach((result, index) => {
		if (result.status === "fulfilled") {
			reinjected.push(result.value);
			return;
		}
		logger.error(
			"[regenerateBodyForKind] failed to sign dropped attachment",
			{
				storyId,
				projectId,
				key: safeKeys[index],
				error:
					result.reason instanceof Error
						? result.reason.message
						: String(result.reason),
			},
		);
	});
	if (reinjected.length === 0) {
		return nextDescription;
	}

	logger.warn("[regenerateBodyForKind] reinjected dropped inline images", {
		storyId,
		projectId,
		droppedKeyCount: reinjected.length,
	});
	return [
		nextDescription,
		"",
		"## Attachments",
		"",
		...reinjected.map(({ url }) => `![](${url})`),
	].join("\n");
}

export async function regenerateBodyForKindActivity(
	input: RegenerateBodyForKindInput,
): Promise<RegenerateBodyForKindResult> {
	// Keep the activity live across the ~minute-long model call; heartbeatTimeout
	// is the liveness gate, not startToCloseTimeout.
	heartbeat("regenerate-start");
	const hb = setInterval(() => {
		try {
			heartbeat("regenerating");
		} catch {
			// heartbeat throws only outside an activity context; ignore.
		}
	}, 15_000);

	const entryPoint = input.entryPoint ?? ENTRY_POINT;

	try {
		const story = await getStoryById(input.storyId, input.projectId);
		if (!story) {
			logger.warn("[regenerateBodyForKind] work item not found", {
				storyId: input.storyId,
				projectId: input.projectId,
			});
			return { status: "story_not_found" };
		}

		// The only kind that matters: the one on the stored row, read at the
		// moment the rewrite runs. The conversion has already flipped it.
		const kind: StoryKind = story.kind;

		/**
		 * THE STALE-WRITE GUARD IS THE ROW VERSION, NOT THE KIND. Kind has two
		 * values, so a double toggle (FEATURE → BUG → FEATURE → BUG) hands an
		 * in-flight workflow back the value it read, and a kind-based
		 * compare-and-set would pass while writing a body drafted two
		 * conversions ago. The version only ever moves forward, so it also
		 * discards a redraft that lost a race to a concurrent human edit.
		 */
		const expectedVersion = story.version ?? 1;

		const redraft = await draftBodyByKind({
			projectId: input.projectId,
			// Both halves of the tenant, unchanged, all the way down.
			organizationId: input.organizationId,
			userId: input.userId,
			kind,
			title: story.title,
			description: story.description ?? undefined,
			acceptanceCriteria: story.acceptanceCriteria ?? undefined,
			storyId: input.storyId,
			entryPoint,
		});

		/**
		 * The canonical resolution line, same field set as
		 * `stories.resolvePrompt` and the backlog analyzer's template lookup, so
		 * one query answers "which template rewrote this item, and did it land".
		 * Keys and kinds only — never the resolved prompt content.
		 */
		const logResolution = (
			outcome: "hit" | "miss" | "refused",
			resolution: DraftBodyByKindResolution,
			detail?: Record<string, unknown>,
		) => {
			logger.info("[regenerateBodyForKind] resolved", {
				projectId: input.projectId,
				storyId: input.storyId,
				storyKind: kind,
				documentType: resolution.documentType,
				agentName: resolution.agentName,
				entryPoint,
				outcome,
				promptKey: resolution.promptKey,
				promptSource: resolution.promptSource,
				...detail,
			});
		};

		// (2) The model did not run — no bound template, or the call fell back.
		// `aiDrafted: false` is the ONLY signal for that: a non-null model
		// response sets it true whatever the response contains, which is exactly
		// why the content floor below is a separate check and not an alternative
		// to this one.
		if (!redraft.aiDrafted) {
			logResolution("miss", redraft.resolution, {
				reason: "model_did_not_run",
			});
			return {
				status: "model_did_not_run",
				reason: "model_did_not_run",
				kind,
			};
		}

		/**
		 * (3) The KIND-AGNOSTIC content floor, and ONLY the kind-agnostic floor.
		 *
		 * Fizzy #2048: the section-signature rules inside
		 * `detectDestructiveRewrite` (`bug_sections_dropped`,
		 * `feature_sections_dropped`, `cross_type_reformat`) must NEVER be added
		 * to this path, in any form — not by calling that function, and not by
		 * re-implementing heading-name matching inline. They decide what to carry
		 * forward by matching heading NAMES, and a conversion reshapes the body
		 * from one kind's headings into the other's BY DESIGN. Running them here
		 * would refuse every legitimate conversion deterministically: a bug body
		 * redrawn in feature shape drops every bug section, which is the whole
		 * point of the rewrite, and `bug_sections_dropped` would fire every time.
		 *
		 * `detectContentFloorBreach` carries no such assumption — it asks only
		 * whether content survived — and it is what stands between a model that
		 * technically responded and a body replaced by a three-line stub.
		 */
		const floor = detectContentFloorBreach({
			existing: story.description,
			candidate: redraft.description,
		});
		// The floor reports no breach when BOTH sides are blank (nothing was
		// lost). There is still nothing worth persisting, so a blank redraft is
		// refused here too rather than emptying the row.
		const floorReason = floor.belowFloor
			? (floor.reason ?? "below_content_floor")
			: redraft.description.trim().length === 0
				? "empty_output"
				: null;
		if (floorReason) {
			logResolution("refused", redraft.resolution, {
				reason: floorReason,
			});
			logger.warn(
				"[regenerateBodyForKind] redraft tripped the content floor; keeping the prior body",
				{
					storyId: input.storyId,
					projectId: input.projectId,
					storyKind: kind,
					reason: floorReason,
					priorLength: story.description?.length ?? 0,
					candidateLength: redraft.description.length,
				},
			);
			return {
				status: "below_content_floor",
				reason: floorReason,
				kind,
			};
		}

		/**
		 * THE WRITE IS NOT DESCRIPTION-ONLY.
		 *
		 * `draftBodyByKind` falls back to the INPUT acceptance criteria whenever
		 * the bug branch returns none — and the bug schema never returns any,
		 * because a bug card is a single markdown body. Persisting what comes
		 * back would leave a feature-turned-bug holding its feature
		 * acceptance-criteria checklist, the exact cross-type field bleed this
		 * regeneration exists to remove. So the target kind decides:
		 * BUG clears the field, FEATURE takes the redraft's.
		 */
		const nextAcceptanceCriteria =
			kind === "BUG" ? null : (redraft.acceptanceCriteria ?? null);

		// (4) Recover inline images the model dropped, then re-place the single
		// canonical back-link over the final (description, criteria) pair.
		let nextDescription = await reinjectDroppedMedia({
			priorDescription: story.description,
			nextDescription: redraft.description,
			projectId: input.projectId,
			storyId: input.storyId,
		});
		let nextAcceptanceCriteriaWithLink = nextAcceptanceCriteria;
		try {
			const project = await db.project.findUnique({
				where: { id: input.projectId },
				select: { organizationId: true },
			});
			const fabricUrl = await buildFabricStoryUrl({
				projectId: input.projectId,
				storyId: input.storyId,
				organizationId: project?.organizationId,
			});
			const placed = placeFabricBackLink({
				description: nextDescription,
				acceptanceCriteria: nextAcceptanceCriteria,
				fabricUrl,
			});
			nextDescription = placed.description;
			nextAcceptanceCriteriaWithLink = placed.acceptanceCriteria ?? null;
		} catch (error) {
			// Soft-fail, same as every other AI write path: a missing back-link
			// must not cost the user their regenerated body.
			logger.warn(
				"[regenerateBodyForKind] failed to re-place the Fabric back-link",
				{
					storyId: input.storyId,
					error:
						error instanceof Error ? error.message : String(error),
				},
			);
		}

		/**
		 * (1) Snapshot the prior body BEFORE it is replaced. This snapshot is the
		 * entire safety net that replaced human diff review, so it is taken
		 * unconditionally on the write path.
		 *
		 * It is taken AFTER the two refusals above, not before them: a refused
		 * regeneration must write nothing at all, and a version row is a write.
		 *
		 * `changedBy` is the PRIOR body's author. `updateStory` below would
		 * otherwise snapshot the same content attributed to whoever this write
		 * names, which for an unattended AI rewrite is nobody the history should
		 * credit. Written at the current version number, so `updateStory`'s own
		 * `skipDuplicates` snapshot of the same version is a no-op.
		 */
		const priorAuthorId = priorBodyAuthorId(story);
		await createFeatureVersion({
			storyId: input.storyId,
			version: expectedVersion,
			description: story.description ?? null,
			acceptanceCriteria: story.acceptanceCriteria ?? null,
			draftingStage: story.draftingStage as FeatureDraftingStage,
			changeDescription: `Before regenerating this body through the ${kind} template`,
			changedBy: priorAuthorId ?? undefined,
			userId: input.userId,
			organizationId: input.organizationId ?? undefined,
		});

		// (5) Write, under the version captured before the model call.
		try {
			await updateStory(
				input.storyId,
				input.projectId,
				{
					description: nextDescription,
					acceptanceCriteria: nextAcceptanceCriteriaWithLink,
					needsMoreInfo: redraft.needsMoreInfo,
				},
				{
					userId: input.userId,
					organizationId: input.organizationId ?? undefined,
					expectedVersion,
					// The prior body's author again — this context describes the
					// snapshot `updateStory` takes of the content it is
					// REPLACING, not the content it is writing.
					changedBy: priorAuthorId ?? undefined,
					changeDescription: `Before regenerating this body through the ${kind} template`,
					// The regenerated body is the AI's, not the converting
					// user's: no human name, an AI source. Same pair every other
					// unattended rewrite stamps.
					lastEditedByName: null,
					lastEditedSource: "AI_MATURATION",
				},
			);
		} catch (error) {
			if (error instanceof StoryVersionConflictError) {
				logResolution("refused", redraft.resolution, {
					reason: "stale",
					expectedVersion,
				});
				logger.warn(
					"[regenerateBodyForKind] discarding a stale redraft; the work item moved on",
					{
						storyId: input.storyId,
						projectId: input.projectId,
						storyKind: kind,
						expectedVersion,
					},
				);
				return { status: "stale", reason: "stale", kind };
			}
			throw error;
		}

		logResolution("hit", redraft.resolution, {
			needsMoreInfo: redraft.needsMoreInfo,
			acceptanceCriteriaCleared: kind === "BUG",
		});
		return { status: "regenerated", kind };
	} finally {
		clearInterval(hb);
	}
}
