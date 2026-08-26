/**
 * Background Agent Review-Required Callback
 *
 * Called by fabric-bot when the agent pauses and requires human review.
 * Sets the CodingRun status to AWAITING_REVIEW without ending the workflow.
 *
 * AUTH: HMAC-SHA256 signature in X-Fabric-Signature header
 *       (shared secret: FABRIC_CALLBACK_SECRET)
 */

import { addCodingRunEvent, db, updateCodingRunStatus } from "@repo/database";
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

	let payload: { codingRunId: string; workflowId: string };
	try {
		payload = JSON.parse(rawBody);
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const { codingRunId } = payload;
	if (!codingRunId) {
		return NextResponse.json(
			{ error: "Missing required field: codingRunId" },
			{ status: 400 },
		);
	}

	const codingRun = await db.codingRun.findUnique({
		where: { id: codingRunId },
		select: { id: true, status: true },
	});

	if (!codingRun) {
		return NextResponse.json(
			{ error: "CodingRun not found" },
			{ status: 404 },
		);
	}

	// Only transition to AWAITING_REVIEW from active states
	const activeStates = new Set(["QUEUED", "STARTING", "RUNNING"]);
	if (!activeStates.has(codingRun.status)) {
		return NextResponse.json({ ok: true, skipped: "not_active" });
	}

	await updateCodingRunStatus(codingRunId, "AWAITING_REVIEW");
	await addCodingRunEvent(codingRunId, "review_required", {
		previousStatus: codingRun.status,
	});

	return NextResponse.json({ ok: true });
}
