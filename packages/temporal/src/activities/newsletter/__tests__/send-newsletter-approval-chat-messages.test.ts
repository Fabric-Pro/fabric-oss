import { beforeEach, describe, expect, it, vi } from "vitest";

// heartbeat() throws outside an activity context; mock it.
vi.mock("@temporalio/activity", () => ({ heartbeat: vi.fn() }));

// vi.fn()'s nullary type + a spread wrapper trips TS2556 ("spread argument
// must be a tuple or match a rest parameter") because the real function takes
// a single typed-object parameter, not a rest param — same shape as
// markChatDelivery's wrapper in send-newsletter-chat-messages.test.ts.
const renderNewsletterApprovalChatMessage = vi.fn(
	(_input: unknown) => "rendered",
);
vi.mock("@repo/utils", () => ({
	renderNewsletterApprovalChatMessage: (input: unknown) =>
		renderNewsletterApprovalChatMessage(input),
}));

const resolveNewsletterReviewRecipients = vi.fn();
const isProjectReadOnly = vi.fn();
const getNewsletterSettings = vi.fn();
const getNewsletterSendForSendPhase = vi.fn();
const getNewsletterSendStatus = vi.fn();
const buildReleaseNotesUrl = vi.fn();
const isFeatureEnabled = vi.fn();
vi.mock("@repo/database", async () => {
	const actual =
		await vi.importActual<typeof import("@repo/database")>(
			"@repo/database",
		);
	return {
		// Real schemas (newsletterApprovalChatChannelSchema, newsletterContentSchema)
		// come from the actual module — only the DB-backed reads are mocked at
		// this activity's unit boundary.
		newsletterApprovalChatChannelSchema:
			actual.newsletterApprovalChatChannelSchema,
		newsletterContentSchema: actual.newsletterContentSchema,
		resolveNewsletterReviewRecipients: (...a: unknown[]) =>
			resolveNewsletterReviewRecipients(...a),
		isProjectReadOnly: (...a: unknown[]) => isProjectReadOnly(...a),
		getNewsletterSettings: (...a: unknown[]) => getNewsletterSettings(...a),
		getNewsletterSendForSendPhase: (...a: unknown[]) =>
			getNewsletterSendForSendPhase(...a),
		getNewsletterSendStatus: (...a: unknown[]) =>
			getNewsletterSendStatus(...a),
		buildReleaseNotesUrl: (...a: unknown[]) => buildReleaseNotesUrl(...a),
		isFeatureEnabled: (...a: unknown[]) => isFeatureEnabled(...a),
	};
});

const deliverChatMessages = vi.fn();
vi.mock("../chat-delivery-engine", () => ({
	deliverChatMessages: (...a: unknown[]) => deliverChatMessages(...a),
}));

const warn = vi.fn();
vi.mock("@repo/logs", () => ({
	logger: {
		warn: (...a: unknown[]) => warn(...a),
		info: vi.fn(),
		error: vi.fn(),
	},
}));

import { sendNewsletterApprovalChatMessagesActivity } from "../send-newsletter-approval-chat-messages";

const reviewContext = {
	sendId: "s1",
	projectId: "p1",
	projectName: "Example Project",
	organizationId: "org-1",
	organizationSlug: "example-org",
	recipients: [],
};

const oneChannel = [
	{ platform: "SLACK" as const, teamId: "t1", channelId: "c1" },
];

const contentWithHighlights = {
	schemaVersion: 1,
	headline: "H",
	intro: "i",
	highlights: [
		{ title: "One", description: "d1" },
		{ title: "Two", description: "d2" },
	],
	hasMajorFeatures: true,
};

const sendRow = {
	id: "s1",
	projectId: "p1",
	organizationId: "org-1",
	userId: "u1",
	status: "PENDING_APPROVAL",
	content: contentWithHighlights,
	deliveryDestination: "CHAT",
	chatChannels: [],
	removedHighlightIndexes: [],
	timeWindowEnd: new Date(),
};

