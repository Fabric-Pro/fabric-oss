import { ORPCError } from "@orpc/server";
import { config } from "@repo/config";
import { z } from "zod";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../orpc/procedures";
import { verifyOrganizationMembership } from "../../organizations/lib/membership";

const MAILTO_MAX_LENGTH = 1800;

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
		description:
			"Prepare an email draft requesting a new integration or MCP server",
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
		if (!supportEmail) {
			return { mailto: null };
		}

		const to = encodeURIComponent(supportEmail);
		const subject = encodeURIComponent(`Connection request: ${input.name}`);
		const build = (notes: string) => {
			const body = [
				"",
				"",
				"— — —",
				`Requested by: ${oneLine(user.name)} <${user.email}>`,
				`Organization: ${oneLine(membership.organization.name)}`,
				`Type: ${TYPE_LABELS[input.type]}`,
				`Name: ${input.name}`,
				"",
				"Notes:",
				notes || "(none)",
			].join("\r\n");
			return `mailto:${to}?subject=${subject}&body=${encodeURIComponent(body)}`;
		};

		// Shorten by whole characters: slicing UTF-16 units can split an emoji,
		// and encodeURIComponent throws on half of one.
		const fullNotes = input.notes ?? "";
		const noteChars = Array.from(fullNotes);
		let kept = noteChars.length;
		let mailto = build(fullNotes);
		while (mailto.length > MAILTO_MAX_LENGTH && kept > 0) {
			kept = Math.floor(kept * 0.8);
			mailto = build(
				kept > 0 ? `${noteChars.slice(0, kept).join("")}…` : "",
			);
		}

		return {
			mailto:
				mailto.length > MAILTO_MAX_LENGTH
					? `mailto:${to}?subject=${subject}`
					: mailto,
		};
	});
