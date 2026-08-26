/**
 * Teams Events Procedure
 *
 * Provides API access to Teams event handling status.
 * The actual webhook handler is at /api/webhooks/teams/events (Next.js route).
 */

import { publicProcedure } from "../../../orpc/procedures";

export const getTeamsEventsStatusProcedure = publicProcedure.handler(
	async () => {
		return {
			status: "ok",
			webhookEndpoint: "/api/webhooks/teams/events",
			supportedEvents: ["message"],
			features: [
				"@mention handling",
				"thread continuity",
				"agent invocation",
			],
		};
	},
);
