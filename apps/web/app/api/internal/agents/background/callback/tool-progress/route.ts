/**
 * Background Agent Tool Progress Callback
 *
 * Called by fabric-bot when the agent executes a tool (file edit, bash command, etc.).
 * Appends a CodingRunEvent for live progress display in the UI.
 *
 * AUTH: HMAC-SHA256 signature in X-Fabric-Signature header
 *       (shared secret: FABRIC_CALLBACK_SECRET)
 */

import { addCodingRunEvent, db } from "@repo/database";
import { type NextRequest, NextResponse } from "next/server";

async function verifyHmacSignature(
	body: string,
	signature: string,
	secret: string,
): Promise<boolean> {
	try {
		const encoder = new TextEncoder();
		const keyData = encoder.encode(secret);
		const key = await crypto.subtle.importKey(
			"raw",
			keyData,
			{ name: "HMAC", hash: "SHA-256" },
			false,
			["verify"],
		);
		const sigBytes = Buffer.from(signature.replace(/^sha256=/, ""), "hex");
		return crypto.subtle.verify(
			"HMAC",
			key,
			sigBytes,
			encoder.encode(body),
		);
	} catch {
		return false;
	}
}

export async function POST(request: NextRequest) {
	const rawBody = await request.text();

	const callbackSecret = process.env.FABRIC_CALLBACK_SECRET;
	if (!callbackSecret) {
		return NextResponse.json(
			{ error: "Callback endpoint not configured" },
			{ status: 503 },
		);
	}

	const signature = request.headers.get("X-Fabric-Signature") ?? "";
	const valid = await verifyHmacSignature(rawBody, signature, callbackSecret);
	if (!valid) {
		return NextResponse.json(
			{ error: "Invalid signature" },
			{ status: 401 },
		);
	}

	let payload: {
		codingRunId: string;
		toolName: string;
		description?: string;
		providerEventId?: string;
	};

	try {
		payload = JSON.parse(rawBody);
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const { codingRunId, toolName, description, providerEventId } = payload;

	if (!codingRunId || !toolName) {
		return NextResponse.json(
			{ error: "Missing required fields: codingRunId, toolName" },
			{ status: 400 },
		);
	}

	// Verify the CodingRun exists (no status update needed for progress events)
	const exists = await db.codingRun.findUnique({
		where: { id: codingRunId },
		select: { id: true },
	});

	if (!exists) {
		return NextResponse.json(
			{ error: "CodingRun not found" },
			{ status: 404 },
		);
	}

	await addCodingRunEvent(
		codingRunId,
		"tool_call",
		{ toolName, description },
		providerEventId,
	);

	await db.codingRun.update({
		where: { id: codingRunId },
		data: { lastProviderEventAt: new Date() },
	});

	return NextResponse.json({ ok: true });
}
