import { ORPCError } from "@orpc/client";
import {
	buildDocumentLink,
	db,
	hasProjectAccess,
	updateDocument,
} from "@repo/database";
import { ProjectDocumentStatusSchema } from "@repo/database/prisma/zod";
import {
	FUNCTION_TAG_GROUP_LABELS,
	FUNCTION_TAG_ORDER,
} from "@repo/database/src/function-tags";
import { logger } from "@repo/logs";
import { z } from "zod";
import { applyDocumentUpdateSideEffects } from "../../../lib/document-side-effects";
import { fanOut } from "../../../lib/notification-service";
import {
	Permissions,
	requireProjectPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import {
	diffGroupMentions,
	diffMentionIds,
	extractDocumentGroupMentions,
	extractDocumentMentionIds,
	extractMentionContextSnippet,
} from "../lib/document-mentions";
import {
	expandGroupMentionsByTag,
	narrowToCurrentProjectRoster,
} from "../lib/group-mention";
import { filterAuthorizedMentionRecipients } from "../lib/user-mention";

// All document types are re-embedded when content changes.
// This matches the generation workflow which embeds ALL types so they
// serve as cross-document context (e.g., TECHNICAL_SPEC as context for API_SPEC).

export const updateDocumentProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROJECT_UPDATE))
	.route({
		method: "PATCH",
		path: "/projects/:projectId/documents/:id",
		tags: ["Projects", "Documents"],
		summary: "Update document",
		description: "Update a document and create a new version",
	})
	.input(
		z.object({
			projectId: z.string(),
			id: z.string(),
			organizationId: z.string().nullable().optional(),
			title: z.string().min(1).max(255).optional(),
			content: z.string().optional(),
			status: ProjectDocumentStatusSchema.optional(),
			changeDescription: z.string().optional(),
			/** Skip version bump when reverting a rejected regeneration */
			skipVersionBump: z.boolean().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);

		// Check project access
		const hasAccess = await hasProjectAccess(
			input.projectId,
			user.id,
			organizationId,
		);

		if (!hasAccess) {
			throw new ORPCError("FORBIDDEN", {
				message: "You don't have access to this project",
			});
		}

		// Pre-load existing content so we can diff mentions after the save.
		// `status` + `version` also let us detect a real change for subscriber
		// notifications: `updateDocument` bumps `version` only on a normalized
		// content change, so a version delta is the precise "content changed"
		// signal (title-only saves leave it untouched).
		const prior = await db.projectDocument.findUnique({
			where: { id: input.id },
			select: {
				projectId: true,
				content: true,
				title: true,
				status: true,
				version: true,
			},
		});

		// TENANT ISOLATION (SOC 2 CC6.1/CC6.3): the permission gate above only
		// authorizes `input.projectId`, but the document is loaded/written by
		// `input.id` alone. Without binding the record to the authorized
		// project, a caller with UPDATE on their own project could overwrite
		// ANY tenant's document by id. Reject when the document is missing or
		// belongs to a different project (NOT_FOUND to avoid a cross-tenant
		// existence oracle).
		if (!prior || prior.projectId !== input.projectId) {
			throw new ORPCError("NOT_FOUND", { message: "Document not found" });
		}

		// Update document
		// TENANT ISOLATION: Pass userId and organizationId for DocumentVersion tenant filtering
		const document = await updateDocument(input.id, {
			title: input.title,
			content: input.content,
			status: input.status,
			lastEditedBy: user.id,
			changeDescription: input.changeDescription,
			userId: user.id,
			organizationId,
			skipVersionBump: input.skipVersionBump,
		});

		// Only embed when the save actually changed content — update-document
		// is the only procedure that may skip the embed on metadata-only saves.
		await applyDocumentUpdateSideEffects({
			projectId: input.projectId,
			document,
			user,
			organizationId,
			logScope: "UpdateDocument",
			skipEmbed: !input.content,
		});

		// Mention fan-out — fire and forget, must never break the save.
		void dispatchDocumentMentions({
			projectId: input.projectId,
			documentId: input.id,
			documentTitle: input.title ?? prior?.title ?? "Untitled",
			organizationId: organizationId ?? null,
			actorUserId: user.id,
			actorName: (user as { name?: string }).name ?? "A teammate",
			prevContent: prior?.content ?? "",
			nextContent: input.content ?? prior?.content ?? "",
		}).catch((err) => {
			// fanOut.documentMention already swallows per-recipient errors; this
			// catches whole-dispatch failures (e.g., org row missing for the
			// link builder, db hiccup in the authz filter) so the save still
			// succeeds and the failure surfaces in logs.
			logger.warn(
				{ err, documentId: input.id, projectId: input.projectId },
				"[update-document] mention dispatch failed",
			);
		});

		// Subscriber fan-out — notify watchers on a real content change (version
		// bumped) or a status change. Title-only / metadata-only saves do NOT
		// notify. Fire-and-forget; must never break the save.
		const contentChanged =
			prior != null && document.version !== prior.version;
		const statusChanged =
			input.status !== undefined &&
			prior != null &&
			input.status !== prior.status;
		if (contentChanged || statusChanged) {
			void fanOut
				.subscriptionUpdate({
					subjectType: "DOCUMENT",
					subjectId: input.id,
					projectId: input.projectId,
					organizationId: organizationId ?? null,
					actorUserId: user.id,
					actorName: (user as { name?: string }).name ?? "A teammate",
					title: document.title,
					link: buildDocumentLink({
						projectId: input.projectId,
						documentId: input.id,
					}),
					changeKind: contentChanged ? "content" : "status",
				})
				.catch((err) => {
					logger.warn(
						"[update-document] subscription dispatch failed",
						{
							err,
							documentId: input.id,
							projectId: input.projectId,
						},
					);
				});
		}

		// Backstop signal for save callers: `updateDocument` bumps `version` only
		// on a normalized content change, so a content-bearing save that left the
		// version untouched was a no-op. Surface it additively so the confirm-save
		// path can show "no changes" instead of a phantom success (never content).
		const contentUnchanged = input.content !== undefined && !contentChanged;
		if (contentUnchanged) {
			logger.info(
				{
					documentId: input.id,
					projectId: input.projectId,
					newContentLength: input.content?.length ?? 0,
					priorContentLength: prior.content?.length ?? 0,
				},
				"[update-document] content-bearing save produced no version bump — content matches current document",
			);
		}

		return { document, contentUnchanged };
	});

