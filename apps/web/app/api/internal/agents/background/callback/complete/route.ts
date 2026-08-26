/**
 * Background Agent Completion Callback
 *
 * Called by fabric-bot when the control-plane session completes (PR created,
 * agent finished, or session stopped). Signals the Temporal workflow to end
 * the condition wait and finalize the CodingRun.
 *
 * AUTH: HMAC-SHA256 signature in X-Fabric-Signature header
 *       (shared secret: FABRIC_CALLBACK_SECRET)
 */

import { addCodingRunEvent, db, updateCodingRunStatus } from "@repo/database";
import { getTemporalClient } from "@repo/temporal";
import { type NextRequest, NextResponse } from "next/server";

// Import the signal definition so the handle can send it by name
const PROVIDER_COMPLETE_SIGNAL = "providerComplete";

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

	// Verify HMAC signature
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
		providerStatus: "completed" | "failed" | "stopped";
		pullRequestUrl?: string;
		branchName?: string;
		error?: string;
	};

	try {
		payload = JSON.parse(rawBody);
	} catch {
		return NextResponse.json(
			{ error: "Invalid JSON body" },
			{ status: 400 },
		);
	}

	const { codingRunId, providerStatus, pullRequestUrl, branchName, error } =
		payload;

	if (!codingRunId || !providerStatus) {
		return NextResponse.json(
			{ error: "Missing required fields: codingRunId, providerStatus" },
			{ status: 400 },
		);
	}

	// Look up the CodingRun to get the workflowId
	const codingRun = await db.codingRun.findUnique({
		where: { id: codingRunId },
		select: { id: true, workflowId: true, status: true },
	});

	if (!codingRun) {
		return NextResponse.json(
			{ error: "CodingRun not found" },
			{ status: 404 },
		);
	}

	// Idempotency guard: if the run is already in a terminal state or has a PR,
	// return 200 without re-processing. This handles webhook retries safely.
	// PR_OPENED is included: the completion event was already processed and
	// a duplicate signal or status update would be wasteful.
	// TERMINATED_STALE is also terminal — the watchdog already wound this
	// row down and a delayed provider callback must not resurrect it.
	const TERMINAL_STATUSES = new Set([
		"COMPLETED",
		"FAILED",
		"CANCELLED",
		"PR_OPENED",
		"TERMINATED_STALE",
	]);
	if (TERMINAL_STATUSES.has(codingRun.status)) {
		return NextResponse.json({ ok: true, skipped: "already_terminal" });
	}

	// Map provider status to Fabric status for immediate DB update
	const fabricStatus =
		providerStatus === "completed"
			? pullRequestUrl
				? "PR_OPENED"
				: "COMPLETED"
			: providerStatus === "stopped"
				? "CANCELLED"
				: "FAILED";

	// Update DB status
	await updateCodingRunStatus(
		codingRunId,
		fabricStatus as Parameters<typeof updateCodingRunStatus>[1],
		{
			...(pullRequestUrl ? { pullRequestUrl } : {}),
			...(branchName ? { pullRequestBranch: branchName } : {}),
		},
	);
	await db.codingRun.update({
		where: { id: codingRunId },
		data: { lastProviderEventAt: new Date() },
	});

	await addCodingRunEvent(codingRunId, "provider_callback_complete", {
		providerStatus,
		pullRequestUrl,
		branchName,
		error,
	});

	// Signal the Temporal workflow to break out of its condition wait
	if (codingRun.workflowId) {
		try {
			const temporal = await getTemporalClient();
			const handle = temporal.workflow.getHandle(codingRun.workflowId);
			await handle.signal(PROVIDER_COMPLETE_SIGNAL, {
				providerStatus,
				pullRequestUrl,
				branchName,
				error,
			});
		} catch (signalError) {
			// Workflow may have already ended — log but don't fail the callback
			console.warn(
				`[callback/complete] Failed to signal workflow ${codingRun.workflowId}:`,
				signalError instanceof Error
					? signalError.message
					: String(signalError),
			);
		}
	}

	return NextResponse.json({ ok: true });
}
