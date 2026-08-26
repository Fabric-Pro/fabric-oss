import { NoObjectGeneratedError } from "ai";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	isFeatureEnabled,
	hasProjectAccess,
	executeMicrosoftTeamsTool,
	generateObject,
	getAIModelWithMetadata,
	loggerWarn,
} = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	hasProjectAccess: vi.fn(),
	executeMicrosoftTeamsTool: vi.fn(),
	generateObject: vi.fn(),
	getAIModelWithMetadata: vi.fn(),
	loggerWarn: vi.fn(),
}));

// Captured, not silenced: what this procedure may and may not record about a
// failure is itself a privacy property, asserted below.
vi.mock("@repo/logs", () => ({
	logger: { warn: loggerWarn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/database")>();
	return { ...actual, isFeatureEnabled, hasProjectAccess };
});

// The barrel is mocked for `executeMicrosoftTeamsTool`, but the code under test
// also classifies errors with `isMicrosoftNotConnectedError`. Pull the real one
// in from its dependency-free module rather than stubbing it, so the mock can't
// drift from production behaviour.
vi.mock("@repo/integrations/microsoft", async () => {
	const { isMicrosoftNotConnectedError } = await vi.importActual<
		typeof import("@repo/integrations/microsoft/connection-errors")
	>("@repo/integrations/microsoft/connection-errors");

	return { executeMicrosoftTeamsTool, isMicrosoftNotConnectedError };
});

vi.mock("@repo/ai", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@repo/ai")>();
	return { ...actual, generateObject, getAIModelWithMetadata };
});

import {
	buildPersonalInsightsPrompt,
	getPersonalInsightsProcedure,
	PERSONAL_PROMPT_CHAR_CAP,
} from "@repo/api/modules/projects/procedures/meeting-digest/get-personal-insights";

const INPUT = {
	projectId: "p1",
	organizationId: null,
	joinUrl: "https://teams.microsoft.com/l/meetup-join/AAA",
	startTime: "2026-07-14T09:00:00Z",
};

const CTX = { context: { user: { id: "u1" }, session: {} }, errors: {} };

function invoke(input: Record<string, unknown> = INPUT) {
	return getPersonalInsightsProcedure["~orpc"].handler({
		input,
		...CTX,
	} as never);
}

/**
 * Long enough to clear MIN_SUMMARISABLE_CHARS, because these tests are about
 * the model plumbing rather than the floor. A one-line fixture used to stand in
 * for "a real transcript" here, which quietly stopped being true once a
 * transcript with nothing in it started answering with a reason instead.
 */
const REAL_TRANSCRIPT = [
	"Erin: the release branch is cut, and staging is on it since this morning.",
	"Bob: the migration ran clean, so we ship Friday if QA signs off tomorrow.",
	"Erin: I'll take the release notes and the changelog entry tonight.",
	"Bob: one open risk is the billing webhook — I want a rollback plan first.",
].join("\n");

/** Graph returns a usable transcript across the 3-call chain. */
function mockGraphWithTranscript(text = REAL_TRANSCRIPT) {
	executeMicrosoftTeamsTool.mockImplementation(async (method: string) => {
		if (method === "get_meeting_by_join_url") {
			return { meeting: { id: "m1" } };
		}
		if (method === "list_meeting_transcripts") {
			return {
				transcripts: [
					{ id: "t1", createdDateTime: "2026-07-14T09:05:00Z" },
				],
			};
		}
		return { content: text };
	});
}

describe("buildPersonalInsightsPrompt", () => {
	it("includes the transcript text and the meeting subject", () => {
		const prompt = buildPersonalInsightsPrompt({
			meetingSubject: "1:1 with Erin",
			transcriptText: "Bob: we agreed to ship on Friday.",
		});

		expect(prompt).toContain("1:1 with Erin");
		expect(prompt).toContain("we agreed to ship on Friday");
	});

	it("caps an oversized transcript so a long meeting cannot blow the context window", () => {
		const huge = "a".repeat(PERSONAL_PROMPT_CHAR_CAP + 5_000);

		const prompt = buildPersonalInsightsPrompt({
			meetingSubject: "Long sync",
			transcriptText: huge,
		});

		expect(prompt).toContain("[truncated at");
		expect(prompt.length).toBeLessThan(PERSONAL_PROMPT_CHAR_CAP + 2_000);
	});

	it("falls back to a placeholder when the meeting has no subject", () => {
		const prompt = buildPersonalInsightsPrompt({
			meetingSubject: null,
			transcriptText: "some talk",
		});

		expect(prompt).toContain("(no subject)");
	});
});

describe("getPersonalInsightsProcedure", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		getAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: vi.fn(),
		});
	});

	// Same privacy gate as the transcript endpoint: with the flag off this must
	// be unreachable, not merely empty.
	it("rejects with NOT_FOUND when PERSONAL_MEETINGS is off, before any Graph call", async () => {
		isFeatureEnabled.mockResolvedValue(false);

		await expect(invoke()).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(executeMicrosoftTeamsTool).not.toHaveBeenCalled();
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("rejects with FORBIDDEN when the caller has no access to the project", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(false);

		await expect(invoke()).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(generateObject).not.toHaveBeenCalled();
	});

	it("returns the summary and action items the model produced", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		mockGraphWithTranscript();
		generateObject.mockResolvedValue({
			object: {
				summary: "- Agreed to ship Friday",
				actionItems: [
					{
						text: "Cut the release branch",
						tentativeOwnerName: "Erin",
					},
				],
			},
		});

		const result = await invoke();

		expect(result.summary).toBe("- Agreed to ship Friday");
		expect(result.actionItems).toEqual([
			{ text: "Cut the release branch", tentativeOwnerName: "Erin" },
		]);
	});

	// Spending a model call on a meeting with no transcript is pure waste, and
	// the UI needs to distinguish "nothing to summarise" from "empty summary".
	it("reports no-transcript without calling the model when Graph has none", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		executeMicrosoftTeamsTool.mockResolvedValue({ meeting: null });

		const result = await invoke();

		expect(result.reason).toBe("no-transcript");
		expect(result.summary).toBeNull();
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("surfaces admin-consent-required rather than calling the model", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		executeMicrosoftTeamsTool.mockImplementation(async (method: string) => {
			if (method === "get_meeting_by_join_url") {
				return { meeting: { id: "m1" } };
			}
			return { helpUrl: "https://aka.ms/consent" };
		});

		const result = await invoke();

		expect(result.reason).toBe("admin-consent-required");
		expect(generateObject).not.toHaveBeenCalled();
	});

	// The transcript is the whole privacy risk; a model failure must not spill it
	// into an error message that the audit trail or a log could pick up.
	it("does not put transcript text in the error when the model fails", async () => {
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		mockGraphWithTranscript(
			`SECRET-TRANSCRIPT-MARKER discussed layoffs.\n${REAL_TRANSCRIPT}`,
		);
		generateObject.mockRejectedValue(new Error("model exploded"));

		await expect(invoke()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});

		const thrown = await invoke().catch((e: Error) => e);
		expect(JSON.stringify(thrown)).not.toContain(
			"SECRET-TRANSCRIPT-MARKER",
		);
	});
});