describe("sendNewsletterApprovalChatMessagesActivity", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		isFeatureEnabled.mockResolvedValue(true);
		resolveNewsletterReviewRecipients.mockResolvedValue(reviewContext);
		isProjectReadOnly.mockResolvedValue(false);
		getNewsletterSettings.mockResolvedValue({
			approvalChatChannels: oneChannel,
		});
		getNewsletterSendForSendPhase.mockResolvedValue(sendRow);
		getNewsletterSendStatus.mockResolvedValue("PENDING_APPROVAL");
		buildReleaseNotesUrl.mockResolvedValue(
			"https://example.com/app/example-org/projects/p1?tab=release-notes",
		);
		deliverChatMessages.mockResolvedValue({
			targetCount: 1,
			sentCount: 1,
			failedCount: 0,
			skippedCount: 0,
		});
	});

	it("does nothing when the master flag is off", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		// Pins the registry key, not just "some flag was consulted". The key is
		// also type-checked against FeatureFlagKey, so this is belt-and-braces —
		// but it is the only runtime tie between this activity and the registry.
		expect(isFeatureEnabled).toHaveBeenCalledWith(
			"NEWSLETTER_APPROVAL_CHAT",
		);
		expect(resolveNewsletterReviewRecipients).not.toHaveBeenCalled();
		expect(getNewsletterSettings).not.toHaveBeenCalled();
		expect(deliverChatMessages).not.toHaveBeenCalled();
	});

	it("does nothing when the send is no longer awaiting review", async () => {
		// resolveNewsletterReviewRecipients returns null for any send that is not
		// PENDING_APPROVAL (or no longer exists) — the same gate the reviewer
		// email relies on.
		resolveNewsletterReviewRecipients.mockResolvedValue(null);

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		expect(getNewsletterSettings).not.toHaveBeenCalled();
		expect(deliverChatMessages).not.toHaveBeenCalled();
	});

	it("does nothing when the project is read-only", async () => {
		isProjectReadOnly.mockResolvedValue(true);

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		expect(getNewsletterSettings).not.toHaveBeenCalled();
		expect(deliverChatMessages).not.toHaveBeenCalled();
	});

	it("does nothing when no channels are configured, and writes zero ledger rows", async () => {
		getNewsletterSettings.mockResolvedValue({ approvalChatChannels: [] });

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		// deliverChatMessages is the only path to a ledger write in this
		// activity, so asserting it was never invoked IS the "zero rows"
		// assertion at this test's boundary.
		expect(deliverChatMessages).not.toHaveBeenCalled();
		// The nothing-configured case is the NORMAL one — it must stay quiet, or
		// the malformed-configuration warning below is noise nobody reads.
		expect(warn).not.toHaveBeenCalled();
	});

	// `.catch([])` sits on the array, so one bad element discards the whole
	// list and the activity returns as "nothing configured". Keeping that
	// fail-safe is right; leaving it silent is not — a corrupt configuration
	// would be indistinguishable from an absent one.
	it("warns, and still posts nothing, when one malformed entry discards the whole channel list", async () => {
		getNewsletterSettings.mockResolvedValue({
			approvalChatChannels: [
				{ platform: "SLACK", teamId: "t1", channelId: "c1" },
				{ platform: "SLACK", teamId: "t2" }, // no channelId
			],
		});

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		expect(deliverChatMessages).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/failed validation/i),
			expect.objectContaining({
				sendId: "s1",
				projectId: "p1",
				configuredCount: 2,
			}),
		);
	});

	// A stored value that is not an array at all fails the same way and is the
	// same class of corruption, so it must not slip through the `.length` check.
	it("warns when the stored value is not an array at all", async () => {
		getNewsletterSettings.mockResolvedValue({
			approvalChatChannels: { platform: "SLACK" },
		});

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		expect(deliverChatMessages).not.toHaveBeenCalled();
		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/failed validation/i),
			expect.objectContaining({ configuredCount: null }),
		);
	});

	it("does nothing for an org project whose organization has no slug, and writes zero ledger rows", async () => {
		resolveNewsletterReviewRecipients.mockResolvedValue({
			...reviewContext,
			organizationSlug: null,
		});

		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		// No correct /app/{slug}/… link exists, and summoning a reviewer to a
		// route that cannot load is worse than staying quiet.
		expect(deliverChatMessages).not.toHaveBeenCalled();
		expect(getNewsletterSendForSendPhase).not.toHaveBeenCalled();
	});

	it("delivers with kind APPROVAL and a stillWanted precondition", async () => {
		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		expect(deliverChatMessages).toHaveBeenCalledTimes(1);
		const call = deliverChatMessages.mock.calls[0][0];
		expect(call.kind).toBe("APPROVAL");
		expect(call.sendId).toBe("s1");
		expect(call.projectId).toBe("p1");
		expect(call.organizationId).toBe("org-1");
		expect(call.userId).toBe("u1");
		expect(call.channels).toEqual(oneChannel);
		expect(typeof call.stillWanted).toBe("function");

		// renderText renders per-target from the frozen content's highlight count
		// (2) and the project name resolved for the send.
		call.renderText("SLACK");
		expect(renderNewsletterApprovalChatMessage).toHaveBeenCalledWith({
			projectName: "Example Project",
			highlightCount: 2,
			link: "https://example.com/app/example-org/projects/p1?tab=release-notes",
			platform: "SLACK",
		});
	});

	it("stillWanted re-reads the send status live, per call, rather than a value captured at dispatch", async () => {
		await sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" });

		const { stillWanted } = deliverChatMessages.mock.calls[0][0];

		// The dispatch-time read (inside the activity itself) already resolved
		// PENDING_APPROVAL via the default mock, so if stillWanted closed over
		// that value instead of re-reading, both assertions below would return
		// true regardless of what the mock is set to next.
		await expect(stillWanted()).resolves.toBe(true);

		// Flip the live status to a real terminal value from the send-status
		// union and confirm stillWanted tracks the change on its NEXT call —
		// proving it reads current state, not a snapshot from construction.
		//
		// Flips the NARROW status query, because that is what stillWanted reads.
		// The wide send-phase query runs ONCE at dispatch and must not be
		// re-read per target — it carries the curated content JSON, and the
		// targets fan out concurrently up to the 50-channel cap.
		getNewsletterSendStatus.mockResolvedValue("APPROVED");
		await expect(stillWanted()).resolves.toBe(false);
	});

	it("logs but does not throw when a provider post fails", async () => {
		deliverChatMessages.mockResolvedValue({
			targetCount: 1,
			sentCount: 0,
			failedCount: 1,
			skippedCount: 0,
		});

		// The retry could not re-attempt the target anyway: a failed channel
		// already holds its ledger claim, so this must resolve, not reject.
		await expect(
			sendNewsletterApprovalChatMessagesActivity({ sendId: "s1" }),
		).resolves.toBeUndefined();

		expect(warn).toHaveBeenCalledWith(
			expect.stringMatching(/partially failed/i),
			expect.objectContaining({
				sendId: "s1",
				failedCount: 1,
				sentCount: 0,
				skippedCount: 0,
			}),
		);
	});
});
