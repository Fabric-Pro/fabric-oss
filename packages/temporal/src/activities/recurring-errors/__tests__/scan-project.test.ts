/**
 * The recurring-error scan's decisions for one project: what is filed, what
 * is refreshed instead of filed again, what is ignored, and that every failure
 * leaves an audit row and a visible last-scan error.
 *
 * The database, the log source, the clustering and the AI draft are mocked at
 * their module boundaries; the fingerprinting, redaction, evidence and
 * proposal shaping are the real implementations.
 */
import type { RawErrorGroup } from "@repo/ai/lib/log-context";
import { beforeEach, describe, expect, it, vi } from "vitest";

const db = vi.hoisted(() => ({
	isRecurringErrorScanEnabled: vi.fn(),
	findRecurringErrorSignatures: vi.fn(),
	listRecurringErrorSignatures: vi.fn(),
	resolveSignatureTracking: vi.fn(),
	upsertRecurringErrorSignature: vi.fn(),
	linkRecurringErrorSignature: vi.fn(),
	refreshRecurringErrorProposalEvidence: vi.fn(),
	recordRecurringErrorScanOutcome: vi.fn(),
	createPendingBacklogProposal: vi.fn(),
	createStoryComment: vi.fn(),
	ensureFabricSystemUser: vi.fn(),
	recordAudit: vi.fn(),
	transaction: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	CONFIDENCE_THRESHOLD: 0.7,
	FABRIC_SYSTEM_USER_ID: "fabric-system",
	db: { $transaction: db.transaction },
	isRecurringErrorScanEnabled: db.isRecurringErrorScanEnabled,
	findRecurringErrorSignatures: db.findRecurringErrorSignatures,
	listRecurringErrorSignatures: db.listRecurringErrorSignatures,
	resolveSignatureTracking: db.resolveSignatureTracking,
	upsertRecurringErrorSignature: db.upsertRecurringErrorSignature,
	linkRecurringErrorSignature: db.linkRecurringErrorSignature,
	refreshRecurringErrorProposalEvidence:
		db.refreshRecurringErrorProposalEvidence,
	recordRecurringErrorScanOutcome: db.recordRecurringErrorScanOutcome,
	createPendingBacklogProposal: db.createPendingBacklogProposal,
	createStoryComment: db.createStoryComment,
	ensureFabricSystemUser: db.ensureFabricSystemUser,
	recordAudit: db.recordAudit,
}));

const summarize = vi.hoisted(() => vi.fn());
const resolveRecurringErrorSource = vi.hoisted(() => vi.fn());
vi.mock("../resolve-error-source", () => ({
	resolveRecurringErrorSource,
}));

const findOpenBugClusters = vi.hoisted(() => vi.fn());
vi.mock("../incident-clusters", () => ({ findOpenBugClusters }));

const draftRecurringBugReport = vi.hoisted(() => vi.fn());
vi.mock("../draft-bug-report", () => ({ draftRecurringBugReport }));

const matchOpenBug = vi.hoisted(() => vi.fn());
const rememberProposal = vi.hoisted(() => vi.fn());
const createOpenBugMatcher = vi.hoisted(() => vi.fn());
vi.mock("../match-open-bug", () => ({ createOpenBugMatcher }));

vi.mock("@temporalio/activity", () => ({ heartbeat: () => {} }));

import { scanRecurringErrorsForProject } from "../scan-project";

const INPUT = {
	projectId: "proj_1",
	organizationId: "org_example",
	userId: "user_owner",
	threshold: 5,
	windowHours: 24,
};

function group(overrides: Partial<RawErrorGroup> = {}): RawErrorGroup {
	return {
		kind: "trace",
		key: "Payment provider timed out",
		occurrences: 8,
		firstSeen: "2026-10-21T10:00:00Z",
		lastSeen: "2026-10-22T08:00:00Z",
		affectedUsers: 3,
		components: ["checkout-api"],
		sampleMessages: ["Payment provider timed out after 30s"],
		...overrides,
	};
}

