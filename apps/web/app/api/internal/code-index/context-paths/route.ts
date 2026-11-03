/**
 * POST /api/internal/code-index/context-paths
 *
 * A Living Memory sync took repository files into Context or let them go;
 * asked for by the sync's Temporal activity. Re-runs the repository's code
 * index for those paths, so a file is indexed once: as context while Living
 * Memory keeps it, as code otherwise.
 *
 * AUTH: X-Agent-Service-Token header matching AGENT_SERVICE_SECRET; an unset
 * secret fails closed. Every decision answers 200 with its outcome; only an
 * unexpected error answers 503.
 */

import { reindexContextCoveredPaths } from "@repo/api/modules/projects/lib/code-index-refresh";
import { logger } from "@repo/logs";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { constantTimeEqual } from "../../parlume/lib";

const bodySchema = z.object({
	projectId: z.string().min(1).max(128),
	repositoryIntegrationId: z.string().min(1).max(128),
	paths: z.array(z.string().min(1).max(1024)).min(1).max(20_000),
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
		const outcome = await reindexContextCoveredPaths(parsed.data);
		return NextResponse.json({ outcome });
	} catch (error) {
		logger.error("[code-index-context-paths] reindex failed", {
			projectId: parsed.data.projectId,
			error: error instanceof Error ? error.message : String(error),
		});
		return NextResponse.json({ error: "Retry required" }, { status: 503 });
	}
}
