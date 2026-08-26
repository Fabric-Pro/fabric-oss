/**
 * Slack Events API webhook (legacy URL).
 *
 * Slice 5b.1: this route now delegates to the unified channel handler so
 * existing Slack apps don't need to reconfigure their webhook URL. All
 * verification, dedup, thread mapping, and Temporal dispatch is identical
 * to /api/webhooks/channels/slack/events.
 *
 * The pre-5b implementation is preserved at route.legacy.ts.bak for
 * forensic reference until the next housekeeping pass.
 */

import { handleChannelInbound } from "../../../../../lib/channels/inbound-handler";
import type { NextRequest } from "next/server";

export async function POST(request: NextRequest) {
	return handleChannelInbound("slack", request);
}
