import { getMcpClientSession } from "@repo/database";
import { z } from "zod";
import {
	Permissions,
	requirePermission,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";

export const sessionProcedures = {
	verify: tenantProtectedProcedure
		.use(requirePermission(Permissions.MCP_UPDATE))
		.route({
			method: "POST",
			path: "/mcp/session/verify",
			tags: ["MCP"],
			summary: "Verify short-lived MCP client token and return config",
		})
		.input(z.object({ token: z.string() }))
		.output(z.any())
		.handler(async ({ input, context }) => {
			const user = context.user;
			const session = await getMcpClientSession(input.token);
			if (
				!session ||
				session.userId !== user.id ||
				session.expiresAt < new Date()
			) {
				return { valid: false };
			}
			return { valid: true, config: session.config };
		}),
};
