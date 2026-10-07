import { ORPCError } from "@orpc/client";
import { downloadDirectRepository } from "@repo/api/modules/projects/procedures/instructions/repository/download";
import { auth } from "@repo/auth";
import type { NextRequest } from "next/server";

export const runtime = "nodejs";

export async function GET(
	request: NextRequest,
	{ params }: { params: Promise<{ projectId: string }> },
) {
	const session = await auth.api.getSession({ headers: request.headers });
	if (!session?.user)
		return Response.json({ error: "Unauthorized" }, { status: 401 });
	const { projectId } = await params;
	const query = request.nextUrl.searchParams;
	try {
		if (
			!query.has("generation") ||
			!/^\d+$/.test(query.get("generation") ?? "")
		) {
			throw new ORPCError("BAD_REQUEST", {
				message: "Invalid repository version",
			});
		}
		return await downloadDirectRepository({
			projectId,
			userId: session.user.id,
			generation: Number(query.get("generation")),
			commitSha: query.get("commitSha") ?? "",
			path: query.get("path") ?? undefined,
			signal: request.signal,
		});
	} catch (error) {
		const status = error instanceof ORPCError ? error.status : 500;
		return Response.json(
			{
				error:
					status === 500
						? "Repository download failed"
						: error instanceof ORPCError
							? error.message
							: "Repository download failed",
			},
			{ status, headers: { "Cache-Control": "private, no-store" } },
		);
	}
}