function signature(overrides: Record<string, unknown> = {}) {
	return {
		id: "sig_1",
		projectId: "proj_1",
		source: "LOG",
		fingerprint: "fp",
		sourceStoryIds: [],
		pendingProposalId: null,
		storyId: null,
		occurrenceCount: 6,
		detectedAt: new Date("2026-10-20T00:00:00Z"),
		firstSeenAt: new Date("2026-10-20T00:00:00Z"),
		lastSeenAt: new Date("2026-10-21T00:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	db.isRecurringErrorScanEnabled.mockResolvedValue(true);
	db.findRecurringErrorSignatures.mockResolvedValue([]);
	db.listRecurringErrorSignatures.mockResolvedValue([]);
	db.resolveSignatureTracking.mockResolvedValue({ state: "none" });
	db.upsertRecurringErrorSignature.mockImplementation(
		async (params: { fingerprint: string }) =>
			signature({ fingerprint: params.fingerprint }),
	);
	db.createPendingBacklogProposal.mockImplementation(async () => ({
		id: `prop_${db.createPendingBacklogProposal.mock.calls.length}`,
	}));
	db.transaction.mockImplementation(async (fn: (tx: object) => unknown) =>
		fn({}),
	);
	resolveRecurringErrorSource.mockResolvedValue({
		label: "Azure Monitor",
		reach: "dedicated",
		summarize,
	});
	summarize.mockResolvedValue([]);
	findOpenBugClusters.mockResolvedValue([]);
	matchOpenBug.mockResolvedValue({ match: null, checked: [] });
	createOpenBugMatcher.mockReturnValue({
		check: matchOpenBug,
		remember: rememberProposal,
	});
	draftRecurringBugReport.mockResolvedValue({
		title: "Checkout fails when the payment provider times out",
		description: "evidence\n\n## Summary\nPayments time out.",
		priority: "P1_HIGH",
	});
});

describe("scanRecurringErrorsForProject — gating", () => {
	it("does nothing once the toggle is off, even if the sweep listed the project", async () => {
		db.isRecurringErrorScanEnabled.mockResolvedValue(false);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.status).toBe("disabled");
		expect(resolveRecurringErrorSource).not.toHaveBeenCalled();
		expect(findOpenBugClusters).not.toHaveBeenCalled();
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(db.recordRecurringErrorScanOutcome).not.toHaveBeenCalled();
	});

	it("skips logs quietly when no readable source is configured", async () => {
		resolveRecurringErrorSource.mockResolvedValue(null);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.status).toBe("completed");
		expect(result.logSourceConfigured).toBe(false);
		expect(result.failures).toBe(0);
		expect(db.recordAudit).not.toHaveBeenCalled();
		expect(db.recordRecurringErrorScanOutcome).toHaveBeenCalledWith(
			"proj_1",
			expect.objectContaining({ error: null }),
		);
	});

	it("asks the source for the project's window and threshold", async () => {
		await scanRecurringErrorsForProject(INPUT);

		expect(summarize).toHaveBeenCalledWith({
			lookbackMinutes: 24 * 60,
			minOccurrences: 5,
			maxGroups: 25,
		});
	});

	it("judges sameness at the project's similarity threshold and records it", async () => {
		summarize.mockResolvedValue([group()]);
		findOpenBugClusters.mockResolvedValue([]);

		await scanRecurringErrorsForProject({
			...INPUT,
			similarityThreshold: 0.9,
		});

		expect(createOpenBugMatcher).toHaveBeenCalledWith(
			expect.objectContaining({ similarityThreshold: 0.9 }),
		);
		expect(findOpenBugClusters).toHaveBeenCalledWith(
			expect.objectContaining({ minConfidence: 0.9 }),
		);
		const [params] = db.createPendingBacklogProposal.mock.calls[0];
		expect(params.sourceMetadata.recurringError).toMatchObject({
			similarityThreshold: 0.9,
		});
	});

	it("uses the former fixed similarity threshold for a scan started without one", async () => {
		await scanRecurringErrorsForProject(INPUT);

		expect(createOpenBugMatcher).toHaveBeenCalledWith(
			expect.objectContaining({ similarityThreshold: 0.7 }),
		);
	});

	it("ignores a group below the threshold even if the platform returned it", async () => {
		summarize.mockResolvedValue([group({ occurrences: 4 })]);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.groupsAboveThreshold).toBe(0);
		expect(db.upsertRecurringErrorSignature).not.toHaveBeenCalled();
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
	});
});

