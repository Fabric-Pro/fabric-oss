import {
	listProblemLogStatusHistory,
	problemLogUserLabels,
} from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requireProjectPermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { resolveProjectOrganizationId } from "../../projects/lib/project-organization";
import { loadProblemLogProject, loadProjectEntry } from "../lib/access";

/** One entry with its status history (from the audit ledger). */
export const getProcedure = tenantProtectedProcedure
	.use(requireProjectPermission(Permissions.PROBLEM_LOG_READ))
	.input(
		z.object({
			projectId: z.string(),
			organizationId: z.string().nullable().optional(),
			entryId: z.string(),
		}),
	)
	.handler(async ({ input, context }) => {
		await resolveProjectOrganizationId(
			input.organizationId,
			input.projectId,
		);
		const { organizationId } = await loadProblemLogProject({
			projectId: input.projectId,
			userId: context.user.id,
		});
		const entry = await loadProjectEntry(
			organizationId,
			input.projectId,
			input.entryId,
		);
		const [history, userLabel] = await Promise.all([
			listProblemLogStatusHistory(organizationId, entry.id),
			problemLogUserLabels(organizationId, [entry.affectedUserId]),
		]);
		const affectedUser = entry.affectedUserId
			? (userLabel.get(entry.affectedUserId) ?? null)
			: null;
		return { entry, history, affectedUser };
	});
