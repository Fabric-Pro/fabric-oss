import { ORPCError } from "@orpc/client";
import {
	canUpdateProjectInstructions,
	MAX_INSTRUCTION_APPROVERS,
	MAX_REQUIRED_INSTRUCTION_APPROVALS,
	updateProjectInstructionSettings,
} from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";
import { projectIgnoreGlobsSchema } from "./ignore-globs-input";
import { assertNoOpenMigration, withMigrationFreeze } from "./migration-freeze";

/**
 * The upload-mode proposal review policy. `approverUserIds` absent or empty
 * means anyone who may review; when set it must name enough people to meet
 * `requiredApprovals`.
 */
const reviewPolicySchema = z
	.object({
		requiredApprovals: z
			.number()
			.int()
			.min(1)
			.max(MAX_REQUIRED_INSTRUCTION_APPROVALS),
		approverUserIds: z
			.array(z.string().min(1))
			.max(MAX_INSTRUCTION_APPROVERS)
			.optional(),
	})
	.transform((policy) => {
		const approverUserIds = [...new Set(policy.approverUserIds ?? [])];
		return {
			requiredApprovals: policy.requiredApprovals,
			approverUserIds:
				approverUserIds.length > 0 ? approverUserIds : null,
		};
	})
	.refine(
		(policy) =>
			policy.approverUserIds === null ||
			policy.approverUserIds.length >= policy.requiredApprovals,
		{
			message:
				"Name at least as many approvers as the approvals you require",
		},
	);

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_UPDATE).
 *
 * Updates the project's coding-instructions settings: the ignore-glob
 * override and the upload-mode proposal review policy. Either may be sent
 * alone. `ignoreGlobs: null` clears the override so future uploads fall back
 * to `DEFAULT_IGNORE_GLOBS` (or an uploaded `.fabricignore`, which always
 * outranks both). The review policy changes nothing a repository sync would
 * produce, so it neither bumps the sync generation nor waits on an open move
 * into a repository.
 *
 * Every listed approver must be able to approve now: hold INSTRUCTION_UPDATE
 * on this project, checked with the same ladder the approval itself uses.
 */
export const updateSettingsProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_UPDATE))
	.route({
		method: "PUT",
		path: "/projects/:projectId/instructions/settings",
		tags: ["Projects", "Instructions"],
		summary: "Update coding-instructions settings",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			ignoreGlobs: projectIgnoreGlobsSchema.nullable().optional(),
			reviewPolicy: reviewPolicySchema.optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		if (
			input.ignoreGlobs === undefined &&
			input.reviewPolicy === undefined
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Nothing to update",
			});
		}
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const approverUserIds = input.reviewPolicy?.approverUserIds ?? [];
		const unable = (
			await Promise.all(
				approverUserIds.map(async (userId) =>
					(await canUpdateProjectInstructions(
						input.projectId,
						userId,
					))
						? null
						: userId,
				),
			)
		).filter((userId): userId is string => userId !== null);
		if (unable.length > 0) {
			throw new ORPCError("BAD_REQUEST", {
				message:
					"Every approver must be a project member who can review coding-instruction proposals",
				data: { reason: "APPROVER_NOT_ELIGIBLE", userIds: unable },
			});
		}
		const update = () =>
			updateProjectInstructionSettings(input.projectId, organizationId, {
				...(input.ignoreGlobs === undefined
					? {}
					: { ignoreGlobs: input.ignoreGlobs }),
				...(input.reviewPolicy === undefined
					? {}
					: { reviewPolicy: input.reviewPolicy }),
			});
		if (input.ignoreGlobs === undefined) {
			await update();
		} else {
			// New ignore rules would re-plan what a move into the repository
			// carries and fence its sync row (Fizzy #2878 §9).
			await assertNoOpenMigration({
				projectId: input.projectId,
				organizationId,
			});
			await withMigrationFreeze(
				{ projectId: input.projectId, organizationId },
				update,
			);
		}
		recordAuditFromRequest(context, {
			action: "project.instructions.settings_updated",
			category: "project",
			organizationId,
			projectId: input.projectId,
			resource: { type: "project", id: input.projectId, name: null },
			metadata: {
				...(input.ignoreGlobs === undefined
					? {}
					: { ignoreGlobCount: input.ignoreGlobs?.length ?? 0 }),
				...(input.reviewPolicy === undefined
					? {}
					: {
							requiredApprovals:
								input.reviewPolicy.requiredApprovals,
							approverCount:
								input.reviewPolicy.approverUserIds?.length ?? 0,
						}),
			},
		});
		return { ok: true };
	});