describe("scanRecurringErrorsForProject — filing", () => {
	it("files one BUG proposal with the evidence for a new recurring group", async () => {
		summarize.mockResolvedValue([group()]);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(1);
		expect(db.createPendingBacklogProposal).toHaveBeenCalledTimes(1);
		const [params] = db.createPendingBacklogProposal.mock.calls[0];
		expect(params.source).toBe("LOG_MONITOR");
		expect(params.projectId).toBe("proj_1");
		expect(params.organizationId).toBe("org_example");
		expect(params.userId).toBe("user_owner");
		expect(params.summary).toBe(
			"Checkout fails when the payment provider times out",
		);
		const [change] = params.proposal.changes;
		expect(change).toMatchObject({
			type: "bug",
			action: "create",
			kindOverride: "BUG",
			priority: { to: "P1_HIGH" },
			sourceContext: "application_logs",
		});
		expect(params.sourceMetadata.recurringError).toMatchObject({
			source: "LOG",
			occurrences: 8,
			windowHours: 24,
			threshold: 5,
			affectedUsers: 3,
			components: ["checkout-api"],
			firstSeen: "2026-10-21T10:00:00Z",
			lastSeen: "2026-10-22T08:00:00Z",
		});
		expect(params.sourceMetadata.transcript).toContain(
			"Occurrences: 8 in the last 24 hours",
		);
		// The inbox shows the transcript as written, so no Markdown fences.
		expect(params.sourceMetadata.transcript).not.toContain("```");
		// The approved bug names the scan as its reporter.
		expect(params.sourceMetadata.reporterName).toBe(
			"Fabric recurring-error scan",
		);
		// The proposal and the signature's link to it commit together.
		expect(db.linkRecurringErrorSignature).toHaveBeenCalledWith(
			"sig_1",
			{ pendingProposalId: "prop_1", storyId: null },
			expect.anything(),
		);
	});

	it("files distinct problems as separate proposals", async () => {
		summarize.mockResolvedValue([
			group({ key: "Payment provider timed out" }),
			group({ key: "Inventory reservation conflict", occurrences: 6 }),
		]);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(2);
		expect(db.createPendingBacklogProposal).toHaveBeenCalledTimes(2);
		const fingerprints = db.upsertRecurringErrorSignature.mock.calls.map(
			([params]) => params.fingerprint,
		);
		expect(new Set(fingerprints).size).toBe(2);
	});

	it("files one proposal for occurrences that differ only by a varying value", async () => {
		summarize.mockResolvedValue([
			group({ key: "Order 1832 failed", occurrences: 3 }),
			group({ key: "Order 77 failed", occurrences: 3 }),
		]);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.groupsAboveThreshold).toBe(1);
		expect(db.createPendingBacklogProposal).toHaveBeenCalledTimes(1);
	});

	it("files the plain report when the AI draft is unavailable", async () => {
		summarize.mockResolvedValue([group()]);
		draftRecurringBugReport.mockResolvedValue(null);

		await scanRecurringErrorsForProject(INPUT);

		const [params] = db.createPendingBacklogProposal.mock.calls[0];
		expect(params.summary).toMatch(/^Recurring error: /);
		expect(params.proposal.changes[0].description.to).toContain(
			"Occurrences: 8 in the last 24 hours",
		);
	});

	it("never stores or prompts with an unredacted sample", async () => {
		summarize.mockResolvedValue([
			group({
				sampleMessages: [
					"Login failed for dev@example.com password=hunter2",
				],
			}),
		]);

		await scanRecurringErrorsForProject(INPUT);

		const [params] = db.createPendingBacklogProposal.mock.calls[0];
		const stored = JSON.stringify(params);
		expect(stored).not.toContain("dev@example.com");
		expect(stored).not.toContain("hunter2");
		const [draftInput] = draftRecurringBugReport.mock.calls[0];
		expect(JSON.stringify(draftInput)).not.toContain("hunter2");
	});
});

