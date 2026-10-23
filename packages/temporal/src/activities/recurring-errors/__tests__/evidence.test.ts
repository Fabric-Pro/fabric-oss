import { describe, expect, it } from "vitest";
import {
	buildRecurringBugProposal,
	fallbackLogDraft,
	redactErrorGroup,
	renderIncidentEvidence,
	renderLogEvidence,
} from "../evidence";
import type { FingerprintedErrorGroup } from "../fingerprint";

function group(
	overrides: Partial<FingerprintedErrorGroup> = {},
): FingerprintedErrorGroup {
	return {
		fingerprint: "fp_1",
		kind: "exception",
		key: "System.InvalidOperationException at Sync.Run",
		occurrences: 12,
		firstSeen: "2026-10-21T10:00:00Z",
		lastSeen: "2026-10-22T09:00:00Z",
		affectedUsers: 4,
		components: ["sync-worker"],
		sampleMessages: [
			"Sync failed for dev@example.com with Authorization: Bearer abc.def.ghi",
		],
		exceptionType: "System.InvalidOperationException",
		...overrides,
	};
}

describe("redactErrorGroup", () => {
	it("redacts every sample before it is stored or shown", () => {
		const redacted = redactErrorGroup(group());
		expect(redacted.excerpts).toHaveLength(1);
		expect(redacted.excerpts[0]).not.toContain("dev@example.com");
		expect(redacted.excerpts[0]).not.toContain("abc.def.ghi");
		expect(redacted.excerpts[0]).toContain("[REDACTED]");
	});

	it("builds the headline from the redacted sample, not the raw key", () => {
		const redacted = redactErrorGroup(group());
		expect(redacted.title).toMatch(/^System\.InvalidOperationException: /);
		expect(redacted.title).not.toContain("dev@example.com");
	});

	it("caps each stored excerpt", () => {
		const redacted = redactErrorGroup(
			group({ sampleMessages: ["x".repeat(5000)] }),
		);
		expect(redacted.excerpts[0].length).toBeLessThanOrEqual(500);
	});
});

describe("renderLogEvidence", () => {
	it("states frequency, window, components, users and every timestamp", () => {
		const text = renderLogEvidence(
			redactErrorGroup(group()),
			24,
			"2026-10-22T09:30:00.000Z",
		);
		expect(text).toContain("Occurrences: 12 in the last 24 hours");
		expect(text).toContain("Components: sync-worker");
		expect(text).toContain("Affected users: 4");
		expect(text).toContain("First seen: 2026-10-21T10:00:00Z");
		expect(text).toContain("Last seen: 2026-10-22T09:00:00Z");
		expect(text).toContain("Detected: 2026-10-22T09:30:00.000Z");
		expect(text).toContain("Sample messages (redacted)");
	});

	it("indents samples instead of fencing them, since it is shown as written", () => {
		const text = renderLogEvidence(
			redactErrorGroup(group()),
			24,
			"2026-10-22T09:30:00.000Z",
		);
		expect(text).not.toContain("```");
		expect(text).toMatch(/Sample messages \(redacted\):\n\n {4}\S/);
	});

	it("indents every line of a multi-line sample", () => {
		const text = renderLogEvidence(
			redactErrorGroup(group({ sampleMessages: ["first\nsecond"] })),
			24,
			"2026-10-22T09:30:00.000Z",
		);
		expect(text).toContain("    first\n    second");
	});
});

describe("renderIncidentEvidence", () => {
	it("names every source report by identifier", () => {
		const text = renderIncidentEvidence(
			{
				fingerprint: "fp_c",
				stories: [
					{ id: "s1", identifier: "B-1", title: "Export hangs" },
					{
						id: "s2",
						identifier: "B-2",
						title: "Export never finishes",
					},
				],
			},
			"2026-10-22T09:30:00.000Z",
		);
		expect(text).toContain("- B-1: Export hangs");
		expect(text).toContain("- B-2: Export never finishes");
		expect(text).toContain("Reports: 2");
	});
});

describe("buildRecurringBugProposal", () => {
	it("is one BUG create pinned past the kind classifier", () => {
		const redacted = redactErrorGroup(group());
		const proposal = buildRecurringBugProposal({
			draft: fallbackLogDraft(redacted, "evidence"),
			reasoning: "recurred",
			sourceContext: "application_logs",
			fingerprint: "fp_1",
		});
		expect(proposal.changes).toHaveLength(1);
		const [change] = proposal.changes;
		expect(change.type).toBe("bug");
		expect(change.action).toBe("create");
		expect(change.kindOverride).toBe("BUG");
		expect(change.sourceContext).toBe("application_logs");
		expect(change.sourceChangeKey).toBe("recurring-error:fp_1");
		expect(change.description.to).toBe("evidence");
		expect(proposal.summary).toBe(change.title.to);
	});
});
