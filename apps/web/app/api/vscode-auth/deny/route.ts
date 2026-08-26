import { denyDeviceCode } from "@repo/api";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	let body: { code?: string };
	try {
		body = await req.json();
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const { code } = body;
	if (!code) {
		return NextResponse.json(
			{ error: "code is required" },
			{ status: 400 },
		);
	}

	await denyDeviceCode(code);
	return NextResponse.json({ ok: true });
}