describe("scanRecurringErrorsForProject — a recurrence is not a new ticket", () => {
	beforeEach(() => {
		summarize.mockResolvedValue([group()]);
	});

	it("refreshes the proposal still awaiting review", async () => {
		db.findRecurringErrorSignatures.mockImplementation(
			async (_p: string, _s: string, fps: string[]) => [
				signature({
					fingerprint: fps[0],
					pendingProposalId: "prop_old",
				}),
			],
		);
		db.resolveSignatureTracking.mockResolvedValue({
			state: "pending",
			proposalId: "prop_old",
		});

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.refreshed).toBe(1);
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(db.refreshRecurringErrorProposalEvidence).toHaveBeenCalledWith(
			"prop_old",
			expect.objectContaining({
				recurringError: expect.objectContaining({ occurrences: 8 }),
			}),
		);
	});

	it("adds the new occurrences to the open bug the proposal became", async () => {
		db.findRecurringErrorSignatures.mockImplementation(
			async (_p: string, _s: string, fps: string[]) => [
				signature({
					fingerprint: fps[0],
					pendingProposalId: "prop_old",
				}),
			],
		);
		db.resolveSignatureTracking.mockResolvedValue({
			state: "open-story",
			storyId: "story_9",
			organizationId: "org_example",
		});

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.notedOnStory).toBe(1);
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(db.createStoryComment).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story_9",
				authorType: "AGENT",
				authorId: "fabric-system",
				organizationId: "org_example",
				content: expect.stringContaining("still recurring"),
			}),
		);
		// The increment: what the previous scan saw, then the new evidence.
		const [{ content }] = db.createStoryComment.mock.calls[0];
		expect(content).toContain(
			"The previous scan recorded 6 occurrences, last seen 2026-10-21T00:00:00.000Z.",
		);
		expect(content).toContain("Occurrences: 8 in the last 24 hours");
		expect(content).toContain("Last seen: 2026-10-22T08:00:00Z");
		expect(db.linkRecurringErrorSignature).toHaveBeenCalledWith("sig_1", {
			storyId: "story_9",
		});
		// Followed by its link, not judged: there is no verdict to record.
		expect(content).not.toContain("Judged the same problem");
		expect(db.createStoryComment.mock.calls[0][0].metadata.matches).toBe(
			undefined,
		);
	});

	it("does not repeat a note when nothing new has happened since the last scan", async () => {
		db.findRecurringErrorSignatures.mockImplementation(
			async (_p: string, _s: string, fps: string[]) => [
				signature({
					fingerprint: fps[0],
					lastSeenAt: new Date("2026-10-22T08:00:00Z"),
				}),
			],
		);
		db.resolveSignatureTracking.mockResolvedValue({
			state: "open-story",
			storyId: "story_9",
			organizationId: "org_example",
		});

		await scanRecurringErrorsForProject(INPUT);

		expect(db.createStoryComment).not.toHaveBeenCalled();
	});

	it("adds a new problem to the open bug someone already filed for it", async () => {
		matchOpenBug.mockResolvedValue({
			match: {
				kind: "story",
				storyId: "story_manual",
				identifier: "B-12",
				confidence: 0.9,
			},
			checked: [],
		});

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.notedOnStory).toBe(1);
		expect(result.filed).toBe(0);
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(draftRecurringBugReport).not.toHaveBeenCalled();
		expect(db.createStoryComment).toHaveBeenCalledWith(
			expect.objectContaining({
				storyId: "story_manual",
				authorId: "fabric-system",
				organizationId: "org_example",
				content: expect.stringContaining(
					"Occurrences: 8 in the last 24 hours",
				),
			}),
		);
		// Later scans follow the bug, exactly as if a proposal had become it.
		expect(db.linkRecurringErrorSignature).toHaveBeenCalledWith("sig_1", {
			storyId: "story_manual",
		});
		// The verdict that put the error here, against the project's bar.
		const [{ content, metadata }] = db.createStoryComment.mock.calls[0];
		expect(content).toContain(
			"Judged the same problem with confidence 0.90; this project groups at 0.70 or above.",
		);
		expect(metadata.matches).toEqual([
			{
				fingerprint: expect.any(String),
				confidence: 0.9,
				similarityThreshold: 0.7,
			},
		]);
	});

	it("writes one note when several error groups of one problem match the same bug", async () => {
		summarize.mockResolvedValue([
			group(),
			group({
				key: "Checkout gateway returned 504",
				sampleMessages: ["Checkout gateway returned 504"],
			}),
		]);
		matchOpenBug.mockResolvedValue({
			match: {
				kind: "story",
				storyId: "story_manual",
				identifier: "B-12",
				confidence: 0.9,
			},
			checked: [],
		});

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.notedOnStory).toBe(2);
		expect(db.createStoryComment).toHaveBeenCalledTimes(1);
		const [{ content, metadata }] = db.createStoryComment.mock.calls[0];
		expect(content).toContain("found 2 recurring errors for this bug");
		expect(content).toContain("Payment provider timed out after 30s");
		expect(content).toContain("Checkout gateway returned 504");
		// Comments are shown as written: no Markdown fences in a note.
		expect(content).not.toContain("```");
		expect(content).toContain("\n    Checkout gateway returned 504");
		expect(metadata.fingerprints).toHaveLength(2);
	});

	it("adds an error group to a pending proposal for the same problem instead of filing another", async () => {
		matchOpenBug.mockResolvedValue({
			match: {
				kind: "proposal",
				proposalId: "prop_same",
				identifier: "Fix checkout timeouts",
				confidence: 0.85,
			},
			checked: [],
		});
		db.refreshRecurringErrorProposalEvidence.mockResolvedValue(true);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.grouped).toBe(1);
		expect(result.filed).toBe(0);
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(db.refreshRecurringErrorProposalEvidence).toHaveBeenCalledWith(
			"prop_same",
			expect.objectContaining({
				title: "payment provider timed out after 30s",
				transcript: expect.stringContaining(
					"Occurrences: 8 in the last 24 hours",
				),
				recurringError: expect.objectContaining({
					matchConfidence: 0.85,
					similarityThreshold: 0.7,
				}),
			}),
		);
		// Later scans refresh that proposal for this group, and follow the bug
		// it becomes.
		expect(db.linkRecurringErrorSignature).toHaveBeenCalledWith("sig_1", {
			pendingProposalId: "prop_same",
			storyId: null,
		});
	});

	it("files its own proposal when the proposal it matched was reviewed meanwhile", async () => {
		matchOpenBug.mockResolvedValue({
			match: {
				kind: "proposal",
				proposalId: "prop_gone",
				identifier: "Fix checkout timeouts",
				confidence: 0.85,
			},
			checked: [],
		});
		db.refreshRecurringErrorProposalEvidence.mockResolvedValue(false);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(1);
		expect(result.grouped).toBe(0);
	});

	it("offers each proposal it files to the later groups of the same scan", async () => {
		await scanRecurringErrorsForProject(INPUT);

		expect(rememberProposal).toHaveBeenCalledWith(
			expect.objectContaining({
				excerpts: ["Payment provider timed out after 30s"],
			}),
			"prop_1",
			"Checkout fails when the payment provider times out",
		);
	});

	it("records the open bugs it ruled out on the proposal it files", async () => {
		const checked = [
			{
				identifier: "B-12",
				similarity: 0.31,
				relationship: "overlapping_scope",
				confidence: 0.8,
			},
			{
				identifier: "B-4",
				similarity: 0.12,
				relationship: null,
				confidence: null,
			},
		];
		matchOpenBug.mockResolvedValue({ match: null, checked });

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(1);
		const [params] = db.createPendingBacklogProposal.mock.calls[0];
		expect(params.sourceMetadata.recurringError).toMatchObject({
			occurrences: 8,
			openBugCheck: checked,
		});
	});

	it("only looks for an open bug when the problem is not already tracked", async () => {
		db.findRecurringErrorSignatures.mockImplementation(
			async (_p: string, _s: string, fps: string[]) => [
				signature({
					fingerprint: fps[0],
					pendingProposalId: "prop_old",
				}),
			],
		);
		db.resolveSignatureTracking.mockResolvedValue({
			state: "pending",
			proposalId: "prop_old",
		});

		await scanRecurringErrorsForProject(INPUT);

		expect(matchOpenBug).not.toHaveBeenCalled();
	});

	it("does not re-file a problem a reviewer rejected", async () => {
		db.findRecurringErrorSignatures.mockImplementation(
			async (_p: string, _s: string, fps: string[]) => [
				signature({
					fingerprint: fps[0],
					pendingProposalId: "prop_old",
				}),
			],
		);
		db.resolveSignatureTracking.mockResolvedValue({
			state: "declined",
			proposalId: "prop_old",
		});

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.suppressed).toBe(1);
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		expect(db.createStoryComment).not.toHaveBeenCalled();
	});
});

