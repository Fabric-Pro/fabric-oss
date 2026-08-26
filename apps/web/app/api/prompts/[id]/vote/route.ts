import { auth } from "@repo/auth";
import { db } from "@repo/database";
import { headers } from "next/headers";
import type { NextRequest } from "next/server";

type Params = { params: Promise<{ id: string }> };

/** POST /api/prompts/[id]/vote — cast an upvote */
export async function POST(_req: NextRequest, { params }: Params) {
	const headersList = await headers();
	const session = await auth.api.getSession({ headers: headersList });

	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: promptId } = await params;
	const userId = session.user.id;

	// Upsert vote (idempotent)
	await db.promptVote.upsert({
		where: { userId_promptId: { userId, promptId } },
		create: { userId, promptId },
		update: {},
	});

	// Recount from source of truth
	const voteCount = await db.promptVote.count({ where: { promptId } });

	await db.prompt.update({
		where: { id: promptId },
		data: { voteCount },
	});

	return Response.json({ voted: true, voteCount });
}

/** DELETE /api/prompts/[id]/vote — remove an upvote */
export async function DELETE(_req: NextRequest, { params }: Params) {
	const headersList = await headers();
	const session = await auth.api.getSession({ headers: headersList });

	if (!session?.user) {
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	}

	const { id: promptId } = await params;
	const userId = session.user.id;

	await db.promptVote
		.delete({ where: { userId_promptId: { userId, promptId } } })
		.catch(() => {}); // ignore if already removed

	const voteCount = await db.promptVote.count({ where: { promptId } });

	await db.prompt.update({
		where: { id: promptId },
		data: { voteCount },
	});

	return Response.json({ voted: false, voteCount });
}