export async function dispatchDocumentMentions(args: {
	projectId: string;
	documentId: string;
	documentTitle: string;
	organizationId: string | null;
	actorUserId: string;
	actorName: string;
	prevContent: string;
	nextContent: string;
}): Promise<void> {
	const newlyMentioned = diffMentionIds(
		extractDocumentMentionIds(args.prevContent),
		extractDocumentMentionIds(args.nextContent),
	);
	const newGroups = diffGroupMentions(
		extractDocumentGroupMentions(args.prevContent),
		extractDocumentGroupMentions(args.nextContent),
	);
	if (newlyMentioned.length === 0 && newGroups.length === 0) {
		return;
	}

	const link = buildDocumentLink({
		projectId: args.projectId,
		documentId: args.documentId,
	});
	// Track everyone already notified so a group never double-notifies an
	// individually-mentioned recipient (individual "mentioned you" wins).
	const dispatched = new Set<string>();

	// --- Individual mentions (existing behavior, existing org-soft filter) ---
	if (newlyMentioned.length > 0) {
		const allowedUserIds = await filterAuthorizedMentionRecipients(
			newlyMentioned.map((m) => m.userId),
			args.projectId,
			args.organizationId,
		);
		const allowedSet = new Set(allowedUserIds);
		const recipients = newlyMentioned.filter((m) =>
			allowedSet.has(m.userId),
		);
		if (recipients.length > 0) {
			for (const r of recipients) {
				dispatched.add(r.userId);
			}
			const snippetByAnchor = Object.fromEntries(
				recipients.map((m) => [
					m.anchorId,
					extractMentionContextSnippet(args.nextContent, m.anchorId),
				]),
			);
			// Authoritative actor for document mentions is the session caller.
			// The binding `actorUserId: user.id` is set at the call site to
			// dispatchDocumentMentions (see above in this file). If/when an
			// AI-on-behalf-of-human surface is added, it must impersonate at
			// the session layer — this dispatch trusts `user.id` as the human
			// who authored the change.
			await fanOut.documentMention({
				recipients,
				documentId: args.documentId,
				projectId: args.projectId,
				organizationId: args.organizationId,
				actorUserId: args.actorUserId,
				actorName: args.actorName,
				documentTitle: args.documentTitle,
				link,
				snippetByAnchor,
			});
		}
	}

	// --- Group mentions (project-scoped narrow, group-only, per-group label) ---
	// Dispatch in FUNCTION_TAG_ORDER (NOT document order) so an overlapping
	// member gets a deterministic group label, matching the comment surface
	// (Codex plan review #2).
	const orderedGroups = [...newGroups].sort(
		(a, b) =>
			FUNCTION_TAG_ORDER.indexOf(a.tag) -
			FUNCTION_TAG_ORDER.indexOf(b.tag),
	);
	if (orderedGroups.length > 0) {
		// Resolve the roster ONCE for every mentioned tag, then narrow the
		// union of holders a single time. Per-tag holders intersected with the
		// narrowed union equal the per-tag narrow (narrow is a membership
		// filter), so this preserves the recipients, precedence, and per-group
		// labels of the old per-tag resolve while dropping the redundant reads.
		const holdersByTag = await expandGroupMentionsByTag({
			projectId: args.projectId,
			groupTags: [...new Set(orderedGroups.map((g) => g.tag))],
		});
		const narrowedGroupRoster = new Set(
			await narrowToCurrentProjectRoster(
				[...new Set([...holdersByTag.values()].flat())],
				args.projectId,
			),
		);
		for (const group of orderedGroups) {
			// A group never notifies the acting author (`id !== actorUserId`);
			// the individual "mentioned you" path already claimed anyone reached
			// both ways (`dispatched`).
			const fresh = (holdersByTag.get(group.tag) ?? []).filter(
				(id) =>
					narrowedGroupRoster.has(id) &&
					!dispatched.has(id) &&
					id !== args.actorUserId,
			);
			if (fresh.length === 0) {
				continue;
			}
			for (const id of fresh) {
				dispatched.add(id);
			}
			await fanOut.documentMention({
				recipients: fresh.map((userId) => ({
					userId,
					anchorId: group.anchorId,
				})),
				documentId: args.documentId,
				projectId: args.projectId,
				organizationId: args.organizationId,
				actorUserId: args.actorUserId,
				actorName: args.actorName,
				documentTitle: args.documentTitle,
				link,
				snippetByAnchor: {
					[group.anchorId]: extractMentionContextSnippet(
						args.nextContent,
						group.anchorId,
					),
				},
				groupLabel: FUNCTION_TAG_GROUP_LABELS[group.tag],
			});
		}
	}
}
