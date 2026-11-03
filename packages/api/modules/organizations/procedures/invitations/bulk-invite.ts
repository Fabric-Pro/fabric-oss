/**
 * Bulk Organization Invitation Procedure
 *
 * Invites a pasted list of addresses as members and reports the outcome of each
 * one (Fizzy #1986). Addresses are handled independently, so a bad entry or a
 * failed email never costs the others and nothing is rolled back.
 *
 * Each address goes through the same Better Auth invitation as the single
 * invite form. An address may have no account yet, and an existing account
 * should not join an organization it never agreed to, so these people become
 * members when they accept.
 *
 * AUTHORIZATION: Requires org owner or admin role via requireOrgMembership()
 */

import { ORPCError } from "@orpc/server";
import { auth } from "@repo/auth";
import { MAX_BULK_INVITATIONS } from "@repo/auth/lib/invitation-limits";
import { db } from "@repo/database";
import { z } from "zod";
import { recordAuditFromRequest } from "../../../../lib/audit";
import { checkRateLimit } from "../../../../lib/rate-limit";
import {
	Permissions,
	requireInputOrgPermission,
	resolveOrganizationId,
	tenantProtectedProcedure,
} from "../../../../orpc/procedures";
import { requireOrgMembership } from "../../lib/membership";

const BULK_INVITE_STATUSES = [
	"invited",
	"invalid",
	"duplicate",
	"already_member",
	"already_invited",
	"failed",
] as const;
type BulkInviteStatus = (typeof BULK_INVITE_STATUSES)[number];

type BulkInviteEntry = {
	email: string;
	normalized: string;
	status: BulkInviteStatus | null;
};

// Each invitation sends an email, so a full batch one at a time would hold the
// request for minutes, and all at once would flood the mail provider.
const INVITE_CONCURRENCY = 8;
const BATCHES_PER_HOUR = 10;
const ONE_HOUR_MS = 60 * 60 * 1000;

const MAX_EMAIL_LENGTH = 320;

const emailSchema = z.string().email();

export const bulkInviteOrgMembersProcedure = tenantProtectedProcedure
	// Against the requested organization, not the session's: this is also what
	// refuses a soft-deleted organization the caller still administers.
	.use(
		requireInputOrgPermission(Permissions.ORG_MEMBERS_INVITE, {
			requireOrganization: true,
		}),
	)
	.route({
		method: "POST",
		path: "/organizations/{organizationId}/invitations/bulk",
		tags: ["Organizations", "Invitations"],
		summary: "Invite a list of members",
		description:
			"Invites each address as a member and reports the outcome per address",
	})
	.input(
		z.object({
			organizationId: z.string().min(1, "Organization ID is required"),
			// Bounded as a whole rather than per entry: one absurd token must be
			// reported on its own, not refuse the batch around it.
			emails: z
				.array(z.string())
				.min(1)
				.max(MAX_BULK_INVITATIONS)
				.refine(
					(emails) =>
						emails.join("").length <=
						MAX_BULK_INVITATIONS * MAX_EMAIL_LENGTH,
					"The list is too long",
				),
		}),
	)
	.output(
		z.object({
			results: z.array(
				z.object({
					email: z.string(),
					status: z.enum(BULK_INVITE_STATUSES),
				}),
			),
		}),
	)
	.handler(async ({ context, input }) => {
		const { user, session, headers } = context;
		const organizationId = resolveOrganizationId(
			input.organizationId,
			session,
		);

		if (!organizationId) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners and admins can invite members",
			});
		}

		const membership = await requireOrgMembership(user.id, organizationId, [
			"owner",
			"admin",
		]);

		if (!membership) {
			throw new ORPCError("FORBIDDEN", {
				message:
					"Only organization owners and admins can invite members",
			});
		}

		const rate = await checkRateLimit(
			`org-bulk-invite:${organizationId}`,
			BATCHES_PER_HOUR,
			ONE_HOUR_MS,
		);
		if (!rate.allowed) {
			throw new ORPCError("TOO_MANY_REQUESTS", {
				message: `Too many bulk invitations. Try again in ${rate.resetInSeconds} seconds.`,
			});
		}

		const seen = new Set<string>();
		const entries = input.emails.map((raw): BulkInviteEntry => {
			const email = raw.trim().toLowerCase();
			let status: BulkInviteStatus | null = null;
			if (
				email.length > MAX_EMAIL_LENGTH ||
				!emailSchema.safeParse(email).success
			) {
				status = "invalid";
			} else if (seen.has(email)) {
				status = "duplicate";
			}
			seen.add(email);
			return {
				email: raw.trim().slice(0, MAX_EMAIL_LENGTH),
				normalized: email,
				status,
			};
		});

		const candidates = entries
			.filter((entry) => entry.status === null)
			.map((entry) => entry.normalized);

		const [members, pending] = await Promise.all([
			db.member.findMany({
				where: { organizationId, user: { email: { in: candidates } } },
				select: { user: { select: { email: true } } },
			}),
			db.invitation.findMany({
				where: {
					organizationId,
					email: { in: candidates },
					status: "pending",
					expiresAt: { gt: new Date() },
				},
				select: { email: true },
			}),
		]);
		const memberEmails = new Set(
			members.map((member) => member.user.email.toLowerCase()),
		);
		const pendingEmails = new Set(
			pending.map((invitation) => invitation.email.toLowerCase()),
		);

		for (const entry of entries) {
			if (entry.status !== null) {
				continue;
			}
			if (memberEmails.has(entry.normalized)) {
				entry.status = "already_member";
			} else if (pendingEmails.has(entry.normalized)) {
				entry.status = "already_invited";
			}
		}

		const queue = entries.filter((entry) => entry.status === null);
		const worker = async () => {
			for (
				let entry = queue.shift();
				entry !== undefined;
				entry = queue.shift()
			) {
				try {
					await auth.api.createInvitation({
						body: {
							email: entry.normalized,
							role: "member",
							organizationId,
						},
						headers,
					});
					entry.status = "invited";
				} catch {
					entry.status = "failed";
				}
			}
		};
		await Promise.all(
			Array.from({ length: INVITE_CONCURRENCY }, () => worker()),
		);

		const results = entries.map(({ email, status }) => ({
			email,
			status: status ?? "failed",
		}));

		const counts = Object.fromEntries(
			BULK_INVITE_STATUSES.map((status) => [
				status,
				results.filter((result) => result.status === status).length,
			]),
		);
		recordAuditFromRequest(context, {
			action: "org.member.bulk_invited",
			category: "org",
			organizationId,
			resource: { type: "organization", id: organizationId },
			metadata: counts,
		});

		return { results };
	});
