/**
 * Internal: realtime relay for the Temporal worker
 *
 * Publishes one project- or conversation-channel event for a process that has
 * no Upstash REST credentials of its own. The Azure worker container apps get
 * `REDIS_URL` only, so `@repo/utils/realtime-emit` POSTs each event here
 * instead (Fizzy #2946), and it goes out on the web's own Realtime client, the
 * one the SSE routes subscribe through.
 *
 * AUTH: X-Agent-Service-Token header matching AGENT_SERVICE_SECRET, the header
 * the Weave coding-run bridge sends, compared in constant time by
 * `isAgentServiceRequestAuthorized`; an unset secret refuses every call.
 *
 * TRUST: that secret is shared by every internal caller (the worker, the agent
 * containers, several internal routes), so it admits a caller without proving
 * the event genuine. The route therefore narrows what it publishes
 * (`./target.ts`): the body's text must be plain, and the event may only name
 * rows of the project or conversation it is published on; anything else is a
 * 404 that does not say which part failed. A secret holder can still publish a
 * well-formed nudge for a real project's own rows, which makes open pages
 * refetch; nothing is persisted.
 *
 * The body is one event of `realtimeRelayRequestSchema`, whose payloads are the
 * schemas the direct publish and the SSE subscriber use, read in chunks up to
 * 16 KB. `publishRelayedEvent` publishes it on `getProjectRealtime()`, never
 * through the emit helpers, which would relay again from a web process without
 * Upstash: without Upstash here the answer is 503. Neither the body nor the
 * secret is ever logged.
 */

import { isAgentServiceRequestAuthorized } from "@repo/api/lib/agent-service-auth";
import { publishRelayedEvent } from "@repo/api/lib/realtime";
import { realtimeRelayRequestSchema } from "@repo/utils/realtime-emit";
import { type NextRequest, NextResponse } from "next/server";
import { checkRelayedTarget, hasPlainText } from "./target";

/** One event is a few hundred bytes; a body near this is not one. */
const MAX_BODY_BYTES = 16 * 1024;

function payloadTooLarge() {
	return NextResponse.json({ error: "Payload too large" }, { status: 413 });
}

function invalidEvent() {
	return NextResponse.json(
		{ error: "Invalid realtime event" },
		{ status: 400 },
	);
}

/**
 * The body as text, read chunk by chunk, or null as soon as more than
 * `MAX_BODY_BYTES` arrived: a body without a truthful Content-Length is never
 * buffered past the cap.
 */
async function readBoundedBody(request: NextRequest): Promise<string | null> {
	if (!request.body) {
		return "";
	}
	const reader = request.body.getReader();
	const decoder = new TextDecoder();
	let size = 0;
	let text = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) {
			return text + decoder.decode();
		}
		size += value.byteLength;
		if (size > MAX_BODY_BYTES) {
			await reader.cancel().catch(() => undefined);
			return null;
		}
		text += decoder.decode(value, { stream: true });
	}
}

export async function POST(request: NextRequest) {
	if (
		!isAgentServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}

	// The declared size first, so an announced oversized body is not read at
	// all; the bounded read catches a missing or wrong header.
	const declaredLength = Number(request.headers.get("content-length"));
	if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
		return payloadTooLarge();
	}
	let text: string | null;
	try {
		text = await readBoundedBody(request);
	} catch {
		return invalidEvent();
	}
	if (text === null) {
		return payloadTooLarge();
	}

	let body: unknown;
	try {
		body = JSON.parse(text);
	} catch {
		return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
	}

	const parsed = realtimeRelayRequestSchema.safeParse(body);
	if (!parsed.success || !hasPlainText(parsed.data)) {
		return invalidEvent();
	}

	let relayed: Awaited<ReturnType<typeof checkRelayedTarget>>;
	try {
		relayed = await checkRelayedTarget(parsed.data);
	} catch (error) {
		console.error(
			`[realtime-relay] Could not check the target of ${parsed.data.event}:`,
			error instanceof Error ? error.name : "unknown error",
		);
		return NextResponse.json(
			{ error: "Target check failed" },
			{ status: 503 },
		);
	}
	if (!relayed) {
		return NextResponse.json({ error: "Not found" }, { status: 404 });
	}

	let published: boolean;
	try {
		published = await publishRelayedEvent(relayed);
	} catch (error) {
		console.error(
			`[realtime-relay] Failed to publish ${relayed.event}:`,
			error instanceof Error ? error.message : "unknown error",
		);
		return NextResponse.json({ error: "Publish failed" }, { status: 502 });
	}
	if (!published) {
		return NextResponse.json(
			{ error: "Realtime not configured" },
			{ status: 503 },
		);
	}

	return NextResponse.json({ ok: true });
}
