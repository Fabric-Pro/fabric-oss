/**
 * Unified channel webhook route.
 *
 *   POST /api/webhooks/channels/<channel>/events
 *
 * Thin entry point — all behavior lives in `handleChannelInbound`. The same
 * helper is also used by the legacy `/api/webhooks/slack/events` route so
 * Slack apps can keep their existing webhook URL while running through the
 * unified pipeline.
 */

import { handleChannelInbound } from "../../../../../../lib/channels/inbound-handler";
import type { NextRequest } from "next/server";

export async function POST(
	req: NextRequest,
	{ params }: { params: Promise<{ channel: string }> },
) {
	const { channel } = await params;
	return handleChannelInbound(channel, req);
}
