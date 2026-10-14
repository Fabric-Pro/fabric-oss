import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../../orpc/procedures";
import { linkPmItem } from "../../../lib/link-pm-item";
import { assertTestCaseSyncSupported } from "../../../lib/pm-test-case-sync-capability";
import { assertTestCasesFeatureEnabled } from "../../../lib/test-cases-feature";

/**
 * Link to existing item for a test case: link an unlinked case to a PM item
 * that already exists (the one a create Fabric could not confirm made), and
 * clear the case's create claim. Nothing is created or pushed. Gated like
 * the case's retry: the Test Cases feature flag, and the connected tool's
 * live test-case push support. See `linkPmItem`.
 */
export const linkTestCasePmItemProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.TEST_CASE_UPDATE))
	.route({
		method: "POST",
		path: "/projects/{projectId}/test-cases/{testCaseId}/link-pm-item",
		tags: ["Projects", "Test Cases", "Sync"],
		summary: "Link a test case to an existing PM item",
		description:
			"Links an unlinked test case to a PM item that already exists, after reading the item through the project's PM connection, and clears the case's pending create. Nothing is created or pushed. Refused when the case is already linked, a sync of it is in progress, the item is not found or cannot be read, the item is in another Azure DevOps project, or the item is already linked to another test case.",
	})
	.input(
		z.object({
			projectId: z.string(),
			testCaseId: z.string(),
			externalId: z
				.string()
				.trim()
				.min(1, "Enter the PM item's ID")
				.max(200),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.output(
		z.object({
			linked: z.literal(true),
			externalId: z.string(),
			externalUrl: z.string().nullable(),
		}),
	)
	.handler(async ({ input, context }) => {
		assertTestCasesFeatureEnabled();
		return linkPmItem({
			row: { testCaseId: input.testCaseId },
			projectId: input.projectId,
			externalId: input.externalId,
			userId: context.user.id,
			// The same live gate as the case's retry: a linked case is pushed
			// next, so the tool must support test-case push.
			assertTargetSupported: (target, organizationId) =>
				assertTestCaseSyncSupported(target, "push", {
					userId: context.user.id,
					organizationId,
				}),
		});
	});
