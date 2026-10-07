/**
 * Stores a ChatGPT plan sign-in uploaded by `fabric connect chatgpt`
 * (Fizzy #2939).
 *
 * Authenticated by the one-time upload ticket from the approve route
 * (`Authorization: Bearer <ticket>`), never by a session or an API key. The
 * ticket alone decides whose sign-in this is and which organizations may use
 * it — or, for a shared-account ticket (Fizzy #2770), which one organization
 * it is stored for; nothing in the body can name a user or an organization. The body holds
 * tokens, so it is never logged or echoed.
 */
import {
	chatGptPlanUploadSchema,
	connectChatGptPlan,
	connectChatGptPlanOrgAccount,
} from "@repo/ai/lib/chatgpt-plan/connect";
import { consumeChatGptPlanUploadTicket } from "@repo/database";
import { NextResponse } from "next/server";

export const runtime = "nodejs";

const UNAUTHORIZED = {
	error: "This connection link has expired or was already used. Run `fabric connect chatgpt` again.",
};

export async function POST(req: Request) {
	const authorization = req.headers.get("authorization") ?? "";
	const ticket = authorization.startsWith("Bearer ")
		? authorization.slice("Bearer ".length).trim()
		: "";
	if (!ticket) {
		return NextResponse.json(UNAUTHORIZED, { status: 401 });
	}

	let raw: unknown;
	try {
		raw = await req.json();
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}
	// Checked before the ticket is spent, so a malformed upload can be retried.
	const parsed = chatGptPlanUploadSchema.safeParse(raw);
	if (!parsed.success) {
		return NextResponse.json(
			{
				error: `Invalid request: ${parsed.error.issues
					.map((issue) => issue.path.join("."))
					.join(", ")}`,
			},
			{ status: 400 },
		);
	}

	const payload = await consumeChatGptPlanUploadTicket(ticket);
	if (!payload) {
		return NextResponse.json(UNAUTHORIZED, { status: 401 });
	}

	if (payload.kind === "org") {
		const shared = await connectChatGptPlanOrgAccount({
			userId: payload.userId,
			organizationId: payload.organizationId,
			upload: parsed.data,
		});
		if (!shared.ok) {
			return NextResponse.json(
				{ error: shared.error },
				{ status: shared.status },
			);
		}
		return NextResponse.json({
			connected: true,
			email: shared.email,
			shared: {
				organization: shared.organization,
				created: shared.created,
			},
		});
	}

	const result = await connectChatGptPlan({
		userId: payload.userId,
		organizationIds: payload.organizationIds,
		upload: parsed.data,
	});
	if (!result.ok) {
		return NextResponse.json(
			{ error: result.error },
			{ status: result.status },
		);
	}
	return NextResponse.json({
		connected: true,
		email: result.email,
		organizations: result.organizations,
	});
}