/**
 * A meeting whose transcript holds nothing worth summarising must not surface
 * as a server error.
 *
 * Found in staging QA of #2104: two real meetings whose Graph transcripts were
 * 29 and 230 characters — two lines, and nine lines totalling thirty-four words
 * of greetings — both answered HTTP 500 "Failed to summarise this meeting.",
 * while an 11 KB transcript summarised fine. The handler could not tell a model
 * that found nothing from a provider that fell over, so the user was told to
 * "Try again" on a request that could never succeed.
 */
describe("getPersonalInsightsProcedure — nothing to summarise", () => {
	/** Nine lines, thirty-four words: the shape of the staging case. */
	const GREETINGS_ONLY = Array.from(
		{ length: 9 },
		(_, i) => `Speaker ${i}: hi`,
	).join("\n");

	function noObjectGenerated(finishReason: string) {
		return new NoObjectGeneratedError({
			message: "No object generated: response did not match schema.",
			// The AI SDK attaches the offending prompt here — the one piece of
			// this error that must never reach a log line or the client.
			text: `SECRET-TRANSCRIPT-MARKER ${REAL_TRANSCRIPT}`,
			response: undefined,
			usage: undefined,
			finishReason,
		} as never);
	}

	beforeEach(() => {
		vi.clearAllMocks();
		isFeatureEnabled.mockResolvedValue(true);
		hasProjectAccess.mockResolvedValue(true);
		getAIModelWithMetadata.mockResolvedValue({
			model: "fake-model",
			trackUsage: vi.fn(),
		});
	});

	it("reports insufficient content without spending a model call when the transcript is greetings", async () => {
		mockGraphWithTranscript(GREETINGS_ONLY);

		const result = await invoke();

		expect(result).toMatchObject({
			summary: null,
			actionItems: [],
			reason: "insufficient-content",
		});
		expect(generateObject).not.toHaveBeenCalled();
	});

	it("reports insufficient content when the model returns no object at all", async () => {
		mockGraphWithTranscript();
		generateObject.mockRejectedValue(noObjectGenerated("stop"));

		const result = await invoke();

		expect(result.reason).toBe("insufficient-content");
		expect(result.summary).toBeNull();
	});

	// Truncated output is a real fault — a budget or schema problem to fix, not
	// a statement about the meeting. Answering "nothing to summarise" there
	// would hide it behind a reassuring sentence.
	it("still fails loudly when the model output was cut off mid-object", async () => {
		mockGraphWithTranscript();
		generateObject.mockRejectedValue(noObjectGenerated("length"));

		await expect(invoke()).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
		});
	});

	it("never lets transcript text or the caller's identity reach a log line", async () => {
		mockGraphWithTranscript();
		generateObject.mockRejectedValue(noObjectGenerated("stop"));

		await invoke();

		expect(loggerWarn).toHaveBeenCalled();
		const logged = JSON.stringify(loggerWarn.mock.calls);
		expect(logged).not.toContain("SECRET-TRANSCRIPT-MARKER");
		expect(logged).not.toContain("release branch");
		// Nor anything naming whose private meeting this was: these procedures
		// are kept out of the audit log for that same reason.
		expect(logged).not.toContain("u1");
		expect(logged).not.toContain(INPUT.joinUrl);
	});
});
