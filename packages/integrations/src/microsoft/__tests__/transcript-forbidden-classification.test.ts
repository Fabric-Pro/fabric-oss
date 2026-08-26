/**
 * Tests for `classifyTranscriptForbidden` — the mapping from a Graph 403 on the
 * transcript endpoints to an actionable operator-facing error.
 *
 * The regression this guards (issue #2553): a tenant with "Transcript API
 * access > Microsoft Graph access" turned off gets a 403 whose top-level
 * `error.code` is `Forbidden` but whose `innerError.code` names the real cause.
 * Matching on the top-level code first reports it as a missing app permission
 * and sends operators to the wrong admin surface, so the inner-error branches
 * must win.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		workflowIntegration: {
			findFirst: (...args: unknown[]) => findFirstIntegration(...args),
			update: vi.fn(),
		},
	},
}));

vi.mock("@repo/utils", () => ({
	decryptApiKey: (v: string) => v,
	encryptApiKey: (v: string) => v,
}));

// `@repo/ai` is reached via static import in `microsoft/index.ts` for the
// excerpt extractor; stub it out to avoid loading the real LLM stack.
vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import {
	classifyTranscriptForbidden,
	executeMicrosoftTeamsTool,
} from "../index";

const UNREACHABLE_MEETING_ERROR = "Transcript access denied for this meeting";

describe("classifyTranscriptForbidden", () => {
	it("maps GraphAccessToTranscriptsDisabled to the tenant-toggle error, not the permission error", () => {
		const result = classifyTranscriptForbidden({
			error: {
				code: "Forbidden",
				message:
					"Graph API access to transcripts is disabled for this tenant.",
				innerError: { code: "GraphAccessToTranscriptsDisabled" },
			},
		});

		expect(result).not.toBeNull();
		expect(result?.error).toBe(
			"Microsoft Graph access to meeting transcripts is disabled for this tenant",
		);
		expect(result?.error).not.toBe(UNREACHABLE_MEETING_ERROR);
		expect(result?.message).toContain(
			"Set-CsTeamsMeetingConfiguration -EnableGraphTranscriptAccess $true",
		);
		expect(result?.helpUrl).toBe(
			"https://learn.microsoft.com/microsoftteams/meeting-transcript-api-access",
		);
	});

	it("maps SpeakerAttributionNotAllowed to the speaker-attribution error", () => {
		const result = classifyTranscriptForbidden({
			error: {
				code: "Forbidden",
				message: "Speaker attribution is not allowed.",
				innerError: { code: "SpeakerAttributionNotAllowed" },
			},
		});

		expect(result?.error).toBe(
			"Speaker-attributed transcript content is disabled for this tenant",
		);
		expect(result?.message).toContain(
			"Set-CsTeamsMeetingConfiguration -EnableAttributedTranscripts $true",
		);
		expect(result?.helpUrl).toBe(
			"https://learn.microsoft.com/microsoftteams/meeting-transcript-api-access",
		);
	});

	it("maps a bare Forbidden with no innerError to the unreachable-meeting error", () => {
		const result = classifyTranscriptForbidden({
			error: { code: "Forbidden", message: "Forbidden" },
		});

		expect(result?.error).toBe(UNREACHABLE_MEETING_ERROR);
		expect(result?.helpUrl).toBe(
			"https://learn.microsoft.com/graph/cloud-communication-online-meeting-application-access-policy",
		);
	});

	it("maps AccessDenied with an insufficient-privileges message to the unreachable-meeting error", () => {
		const result = classifyTranscriptForbidden({
			error: {
				code: "AccessDenied",
				message: "insufficient privileges to complete the operation",
			},
		});

		expect(result?.error).toBe(UNREACHABLE_MEETING_ERROR);
	});

	it("names the reachability limit before the permission, on the catch-all branch", () => {
		// A bare 403 is what Graph returns for a meeting the caller did not
		// organize, on a tenant where the transcript permission is already
		// granted. Leading with "missing permission" sends the user to an admin
		// who has nothing left to grant (Fizzy #2192).
		const message =
			classifyTranscriptForbidden({
				error: { code: "Forbidden", message: "Forbidden" },
			})?.message ?? "";

		expect(message).toContain("meetings you organized");
		expect(message.indexOf("meetings you organized")).toBeLessThan(
			message.indexOf("OnlineMeetingTranscript.Read.All"),
		);
	});

	it("returns null for an unrelated Graph error", () => {
		expect(
			classifyTranscriptForbidden({
				error: { code: "ActivityLimitReached" },
			}),
		).toBeNull();
	});

	it("returns null for an empty body or a body with no error field", () => {
		expect(classifyTranscriptForbidden({})).toBeNull();
		expect(classifyTranscriptForbidden({ error: {} })).toBeNull();
	});
});

describe("executeMicrosoftTeamsTool('list_meeting_transcripts') on a tenant-disabled 403", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;

		// Deliberately no refresh_token: `graphRequest` only attempts a token
		// refresh on a 403 when one is stored, so omitting it keeps this test on
		// the classification path.
		findFirstIntegration.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({
				access_token: "graph-test-token",
			}),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it("reports the tenant-admin control rather than a missing app permission", async () => {
		fetchMock.mockResolvedValue({
			ok: false,
			status: 403,
			statusText: "Forbidden",
			headers: new Headers(),
			json: async () => ({
				error: {
					code: "Forbidden",
					message:
						"Graph API access to transcripts is disabled for this tenant.",
					innerError: { code: "GraphAccessToTranscriptsDisabled" },
				},
			}),
		});

		const result = (await executeMicrosoftTeamsTool(
			"list_meeting_transcripts",
			{ meetingId: "M1" },
			"user-1",
		)) as {
			error: string;
			message: string;
			helpUrl: string;
			transcripts: unknown[];
			count: number;
		};

		expect(result.error).toBe(
			"Microsoft Graph access to meeting transcripts is disabled for this tenant",
		);
		expect(result.error).not.toContain("Missing required permission");
		expect(result.transcripts).toEqual([]);
		expect(result.count).toBe(0);
	});
});