describe("scanRecurringErrorsForProject — failures are visible", () => {
	it("audits a failed open-bug lookup and still files the proposal", async () => {
		summarize.mockResolvedValue([group()]);
		matchOpenBug.mockRejectedValue(
			new Error("embedding gateway timed out"),
		);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(1);
		expect(result.status).toBe("completed-with-errors");
		expect(db.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "backlog.recurring_errors.scan_failed",
				metadata: expect.objectContaining({
					stage: "open-bug-match",
					reason: "embedding gateway timed out",
				}),
			}),
		);
	});

	it("audits and records a log-source failure, then still checks incidents", async () => {
		summarize.mockRejectedValue(
			new Error("Azure Monitor query failed with 403"),
		);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.status).toBe("completed-with-errors");
		expect(db.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "backlog.recurring_errors.scan_failed",
				outcome: "failure",
				organizationId: "org_example",
				projectId: "proj_1",
				actor: { type: "system", nameSnapshot: "recurring-error-scan" },
				metadata: expect.objectContaining({
					stage: "log-source",
					reason: "Azure Monitor query failed with 403",
				}),
			}),
		);
		expect(db.recordRecurringErrorScanOutcome).toHaveBeenCalledWith(
			"proj_1",
			expect.objectContaining({
				error: "log-source: Azure Monitor query failed with 403",
			}),
		);
		expect(findOpenBugClusters).toHaveBeenCalled();
	});

	it("records a project binding that cannot be used as the last-scan error", async () => {
		// What the resolver throws for an unknown provider, incomplete settings
		// or the deployment's shared workspace (see resolve-error-source).
		const reason =
			"The project's log source could not be used: it names this deployment's shared telemetry workspace, or its settings are incomplete.";
		resolveRecurringErrorSource.mockRejectedValue(new Error(reason));

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.status).toBe("completed-with-errors");
		expect(result.logSourceConfigured).toBe(true);
		expect(result.failures).toBe(1);
		expect(db.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "backlog.recurring_errors.scan_failed",
				metadata: expect.objectContaining({
					stage: "log-source",
					reason,
				}),
			}),
		);
		expect(db.recordRecurringErrorScanOutcome).toHaveBeenCalledWith(
			"proj_1",
			expect.objectContaining({ error: `log-source: ${reason}` }),
		);
		expect(summarize).not.toHaveBeenCalled();
		expect(findOpenBugClusters).toHaveBeenCalled();
	});

	it("keeps filing the other groups when one proposal cannot be created", async () => {
		summarize.mockResolvedValue([
			group({ key: "Payment provider timed out", occurrences: 9 }),
			group({ key: "Inventory reservation conflict", occurrences: 6 }),
		]);
		db.createPendingBacklogProposal
			.mockRejectedValueOnce(new Error("write conflict"))
			.mockResolvedValueOnce({ id: "prop_2" });

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(1);
		expect(result.failures).toBe(1);
		expect(db.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({
					stage: "proposal",
					source: "LOG",
				}),
			}),
		);
	});
});

