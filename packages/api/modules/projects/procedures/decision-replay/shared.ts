import { ORPCError } from "@orpc/server";
import { isFeatureEnabled } from "@repo/database";
import { z } from "zod";
import { loadProjectOrganizationId } from "../../lib/project-organization";
import { projectUsageProcedure } from "../usage/shared";

export const decisionReplayScopeSchema = z
	.object({ projectId: z.string().min(1).max(900) })
	.strict();
/** Permission runs before the project organization is loaded and gated. */
export const decisionReplayProcedure = projectUsageProcedure.use(
	async ({ next }, input) => {
		const parsed = decisionReplayScopeSchema.strip().safeParse(input);
		if (!parsed.success) {
			throw new ORPCError("BAD_REQUEST");
		}
		const organizationId = await loadProjectOrganizationId(
			parsed.data.projectId,
		);
		if (!(await isFeatureEnabled("DECISION_REPLAY", organizationId))) {
			throw new ORPCError("NOT_FOUND", {
				message: "Decision Replay is not enabled",
			});
		}
		return next({
			context: { decisionReplayOrganizationId: organizationId },
		});
	},
);
