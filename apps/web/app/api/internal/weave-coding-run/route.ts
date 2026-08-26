import { type NextRequest, NextResponse } from "next/server";
import { executeWeaveCodingRun, type WeaveCodingRunRequest } from "./lib";

export async function POST(request: NextRequest) {
	const secret = request.headers.get("X-Agent-Service-Token");
	if (!secret || secret !== process.env.AGENT_SERVICE_SECRET) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	try {
		const input = (await request.json()) as WeaveCodingRunRequest;
		const result = await executeWeaveCodingRun(input);
		return NextResponse.json(result);
	} catch (error) {
		return NextResponse.json(
			{ error: error instanceof Error ? error.message : "Unknown error" },
			{ status: 500 },
		);
	}
}
