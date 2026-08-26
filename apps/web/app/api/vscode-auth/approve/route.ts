import { approveDeviceCode } from "@repo/api";
import { getSession } from "@saas/auth/lib/server";
import { NextResponse } from "next/server";

export async function POST(req: Request) {
	const session = await getSession();
	if (!session?.user) {
		return NextResponse.json(
			{ error: "Not authenticated" },
			{ status: 401 },
		);
	}

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

	const result = await approveDeviceCode(
		code,
		session.user.id,
		session.user.email,
	);

	if (!result.ok) {
		return NextResponse.json({ error: result.error }, { status: 400 });
	}

	return NextResponse.json({ ok: true });
}
