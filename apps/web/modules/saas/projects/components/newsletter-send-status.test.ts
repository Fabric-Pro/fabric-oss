import { describe, expect, it } from "vitest";
import {
	formatChatDeliveryStatus,
	formatNewsletterSendStatus,
	hasExpiredRepoIntegrations,
	isSendsListKeyForProject,
} from "./newsletter-send-status";

describe("formatNewsletterSendStatus", () => {
	it("maps terminal statuses", () => {
		expect(formatNewsletterSendStatus("SENT")).toEqual({
			label: "Sent",
			variant: "success",
		});
		expect(formatNewsletterSendStatus("PENDING")).toEqual({
			label: "Sending…",
			variant: "info",
		});
		expect(formatNewsletterSendStatus("PARTIAL")).toEqual({
			label: "Partially sent",
			variant: "warning",
		});
		expect(formatNewsletterSendStatus("FAILED")).toEqual({
			label: "Failed",
			variant: "error",
		});
	});
	it("calls a gated send Preparing while it is still being curated", () => {
		// On an approval-gated project PENDING is the PRE-review state: the
		// workflow is gathering merged pull requests and running curation, and
		// holdNewsletterForApproval moves the row on afterwards. "Sending…"
		// tells the reviewer the issue already went out, and a worker that dies
		// mid-curation leaves the row saying so forever (Fizzy #2172).
		expect(formatNewsletterSendStatus("PENDING", null, true)).toEqual({
			label: "Preparing…",
			variant: "info",
		});
	});
	it("still calls an ungated PENDING send Sending", () => {
		expect(formatNewsletterSendStatus("PENDING", null, false)).toEqual({
			label: "Sending…",
			variant: "info",
		});
	});
	it("reproduces today's output when the gate flag is omitted", () => {
		expect(formatNewsletterSendStatus("PENDING")).toEqual({
			label: "Sending…",
			variant: "info",
		});
	});
	it("ignores the gate flag for every other status", () => {
		expect(formatNewsletterSendStatus("SENT", null, true).label).toBe(
			"Sent",
		);
		expect(
			formatNewsletterSendStatus("PENDING_APPROVAL", null, true).label,
		).toBe("Awaiting review");
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "NO_RELEASES", true)
				.label,
		).toBe("No new releases");
	});
	it("maps approval-gate statuses (Fizzy 1869) to human labels, never raw enum", () => {
		expect(formatNewsletterSendStatus("PENDING_APPROVAL")).toEqual({
			label: "Awaiting review",
			variant: "warning",
		});
		expect(formatNewsletterSendStatus("APPROVED")).toEqual({
			label: "Approved",
			variant: "info",
		});
		expect(formatNewsletterSendStatus("REJECTED")).toEqual({
			label: "Rejected",
			variant: "secondary",
		});
		expect(formatNewsletterSendStatus("EXPIRED")).toEqual({
			label: "Review expired",
			variant: "secondary",
		});
	});
	it("maps every skip reason", () => {
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "NO_ACTIVE_REPOS"),
		).toEqual({ label: "Repositories disconnected", variant: "warning" });
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "NO_RELEASES"),
		).toEqual({ label: "No new releases", variant: "secondary" });
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "NO_MAJOR_FEATURES"),
		).toEqual({ label: "No major updates", variant: "secondary" });
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "INCOMPLETE_SCAN"),
		).toEqual({ label: "Scan incomplete", variant: "warning" });
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "NO_SUBSCRIBERS"),
		).toEqual({ label: "No subscribers", variant: "warning" });
	});
	it("falls back for null/unknown skip reason and unknown status", () => {
		expect(formatNewsletterSendStatus("SKIPPED_EMPTY", null)).toEqual({
			label: "Skipped",
			variant: "secondary",
		});
		expect(formatNewsletterSendStatus("SKIPPED_EMPTY", "WAT")).toEqual({
			label: "Skipped",
			variant: "secondary",
		});
		expect(formatNewsletterSendStatus("MYSTERY")).toEqual({
			label: "MYSTERY",
			variant: "secondary",
		});
	});
	it("labels a chat-only send with no live targets", () => {
		// computeDeliveryOutcome emits NO_CHAT_TARGETS for a CHAT-destination send
		// whose selected channels all resolved away. Without a case here the badge
		// renders a bare "Skipped", which reads identically to "no new releases".
		expect(
			formatNewsletterSendStatus("SKIPPED_EMPTY", "NO_CHAT_TARGETS"),
		).toEqual({
			label: "No chat channels",
			variant: "warning",
		});
	});
});

describe("formatChatDeliveryStatus", () => {
	it("labels an unconfirmed chat delivery as unconfirmed, not skipped", () => {
		expect(formatChatDeliveryStatus("SENDING")).toEqual({
			label: "Unconfirmed",
			variant: "warning",
		});
		expect(formatChatDeliveryStatus("SENT")).toEqual({
			label: "Delivered",
			variant: "success",
		});
		expect(formatChatDeliveryStatus("FAILED")).toEqual({
			label: "Failed",
			variant: "error",
		});
	});

	// The fourth status had no case. It was rare for the newsletter ledger; for
	// the publishing broadcast it is not — the two skip classifications are a
	// large part of why that panel exists — so without this the case could be
	// deleted and the badge would render the raw enum.
	it("labels a skipped chat delivery", () => {
		expect(formatChatDeliveryStatus("SKIPPED")).toEqual({
			label: "Skipped",
			variant: "secondary",
		});
	});
});

describe("hasExpiredRepoIntegrations", () => {
	it("true when any integration is not ACTIVE", () => {
		expect(
			hasExpiredRepoIntegrations([
				{ status: "ACTIVE" },
				{ status: "TOKEN_EXPIRED" },
			]),
		).toBe(true);
	});
	it("false when all active or list empty", () => {
		expect(hasExpiredRepoIntegrations([{ status: "ACTIVE" }])).toBe(false);
		expect(hasExpiredRepoIntegrations([])).toBe(false);
	});
});

describe("isSendsListKeyForProject", () => {
	// Real oRPC key shape (v1.13.x): [path, { type, input }]
	// path = ["newsletter", "sends", "list"], options = { type: "query", input: { ... } }
	const sameInput = {
		projectId: "p1",
		organizationId: null,
		limit: 50,
		offset: 100,
		status: "sent",
	};

	it("matches the sends.list key for the project, ignoring paging/filter", () => {
		const key = [
			["newsletter", "sends", "list"],
			{ input: sameInput, type: "query" },
		];
		expect(
			isSendsListKeyForProject(key, {
				projectId: "p1",
				organizationId: null,
			}),
		).toBe(true);
	});

	it("rejects the sends.list key for a different project", () => {
		const key = [
			["newsletter", "sends", "list"],
			{ input: sameInput, type: "query" },
		];
		expect(
			isSendsListKeyForProject(key, {
				projectId: "p2",
				organizationId: null,
			}),
		).toBe(false);
	});

	it("rejects settings.get even with the same project input", () => {
		const key = [
			["newsletter", "settings", "get"],
			{ input: { projectId: "p1", organizationId: null }, type: "query" },
		];
		expect(
			isSendsListKeyForProject(key, {
				projectId: "p1",
				organizationId: null,
			}),
		).toBe(false);
	});

	it("rejects subscribers.list even with the same project input (trailing 'list' is not enough)", () => {
		const key = [
			["newsletter", "subscribers", "list"],
			{ input: { projectId: "p1", organizationId: null }, type: "query" },
		];
		expect(
			isSendsListKeyForProject(key, {
				projectId: "p1",
				organizationId: null,
			}),
		).toBe(false);
	});
});
