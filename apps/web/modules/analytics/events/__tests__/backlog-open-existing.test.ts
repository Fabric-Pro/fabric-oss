/**
 * Locks the event-name casing and the panel discriminator union for the
 * "open existing ticket from a proposal panel" affordance (spec §9.2 /
 * FR-11 / AC-8). A real analytics provider keys off this exact string, so
 * an accidental rename would silently break telemetry.
 */

import { describe, expect, it } from "vitest";
import {
	BACKLOG_OPEN_EXISTING_EVENT,
	type BacklogOpenExistingPayload,
	type BacklogProposalPanel,
} from "../backlog-open-existing";

describe("backlog-open-existing event registry", () => {
	it("locks the event name to the dotted-casing constant", () => {
		expect(BACKLOG_OPEN_EXISTING_EVENT).toBe(
			"backlog.proposal.openExistingTicket",
		);
	});

	it("accepts both panel discriminators in the payload type", () => {
		// Compile-time guard surfaced as a runtime assertion: both members of
		// the union are assignable, and the payload carries exactly `panel`.
		const aiUpdate: BacklogProposalPanel = "ai-update";
		const featureProposals: BacklogProposalPanel = "feature-proposals";
		const payloads: BacklogOpenExistingPayload[] = [
			{ panel: aiUpdate },
			{ panel: featureProposals },
		];

		expect(payloads.map((p) => p.panel)).toEqual([
			"ai-update",
			"feature-proposals",
		]);
	});
});
