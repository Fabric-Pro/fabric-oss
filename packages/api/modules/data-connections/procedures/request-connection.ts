import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { isMailConfigured, sendEmail } from "@repo/mail";
import { z } from "zod";
import { checkRateLimit } from "../../../lib/rate-limit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const REQUEST_LIMIT = { limit: 5, windowMs: 60 * 60 * 1000 };

const TYPE_LABELS = {
	mcp: "MCP",
	integration: "Integrations",
	unsure: "Not sure",
} as const;

// Control characters plus Unicode line/paragraph separators.
const LINE_BREAKS = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;
const oneLine = (value: string) => value.replace(LINE_BREAKS, " ").trim();

export const requestConnectionInputSchema = z.object({
	type: z.enum(["mcp", "integration", "unsure"]),
	name: z
		.string()
		.trim()
		.min(1)
		.max(100)
		.regex(/^[^\p{Cc}\p{Zl}\p{Zp}]+$/u),
	notes: z.string().trim().max(1000).optional(),
	organizationId: z.string().nullable().optional(),
});

export const requestConnectionProcedure = tenantProtectedProcedure
	.use(
		requireInputOrgPermission(Permissions.ORG_DATA_CONNECTIONS_READ, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/data-connections/request",
		tags: ["DataConnections"],
		summary: "Request a connection",
		description: "Send a request for a new integration or MCP server",
	})
	.input(requestConnectionInputSchema)
	.handler(async ({ input, context }) => {
		const user = context.user;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			context.session,
		);
		const membership = organizationId
			? await verifyOrganizationMembership(organizationId, user.id)
			: null;
		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message: "You are not a member of this organization",
			});
		}

		const supportEmail = config.support.email;
		if (!supportEmail || !isMailConfigured()) {
			throw new ORPCError("PRECONDITION_FAILED", {
				message: "Connection requests are not available",
			});
		}

		const rate = await checkRateLimit(
			`connection-request:${user.id}`,
			REQUEST_LIMIT.limit,
			REQUEST_LIMIT.windowMs,
		);
		if (!rate.allowed) {
			const unavailable = rate.statusCode === 503;
			throw new ORPCError(
				unavailable ? "SERVICE_UNAVAILABLE" : "TOO_MANY_REQUESTS",
				{
					message: unavailable
						? "Requests are temporarily unavailable. Please try again later."
						: "Too many requests. Please try again later.",
				},
			);
		}

		const sent = await sendEmail({
			to: supportEmail,
			replyTo: user.email,
			subject: `Connection request: ${input.name}`,
			text: [
				`Requested by: ${oneLine(user.name)} <${user.email}>`,
				`Organization: ${oneLine(membership.organization.name)}`,
				`Type: ${TYPE_LABELS[input.type]}`,
				`Name: ${input.name}`,
				"",
				"--- Notes (written by the requester) ---",
				input.notes || "(none)",
			].join("\n"),
		});
		if (!sent) {
			throw new ORPCError("INTERNAL_SERVER_ERROR", {
				message: "The request could not be sent",
			});
		}

		return { success: true };
	});
