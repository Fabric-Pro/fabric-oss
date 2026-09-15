/**
 * Public, token-scoped customer outcomes (plan Slice 8).
 *
 * AUTHORIZATION: none by session — the capability IS the token. The token is
 * 32 random bytes (base64url) stored on `Project.outcomesShareToken`, set by
 * `projects.outcomes.publish` (PROJECT_GOVERNANCE_MANAGE) and cleared by
 * `projects.outcomes.revoke`. The handler returns only the restricted DTO
 * from `buildCustomerOutcomes` and answers NOT_FOUND identically for
 * unknown, revoked and malformed tokens. IP rate-limited via
 * `rateLimitedPublicProcedure`.
 *
 * Exempted from permission-coverage.test via the explicit allowlist.
 */
import { ORPCError } from "@orpc/client";
import { z } from "zod";
import { rateLimitedPublicProcedure } from "../../../orpc/procedures";
import { getCustomerOutcomesByToken } from "../lib/customer-outcomes";

export const getOutcomesByTokenProcedure = rateLimitedPublicProcedure
	.route({
		method: "GET",
		path: "/outcomes/{token}",
		tags: ["Outcomes"],
		summary: "Customer outcomes by share token",
		description:
			"Read-only, token-scoped outcomes page data for a project's customer audience.",
	})
	.input(z.object({ token: z.string().min(16).max(128) }))
	.handler(async ({ input }) => {
		const outcomes = await getCustomerOutcomesByToken(input.token);
		if (!outcomes) {
			throw new ORPCError("NOT_FOUND", { message: "Not found" });
		}
		return outcomes;
	});
