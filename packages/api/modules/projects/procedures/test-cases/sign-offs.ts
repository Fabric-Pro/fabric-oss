/**
 * QA sign-offs on a feature — record, withdraw, and read the threshold status.
 *
 * The gate that consumes these lives in `stories/update-story.ts`, on the
 * transition to DONE. It is deliberately NOT here: a sign-off procedure that
 * also enforced would leave the enforcement reachable only through this module,
 * and the thing being protected is the status write.
 */

import { ORPCError } from "@orpc/client";
import {
	getQaSignOffStatus,
	listQaSignOffs,
	recordQaSignOff,
	revokeQaSignOff,
} from "@repo/database";
import { db } from "@repo/database/prisma/client";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { assertTestCasesFeatureEnabled } from "../../lib/test-cases-feature";

const MAX_NOTE_LENGTH = 500;

/**
 * Confirm the feature belongs to the project named in the input.
 *
 * `requireProjectPermission` gates the PROJECT; it says nothing about whether
 * this feature is in it. Without this an authorised member of project A could
 * sign off a feature in project B by passing its id.
 */
async function assertStoryInProject(storyId: string, projectId: string) {
	const story = await db.userStory.findFirst({
		where: { id: storyId, projectId },
		select: { id: true },
	});
	if (!story) {
		throw new ORPCError("NOT_FOUND", { message: "Feature not found" });
	}
}

export const getQaSignOffsProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_READ))
	.route({
		method: "GET",
		path: "/projects/{projectId}/features/{storyId}/qa-sign-offs",
		tags: ["Projects", "Test Cases"],
		summary:
			"QA sign-offs recorded on a feature, and how many are required",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input }) => {
		assertTestCasesFeatureEnabled();
		await assertStoryInProject(input.storyId, input.projectId);

		const [signOffs, status] = await Promise.all([
			listQaSignOffs(input.storyId),
			getQaSignOffStatus({
				projectId: input.projectId,
				userStoryId: input.storyId,
			}),
		]);

		return { signOffs, ...status };
	});

export const recordQaSignOffProcedure = tenantProtectedProcedure
	// TEST_CASE_UPDATE, not READ: a sign-off is a write that can unblock a
	// feature, so it needs the same permission as changing QA state.
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/features/{storyId}/qa-sign-offs",
		tags: ["Projects", "Test Cases"],
		summary: "Record the calling user's QA sign-off on a feature",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			note: z.string().max(MAX_NOTE_LENGTH).optional(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		await assertStoryInProject(input.storyId, input.projectId);

		const user = context.user;
		// The approver is ALWAYS the caller. Accepting a user id from the input
		// would let one person manufacture the second signature the threshold
		// exists to require.
		const signOff = await recordQaSignOff({
			projectId: input.projectId,
			userStoryId: input.storyId,
			signedById: user.id,
			signedByLabel: user.name || user.email || "Unknown",
			note: input.note ?? null,
		});

		recordAuditFromRequest(context, {
			action: "project.qa_sign_off.recorded",
			category: "project",
			severity: "info",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "user_story",
				id: input.storyId,
			},
		});

		const status = await getQaSignOffStatus({
			projectId: input.projectId,
			userStoryId: input.storyId,
		});
		return { signOff, ...status };
	});

export const revokeQaSignOffProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "DELETE",
		path: "/projects/{projectId}/features/{storyId}/qa-sign-offs",
		tags: ["Projects", "Test Cases"],
		summary: "Withdraw the calling user's own QA sign-off",
	})
	.input(
		z.object({
			projectId: z.string(),
			storyId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		await assertStoryInProject(input.storyId, input.projectId);

		// Only your own. Withdrawing somebody else's approval is a different,
		// more dangerous act than withdrawing your own, and nothing in the card
		// asks for it.
		const removed = await revokeQaSignOff({
			userStoryId: input.storyId,
			signedById: context.user.id,
		});
		if (!removed) {
			throw new ORPCError("NOT_FOUND", {
				message: "You have not signed off this feature",
			});
		}

		recordAuditFromRequest(context, {
			action: "project.qa_sign_off.revoked",
			category: "project",
			// A withdrawn approval can re-block a feature somebody was about to
			// mark done, so it is worth more than info in an audit trail.
			severity: "warning",
			outcome: "success",
			projectId: input.projectId,
			resource: {
				type: "user_story",
				id: input.storyId,
			},
		});

		const status = await getQaSignOffStatus({
			projectId: input.projectId,
			userStoryId: input.storyId,
		});
		return status;
	});