describe("scanRecurringErrorsForProject — incident clusters", () => {
	const stories = [
		{ id: "s1", identifier: "B-1", title: "Export hangs" },
		{ id: "s2", identifier: "B-2", title: "Export never finishes" },
		{ id: "s3", identifier: "B-3", title: "CSV export stuck" },
		{ id: "s4", identifier: "B-4", title: "Export spinner forever" },
		{ id: "s5", identifier: "B-5", title: "Export times out" },
	];

	it("files one consolidating BUG naming every source report", async () => {
		resolveRecurringErrorSource.mockResolvedValue(null);
		findOpenBugClusters.mockResolvedValue([stories]);

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(findOpenBugClusters).toHaveBeenCalledWith(
			expect.objectContaining({ minSize: 5, projectId: "proj_1" }),
		);
		expect(result.clusters).toBe(1);
		expect(result.filed).toBe(1);
		const [params] = db.createPendingBacklogProposal.mock.calls[0];
		expect(params.source).toBe("INCIDENT_CLUSTER");
		expect(params.proposal.changes[0]).toMatchObject({
			type: "bug",
			kindOverride: "BUG",
			sourceContext: "bug_reports",
		});
		expect(
			params.sourceMetadata.recurringError.stories.map(
				(story: { identifier: string }) => story.identifier,
			),
		).toEqual(["B-1", "B-2", "B-3", "B-4", "B-5"]);
		const [upsert] = db.upsertRecurringErrorSignature.mock.calls[0];
		expect(upsert.source).toBe("INCIDENT");
		expect(upsert.observation.sourceStoryIds).toEqual([
			"s1",
			"s2",
			"s3",
			"s4",
			"s5",
		]);
	});

	it("continues the cluster it already filed when a report joins it", async () => {
		resolveRecurringErrorSource.mockResolvedValue(null);
		db.listRecurringErrorSignatures.mockResolvedValue([
			signature({
				source: "INCIDENT",
				fingerprint: "fp_cluster",
				sourceStoryIds: ["s1", "s2", "s3", "s4"],
				pendingProposalId: "prop_old",
				storyId: "consolidated",
			}),
		]);
		db.resolveSignatureTracking.mockResolvedValue({
			state: "pending",
			proposalId: "prop_old",
		});
		findOpenBugClusters.mockResolvedValue([stories]);

		await scanRecurringErrorsForProject(INPUT);

		expect(findOpenBugClusters).toHaveBeenCalledWith(
			expect.objectContaining({
				excludeStoryIds: new Set(["consolidated"]),
			}),
		);
		expect(db.createPendingBacklogProposal).not.toHaveBeenCalled();
		const [upsert] = db.upsertRecurringErrorSignature.mock.calls[0];
		expect(upsert.fingerprint).toBe("fp_cluster");
	});

	it("audits a clustering failure without losing the log results", async () => {
		summarize.mockResolvedValue([group()]);
		findOpenBugClusters.mockRejectedValue(new Error("embedding outage"));

		const result = await scanRecurringErrorsForProject(INPUT);

		expect(result.filed).toBe(1);
		expect(db.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				metadata: expect.objectContaining({ stage: "incidents" }),
			}),
		);
	});
});
