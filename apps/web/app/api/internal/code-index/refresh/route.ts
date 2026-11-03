/**
 * POST /api/internal/code-index/refresh
 *
 * One scheduled refresh check of one repository's code index (spec 2026-10-29
 * code-index-sync), asked for by the Temporal code-index refresh poll: compare
 * the indexed commit with the branch HEAD and re-embed only the changed files.
 *
 * AUTH: X-Agent-Service-Token header matching AGENT_SERVICE_SECRET; an unset
 * secret fails closed. Every decision answers 200 with its outcome so the poll
 * does not retry it; only an unexpected error answers 503.
 */

import { refreshCodeIndexOnSchedule } from "@repo/api/modules/projects/lib/code-index-refresh";
import { logger } from "@repo/logs";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { constantTimeEqual } from "../../parlume/lib";

const bodySchema = z.object({
	codeIndexId: z.string().min(1).max(128),
});

export async function POST(request: NextRequest) {
	if (
		!constantTimeEqual(
			request.headers.get("X-Agent-Service-Token"),
			process.env.AGENT_SERVICE_SECRET,
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = bodySchema.safeParse(await request.json().catch(() => null));
	if (!parsed.success) {
		return NextResponse.json({ error: "Invalid request" }, { status: 400 });
	}
	try {
		const outcome = await refreshCodeIndexOnSchedule({
			codeIndexId: parsed.data.codeIndexId,
		});
		return NextResponse.json({ outcome });
	} catch (error) {
		logger.error("[code-index-refresh] check failed", {
			codeIndexId: parsed.data.codeIndexId,
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
