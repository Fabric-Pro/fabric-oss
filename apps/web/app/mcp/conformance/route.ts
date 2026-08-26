export const runtime = "nodejs";

import type { NextRequest } from "next/server";
import { deleteConformance, getConformance, postConformance } from "../route";

export async function POST(request: NextRequest): Promise<Response> {
	return postConformance(request);
}

export async function GET(request: NextRequest): Promise<Response> {
	return getConformance(request);
}

export async function DELETE(request: NextRequest): Promise<Response> {
	return deleteConformance(request);
}
