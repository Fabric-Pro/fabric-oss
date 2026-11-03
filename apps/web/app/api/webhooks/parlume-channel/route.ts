import { withTimeout } from "@repo/api/lib/temporal-describe";
import {
	channelNotificationSchema,
	prepareParlumeChannelNotifications,
} from "@repo/api/modules/projects/lib/parlume-channel-chat";
import { type NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { enqueueParlumeChannelNotifications } from "./enqueue";

const MAX_BODY_BYTES = 1_048_576;

async function readNotificationBody(
	request: NextRequest,
	deadline: number,
): Promise<string | null> {
	if (!request.body) {
		return "";
	}
	const reader = request.body.getReader();
	const timer = setTimeout(
		() => {
			reader.cancel().catch(() => undefined);
		},
		Math.max(1, deadline - Date.now()),
	);
	const decoder = new TextDecoder();
	let bytes = 0;
	let body = "";
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) {
				if (Date.now() >= deadline) {
					throw new Error("Notification receive timeout");
				}
				return body + decoder.decode();
			}
			bytes += value.byteLength;
			if (bytes > MAX_BODY_BYTES) {
				await reader.cancel();
				return null;
			}
			body += decoder.decode(value, { stream: true });
		}
	} finally {
		clearTimeout(timer);
		reader.releaseLock();
	}
}

export async function POST(request: NextRequest) {
	const deadline = Date.now() + 2_500;
	const validationToken = request.nextUrl.searchParams.get("validationToken");
	if (validationToken !== null) {
		return new NextResponse(validationToken.slice(0, 1_024), {
			status: 200,
			headers: { "Content-Type": "text/plain" },
		});
	}
	const sessionId = request.nextUrl.searchParams.get("session");
	if (!sessionId || sessionId.length > 128) {
		return NextResponse.json({ error: "Invalid session" }, { status: 400 });
	}
	let raw: string | null;
	try {
		raw = await withTimeout(
			readNotificationBody(request, deadline),
			Math.max(1, deadline - Date.now()),
		);
	} catch {
		return NextResponse.json(
			{ error: "Notification receive timeout" },
			{ status: 503 },
		);
	}
	if (raw === null) {
		return NextResponse.json(
			{ error: "Notification too large" },
			{ status: 413 },
		);
	}
	let body: unknown;
	try {
		body = JSON.parse(raw);
	} catch {
		return NextResponse.json(
			{ error: "Invalid notification" },
			{ status: 400 },
		);
	}
	const parsed = z
		.object({ value: z.array(channelNotificationSchema).max(1_000) })
		.safeParse(body);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid notification" },
			{ status: 400 },
		);
	}
	try {
		const jobs = await withTimeout(
			prepareParlumeChannelNotifications(sessionId, parsed.data.value),
			Math.max(1, deadline - Date.now()),
		);
		await enqueueParlumeChannelNotifications(jobs, deadline);
	} catch {
		// A failed durable enqueue remains retryable by Graph.
		return NextResponse.json(
			{ error: "Channel notification delivery failed" },
			{ status: 503 },
		);
	}
	return NextResponse.json({ accepted: true }, { status: 202 });
}
