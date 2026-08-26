/**
 * Retired: the shared pull-request review webhook.
 *
 * Endpoint: POST /api/webhooks/github/pull-request → 410 Gone
 * Replacement: POST /api/webhooks/github/pull-request/{projectId}
 *
 * This endpoint verified one deployment-wide `GITHUB_WEBHOOK_SECRET`, and the
 * setup instructions gave that value to every customer admin who connected a
 * repository. A signed delivery therefore proved only that somebody holding the
 * deployment secret sent it, while the repository URL inside it was chosen by
 * whoever sent it — so anyone who had ever configured the feature could name
 * another tenant's repository and have Fabric read that tenant's source, spend
 * their credits, and comment in their pull request under their own credential.
 *
 * Guarding it was tried and is not enough: refusing a delivery that resolves to
 * more than one tenant cuts the reach from every tenant to one, and cannot do
 * better, because a shared secret does not identify a sender.
 *
 * 410 rather than the 200-for-everything rule the live endpoints follow. That
 * rule exists so a WORKING webhook is not throttled or disabled by the platform
 * for answering 4xx to deliveries that were never ours. Here the opposite is
 * wanted: this path is deliberately dead, and a delivery still pointed at it
 * should fail visibly in the sender's own deliveries tab so somebody moves it.
 */

import { NextResponse } from "next/server";

const REPLACEMENT =
	"/api/webhooks/github/pull-request/{projectId} — see Settings ▸ Testing for the project's own webhook secret";

function gone() {
	return NextResponse.json(
		{
			handled: false,
			reason: "endpoint-retired",
			replacement: REPLACEMENT,
		},
		{ status: 410 },
	);
}

export async function POST() {
	return gone();
}

/** Some services probe with GET before they will save a webhook URL. */
export async function GET() {
	return gone();
}
