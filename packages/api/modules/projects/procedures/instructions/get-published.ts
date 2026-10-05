import { getPublishedInstructionSnapshot } from "@repo/database";
import { z } from "zod";
import { projectNotFoundUnlessVisible } from "../../../../orpc/middleware/project-visibility";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireHostingOrganizationId } from "./hosting-organization";

/**
 * AUTHORIZATION: tenantProtectedProcedure + projectNotFoundUnlessVisible + requireProjectPermission(INSTRUCTION_READ).
 *
 * Reads the project's currently published coding-instructions snapshot.
 * `getPublishedInstructionSnapshot(projectId)` is UNSCOPED by design (the
 * published pointer lives on the `Project` row, keyed only by its id), so
 * this handler verifies the returned row's `organizationId` matches the
 * project's hosting organization before returning it (R11) — a mismatch is
 * answered as `null`, exactly like "nothing published", rather than leaking
 * cross-tenant existence.
 */
export const getPublishedSnapshotProcedure = tenantProtectedProcedure
	.use(projectNotFoundUnlessVisible)
	.use(requireProjectPermission(Permissions.INSTRUCTION_READ))
	.route({
		method: "GET",
		path: "/projects/:projectId/instructions/published",
		tags: ["Projects", "Instructions"],
		summary: "Get the published coding-instructions snapshot",
	})
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
		}),
	)
	.handler(async ({ input, context }) => {
		const organizationId = await requireHostingOrganizationId(
			input.projectId,
			context.user.id,
		);
		const snapshot = await getPublishedInstructionSnapshot(input.projectId);
		// "Nothing published" is a state the tab renders and polls, not a
		// failure: answered as `null` so a 3-second poll on a fresh project
		// does not log a failed request each time. A snapshot of another
		// organization is answered the same way (R11), so the route still
		// leaks nothing.
		if (!snapshot || snapshot.organizationId !== organizationId) {
			return null;
		}
		return snapshot;
	});
