import { ORPCError } from "@orpc/client";
import {
	generateStoryTitleFromDescription,
	type StoryTitleSource as HelperStoryTitleSource,
	mapStoryTitleSourceToEnum,
} from "@repo/ai/lib/story-title-generator";
import {
	db,
	FeatureDraftingStageSchema,
	type StoryKind,
	StoryKindSchema,
	type StoryPriority,
	type StorySize,
} from "@repo/database";
import { logger } from "@repo/logs";
import { createStoryFromProposal } from "@repo/temporal";
// Subpath, not the barrel: the guard is a pure lib and importing it this way
// keeps the workflow graph out of the request path (same import
// `validate-prompt-for-kind.ts` uses).
import { PromptKindMismatchError } from "@repo/temporal/prompt-kind-guard";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { dispatchLifecycleEvent } from "../../../agent-deployments/lib/lifecycle-dispatcher";
import { maybeAutoDraftOnStageChange } from "../../lib/auto-draft-test-cases";
import { stripInternalStoryFields } from "../../lib/strip-internal-story-fields";
import { runInBackground } from "../../../weave/lib/run-in-background";
import { validateStageForKind } from "../../lib/validate-stage-for-kind";

export const createStoryProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.STORY_CREATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/stories",
		tags: ["Projects", "Stories"],
		summary: "Create user story",
		description: "Create a new user story",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			statusId: z.string().optional(),
			title: z.string().min(1).max(500).optional(),
			description: z.string().optional(),
			acceptanceCriteria: z.string().optional(),
			kind: StoryKindSchema.optional(),
			priority: z
				.enum(["P0_CRITICAL", "P1_HIGH", "P2_MEDIUM", "P3_LOW"])
				.optional(),
			size: z.enum(["XS", "S", "M", "L", "XL"]).optional(),
			storyPoints: z.number().int().min(0).max(100).optional(),
			assigneeId: z.string().optional(),
			draftingStage: FeatureDraftingStageSchema.optional(),
			promptId: z.string().optional(),
			promptVersionId: z.string().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// F-171: `kind` from the caller is optional and acts as a hint only.
		// The classifier in createStoryFromProposal decides the canonical kind
		// from the user's text. The manual UI no longer sends `kind` at all
		// (the split-button was removed); other callers that still pass it
		// will see the classifier override logged when they disagree.
		const callerKindHint: StoryKind | undefined = input.kind;

		// Enforce the stage-for-kind invariant only when both the stage and a
		// kind hint were provided. If the hint is absent we can't validate
		// here — the classifier will pick the right kind and the procedure
		// downstream applies the per-kind stage constraints.
		if (input.draftingStage && callerKindHint) {
			validateStageForKind(input.draftingStage, callerKindHint);
		}

		// Title generation needs a kind for tone. Use the hint when present,
		// else FEATURE — the final stored title is regenerated for bugs by
		// the bug creation prompt anyway, so this is just cosmetic for the
		// pre-classification UX (the dialog closes immediately).
		let resolvedTitle: string;
		let aiGeneratedTitle = false;
		let resolvedTitleSource: HelperStoryTitleSource | null = null;

		if (input.title) {
			resolvedTitle = input.title;
		} else {
			// Manual UI is the only caller of this procedure today.
			// `creationSource: "UI"` is the working default; future surfaces
			// may override via a request field (out of scope per spec §2.2).
			// `originContext` is reserved for forward-compat with chat-driven
			// surfaces — the dialog has no chat origin, so omit. `projectName`
			// omitted; helper handles missing values. Tenant XOR is enforced
			// upstream by `tenantProtectedProcedure` + `requireProjectPermission`.
			const result = await generateStoryTitleFromDescription(
				input.description?.trim() ?? "",
				callerKindHint === "BUG" ? "BUG" : "FEATURE",
				{
					userId: user.id,
					organizationId: organizationId ?? undefined,
					projectId: input.projectId,
					creationSource: "UI",
					originContext: undefined,
					projectName: undefined,
				},
			);
			resolvedTitle = result.title;
			aiGeneratedTitle = result.source === "ai";
			resolvedTitleSource = result.source;
		}

		// `pmAutoSyncEnabled` is omitted intentionally: the manual-UI create
		// path produces a Fabric-only feature with no externalId, so the
		// Prisma column default of `false` applies. The user opts in later
		// via the cloud-sync toggle on the editor / roadmap.
		//
		// Fizzy #2048 (FR11): `promptId` / `promptVersionId` are the one input
		// pair this procedure cannot check itself — no row exists yet and the
		// caller's `kind` is a hint, so the cross-kind check runs inside
		// `createStoryFromProposal`, after its classifier has decided the kind.
		// It reports a mismatch as a typed `PromptKindMismatchError` (the
		// workflow package carries no orpc dependency); mapping it to the
		// protocol is this layer's job, exactly as `update-with-context.ts` maps
		// `ContextUpdateTruncatedError`. BAD_REQUEST, not INTERNAL: the caller
		// named a prompt that cannot apply to what they described, and the
		// message says which kinds are involved and how to proceed. Nothing has
		// been written when this throws.
		let created: Awaited<ReturnType<typeof createStoryFromProposal>>;
		try {
			created = await createStoryFromProposal({
				projectId: input.projectId,
				organizationId,
				createdById: user.id,
				title: resolvedTitle,
				description: input.description,
				acceptanceCriteria: input.acceptanceCriteria,
				statusId: input.statusId,
				assigneeId: input.assigneeId,
				kind: callerKindHint,
				priority: input.priority as StoryPriority | undefined,
				size: input.size as StorySize | undefined,
				storyPoints: input.storyPoints,
				draftingStage: input.draftingStage,
				explicitPromptId: input.promptId,
				explicitPromptVersionId: input.promptVersionId,
				source: "MANUAL",
				// F-171 reporter tracking: manual-UI submissions always populate
				// MANUAL + the authenticated user's name (REQ-9, AC8).
				reporterName: user.name ?? null,
				reporterSource: "MANUAL",
				reporterSourceUrl: null,
			});
		} catch (error) {
			if (error instanceof PromptKindMismatchError) {
				// Passed through verbatim — it is written for the person who
				// picked the prompt and is rendered as-is.
				throw new ORPCError("BAD_REQUEST", { message: error.message });
			}
			throw error;
		}
		const { story, aiDrafted } = created;

		// Telemetry update is best-effort: failure to record AI-title metadata
		// must not fail story creation.
		const persistedTitleSource = resolvedTitleSource
			? mapStoryTitleSourceToEnum(resolvedTitleSource)
			: null;
		try {
			await db.userStory.update({
				where: { id: story.id },
				data: {
					aiGeneratedTitle,
					titleSource: persistedTitleSource,
				},
			});
			// Mirror the persisted telemetry back onto the in-memory `story`
			// object before we return it to the client. `createStoryFromProposal`
			// returned the freshly-inserted row whose `titleSource` was `null`;
			// without this mirror the dialog's soft-warn toast (spec §4.2 — fired
			// when `titleSource === UNTITLED_FALLBACK`) would never see the
			// fallback signal because the wire payload would still carry the
			// pre-update value. Best-effort: if the update above threw, we keep
			// the stale `null` rather than lying about the persisted state.
			story.aiGeneratedTitle = aiGeneratedTitle;
			story.titleSource = persistedTitleSource;
		} catch (error) {
			logger.warn(
				"[createStoryProcedure] failed to persist AI-title telemetry",
				error,
			);
		}

		dispatchLifecycleEvent({
			resource: "story",
			event: "created",
			projectId: input.projectId,
			entityId: story.id,
			userId: user.id,
			organizationId,
			data: {
				storyId: story.id,
				title: story.title,
				statusId: story.statusId,
				aiDrafted,
				aiGeneratedTitle,
				titleSource: resolvedTitleSource,
			},
		}).catch((error) => {
			console.warn(
				"[LifecycleDispatcher] Story created dispatch failed:",
				error,
			);
		});

		// Audit-log emission. Fire-and-forget; never blocks the
		// originating create. Resource snapshot captured at write time so the
		// audit row survives even after the story is deleted (D11).
		recordAuditFromRequest(context, {
			action: "story.created",
			category: "story",
			organizationId,
			projectId: input.projectId,
			resource: {
				type: "story",
				id: story.id,
				name: story.title ?? null,
			},
			metadata: {
				kind: story.kind,
				statusId: story.statusId,
				aiDrafted,
			},
		});

		// A feature can be CREATED at Ready for Dev — the input accepts both a
		// stage and acceptance criteria — in which case it arrives eligible
		// without ever transitioning. No stage procedure ever runs for it, so
		// this is the only place the trigger can fire.
		runInBackground(
			maybeAutoDraftOnStageChange({
				projectId: input.projectId,
				storyId: story.id,
				userId: user.id,
				previousStage: null,
				targetStage: story.draftingStage,
			}),
		);

		return {
			story: stripInternalStoryFields(story),
			aiGenerated: aiDrafted,
		};
	});
