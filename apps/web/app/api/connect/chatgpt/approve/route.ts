/**
 * Approves `fabric connect chatgpt` for the signed-in person (Fizzy #2939).
 *
 * Called by the `/connect/chatgpt` page. Mints the one-time upload ticket the
 * CLI then presents with the ChatGPT tokens. The ticket is bound to the
 * session's own user and to the ticked organizations, kept only where the
 * person is a member and `CHATGPT_PLAN` is on.
 *
 * With `shared` (`fabric connect chatgpt --org <slug> --shared`, Fizzy #2770)
 * the ticket is instead bound to one organization the person administers,
 * named by slug and looked up only among their own memberships: an unknown
 * slug, a membership without the admin or owner role and a flag that is off
 * all get the same refusal, and a session acting as another user gets none.
 */
import {
	createChatGptPlanUploadTicket,
	findChatGptPlanPoolAdminOrganization,
	listChatGptPlanOrganizations,
} from "@repo/database";
import { getSession } from "@saas/auth/lib/server";
import { NextResponse } from "next/server";
import { z } from "zod";

const CHATGPT_PLAN_NOT_ENABLED =
	"Choose at least one organization where ChatGPT plan use is enabled. If none is listed, ask your Fabric admin to enable it.";

const CHATGPT_PLAN_SHARED_NOT_ALLOWED =
	"You can connect a shared ChatGPT plan account only to an organization you administer, with ChatGPT plan pooling enabled.";

const SHARED_WHILE_IMPERSONATING =
	"A shared ChatGPT plan account cannot be connected while acting as another user.";

const bodySchema = z.object({
	organizationIds: z.array(z.string().min(1)).max(100).default([]),
	shared: z
		.object({ organizationSlug: z.string().min(1).max(200) })
		.optional(),
});

export async function POST(req: Request) {
	const session = await getSession();
	if (!session?.user) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}
	const parsed = bodySchema.safeParse(raw);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "organizationIds must be a list of ids" },
			{ status: 400 },
		);
	}

	if (parsed.data.shared) {
		// Binding an account to the organization is the admin's own act. The
		// upload that follows carries only the ticket, so this is the one
		// place an impersonated session can be told apart.
		if (session.session?.impersonatedBy) {
			return NextResponse.json(
				{ error: SHARED_WHILE_IMPERSONATING },
				{ status: 403 },
			);
		}
		const organization = await findChatGptPlanPoolAdminOrganization({
			userId: session.user.id,
			slug: parsed.data.shared.organizationSlug,
		});
		if (!organization) {
			return NextResponse.json(
				{ error: CHATGPT_PLAN_SHARED_NOT_ALLOWED },
				{ status: 403 },
			);
		}
		const { ticket, expiresAt } = await createChatGptPlanUploadTicket({
			kind: "org",
			userId: session.user.id,
			organizationId: organization.id,
		});
		return NextResponse.json({
			ticket,
			expiresAt: expiresAt.toISOString(),
		});
	}

	const chosen = new Set(parsed.data.organizationIds);
	const allowed = await listChatGptPlanOrganizations({
		userId: session.user.id,
	});
	const organizationIds = allowed
		.filter((org) => chosen.has(org.id))
		.map((org) => org.id);
	// A plan nobody may use here is not stored at all.
	if (organizationIds.length === 0) {
		return NextResponse.json(
			{ error: CHATGPT_PLAN_NOT_ENABLED },
			{ status: 403 },
		);
	}
	const { ticket, expiresAt } = await createChatGptPlanUploadTicket({
		userId: session.user.id,
		organizationIds,
	});

	return NextResponse.json({ ticket, expiresAt: expiresAt.toISOString() });
}
