import { describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
	db: {},
	tenantWhere: vi.fn(() => ({})),
	createStory: vi.fn(),
	updateStory: vi.fn(),
	recordAudit: vi.fn(),
	recordProposalDuplicateResolution: vi.fn(),
	recordProposalApplication: vi.fn(),
	getBoundPromptForAgent: vi.fn(),
	normalizeBacklogTitle: (t: string) => t.toLowerCase().trim(),
	isTerminalWorkItemState: () => false,
	TERMINAL_DRAFTING_STAGES: ["DECLINED", "CLOSED"],
}));
vi.mock("../src/lib/create-story-from-proposal", () => ({
	createStoryFromProposal: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	logModelUsageAsync: vi.fn(),
}));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("@temporalio/activity", () => ({
	heartbeat: vi.fn(),
	ApplicationFailure: { nonRetryable: (m: string) => new Error(m) },
}));

import { buildAnalysisPrompt } from "../src/activities/backlog-context/analyze-context";

const legacySecurityRule = `13. **Security Findings (CRITICAL)**: When "### Security Findings" is present in the context, you MUST propose \`type: "bug"\` items for any CRITICAL or HIGH severity finding that does not already have a matching backlog item (check [linked: ...] brackets — a linked identifier means a ticket already exists).
    - For MEDIUM/LOW findings, use judgment based on the user instructions. Set \`sourceContext: "security_findings"\` on every proposal derived from a finding. Do NOT reproduce the full finding text in the description — write a concise, actionable bug report using the finding's title, category, and remediation guidance.`;

function prompt(
	extra: Partial<Parameters<typeof buildAnalysisPrompt>[0]> = {},
) {
	return buildAnalysisPrompt({
		fetchedContext: {
			meetingTranscripts: "Meeting: fix the export timeout.",
			securityFindings: "HIGH: unlinked example finding",
			architectureDecisions: "ACCEPTED: use the existing queue.",
			applicationLogs: "Example background error",
			ragContext: "Another meeting: improve search.",
		},
		existingBacklog: { stories: [] },
		userPrompt: "Suggest changes from the selected meeting.",
		...extra,
	});
}

describe("meeting grounding in analysis prompts", () => {
	it.each([undefined, ""])(
		"preserves rule 13 byte-for-byte without transcripts (%s)",
		(meetingTranscripts) => {
			const result = prompt({
				fetchedContext: {
					securityFindings: "HIGH: example finding",
					meetingTranscripts,
				},
			});
			expect(result).toContain(legacySecurityRule);
			expect(result).not.toContain("15. **Meeting grounding");
		},
	);

	it("makes security findings conditional background for meeting runs", () => {
		const result = prompt();
		expect(result).not.toContain(legacySecurityRule);
		expect(result).toContain("Security findings are background");
		expect(result).toContain(
			"only when the meeting discussed it or the user's instructions explicitly ask for security work",
		);
		expect(result).toContain(
			"otherwise a finding may only add detail to a meeting-derived change",
		);
		expect(result).toContain('sourceContext: "security_findings"');
		expect(result).toContain("write a concise, actionable bug report");
	});

	it.each([undefined, "standard"] as const)(
		"grounds creates and updates in selected sources in %s intake",
		(intakeMode) => {
			const result = prompt({ intakeMode });
			expect(result).toContain("15. **Meeting grounding");
			expect(result).toContain(
				"Every proposed change (create or update) must originate",
			);
			expect(result).toContain('"### Meeting Transcripts"');
			expect(result).toContain("Teams messages, Notion pages");
			expect(result).toContain(
				"Slack Messages, Security Findings, Architecture Decisions, Application Logs and Additional Context (RAG)",
			);
			expect(result).toContain("must never be the sole origin");
			expect(result).toContain(
				"return no changes rather than filling from background context",
			);
			expect(result).toContain(
				"reasoning should cite what was said in the meeting",
			);
		},
	);

	it("allows explicit user instructions as an origin and treats Slack as background", () => {
		const result = prompt({
			userPrompt: "Also add a ticket for CSV export.",
			fetchedContext: {
				meetingTranscripts: "Meeting: nothing actionable today.",
				slackMessages: "Slack: improve search.",
			},
		});
		const grounding = result.slice(
			result.indexOf("15. **Meeting grounding"),
			result.indexOf("\n---"),
		);
		const originRule = grounding.split("\n")[0];
		expect(originRule).toContain(
			"a specific change the user's instructions explicitly request",
		);
		expect(originRule).toContain(
			"a general request to analyze context or suggest updates is not one",
		);
		expect(originRule).toContain("Teams messages, Notion pages");
		expect(originRule).not.toContain("Slack");
		expect(grounding).toContain(
			"The background sections — Slack Messages,",
		);
		expect(grounding).toContain("must never be the sole origin");
		expect(grounding).toContain(
			"If none of these allowed origins raised anything actionable",
		);
	});

	it("references the Security Findings rule by name despite duplicate rule numbers", () => {
		const result = prompt({ allowUpdates: false });
		const grounding = result.slice(
			result.indexOf("15. **Meeting grounding"),
		);
		expect(result).toContain("13. **Security Findings");
		expect(result).toContain("13. **CREATE-ONLY");
		expect(grounding).toContain("the Security Findings rule");
		expect(grounding).not.toContain("rule 13");
	});

	it("tags finding-originated proposals without retagging meeting-derived changes", () => {
		const result = prompt();
		expect(result).toContain(
			'Set `sourceContext: "security_findings"` on proposals a finding originated',
		);
		expect(result).toContain(
			"not on meeting-derived changes a finding merely informed",
		);
	});

	it("keeps grounding without security findings and respects create-only capture", () => {
		const result = prompt({
			fetchedContext: { meetingTranscripts: "Meeting: fix export." },
			allowUpdates: false,
		});
		expect(result).toContain("15. **Meeting grounding");
		expect(result).toContain('Every change MUST use `action: "create"`');
		expect(result).toContain(
			"This rule does not require updates or deduplication",
		);
		expect(result).not.toContain("13. **Security Findings");
	});

	it.each(["explore", "recommend"] as const)(
		"omits standard meeting constraints in %s intake",
		(intakeMode) => {
			const result = prompt({ intakeMode });
			expect(result).not.toContain("15. **Meeting grounding");
			expect(result).not.toContain("13. **Security Findings");
			expect(result).not.toContain("Security findings are background");
		},
	);
});
