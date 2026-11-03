import {
	channelNotificationJobSchema,
	deliverParlumeChannelNotification,
} from "@repo/api/modules/projects/lib/parlume-channel-chat";
import { type NextRequest, NextResponse } from "next/server";
import { isParlumeServiceRequestAuthorized } from "../../lib";

export async function POST(request: NextRequest) {
	if (
		!isParlumeServiceRequestAuthorized(
			request.headers.get("X-Agent-Service-Token"),
		)
	) {
		return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
	}
	const parsed = channelNotificationJobSchema.safeParse(
		await request.json().catch(() => null),
	);
	if (!parsed.success) {
		return NextResponse.json(
			{ error: "Invalid notification job" },
			{ status: 400 },
		);
	}
	try {
		await deliverParlumeChannelNotification(parsed.data);
	} catch {
		return NextResponse.json(
			{ error: "Channel notification delivery failed" },
			{ status: 503 },
		);
	}
	return NextResponse.json({ accepted: true });
}
