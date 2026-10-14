import { ORPCError } from "@orpc/server";
import {
	getChatGptPlanCredentialStatus,
	isFeatureEnabled,
} from "@repo/database";
import {
	chatGptPlanTestResultSchema,
	runChatGptPlanTest,
} from "../../../../lib/chatgpt-plan-test";
import {
	Permissions,
	requirePermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";

/**
 * Tests the signed-in member's own ChatGPT plan with one tiny real request
 * (Fizzy #2770), in the session's organization, where `CHATGPT_PLAN` must be
 * on. A test can change state as a real call does — a refused sign-in is
 * marked for reconnecting, a spent window is remembered — so nobody acting as
 * the member may run one.
 */
export const testChatGptPlanProcedure = tenantProtectedProcedure
	.use(requirePermission(Permissions.USER_UPDATE_SELF))
	.route({
		method: "POST",
		path: "/users/chatgpt-plan/test",
		tags: ["Users"],
		summary: "Test the ChatGPT plan",
		description:
			"Send one tiny request to the signed-in user's own ChatGPT plan and report whether it answered, needs a reconnect, or has its usage limit reached",
	})
	.output(chatGptPlanTestResultSchema)
	.handler(async ({ context: { user, session } }) => {
		if (session.impersonatedBy) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"A plan cannot be tested while acting as another user.",
			});
		}
		const organizationId = resolveOrganizationId(undefined, session);
		if (
			!organizationId ||
			!(await isFeatureEnabled("CHATGPT_PLAN", organizationId))
		) {
			throw new ORPCError("NOT_FOUND", {
				message: "ChatGPT plans are not available here",
			});
		}
		if (!(await getChatGptPlanCredentialStatus(user.id))) {
			throw new ORPCError("NOT_FOUND", {
				message: "No ChatGPT plan is connected",
			});
		}
		return runChatGptPlanTest({
			userId: user.id,
			organizationId,
			source: { kind: "user", userId: user.id },
		});
	});
