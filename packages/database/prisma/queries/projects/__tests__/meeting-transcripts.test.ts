/**
 * Unit tests for the auto-analysis scan-status lifecycle query helpers on
 * `ProjectMeetingTranscript`:
 *   - claimMeetingTranscriptForAnalysis  (NOT_SCANNED → IN_PROGRESS CAS + read-back)
 *   - markMeetingTranscriptScanned       (→ SCANNED + analyzedAt [+ proposalId])
 *   - attachProposalToMeetingTranscript  (back-compat alias of markScanned)
 *   - releaseMeetingTranscriptAnalysisClaim (→ NOT_SCANNED, clears markers)
 *   - markMeetingTranscriptAnalysisFailed (→ FAILED + truncated error)
 *
 * Mocks the Prisma client (Postgres is not required). Mirrors the mock shape of
 * `slack-huddle-notes.test.ts`.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockUpdateMany, mockFindUnique } = vi.hoisted(() => ({
	mockUpdateMany: vi.fn(),
	mockFindUnique: vi.fn(),
}));

vi.mock("../../../client", () => ({
	db: {
		projectMeetingTranscript: {
			updateMany: mockUpdateMany,
			findUnique: mockFindUnique,
		},
	},
}));

import {
	attachProposalToMeetingTranscript,
	claimMeetingTranscriptForAnalysis,
	markMeetingTranscriptAnalysisFailed,
	markMeetingTranscriptScanned,
	releaseMeetingTranscriptAnalysisClaim,
} from "../meeting-transcripts";

beforeEach(() => {
	vi.clearAllMocks();
	mockUpdateMany.mockResolvedValue({ count: 1 });
});

describe("claimMeetingTranscriptForAnalysis", () => {
	it("compare-and-sets NOT_SCANNED → IN_PROGRESS and returns claimed:true on count 1", async () => {
		const result = await claimMeetingTranscriptForAnalysis("tr-1");

		expect(result).toEqual({ claimed: true });
		expect(mockUpdateMany).toHaveBeenCalledTimes(1);
		const arg = mockUpdateMany.mock.calls[0][0] as {
			where: { id: string; analysisStatus: string };
			data: { analysisStatus: string; analysisStartedAt: Date };
		};
		expect(arg.where).toEqual({
			id: "tr-1",
			analysisStatus: "NOT_SCANNED",
		});
		expect(arg.data.analysisStatus).toBe("IN_PROGRESS");
		expect(arg.data.analysisStartedAt).toBeInstanceOf(Date);
		// No read-back needed when the claim is won.
		expect(mockFindUnique).not.toHaveBeenCalled();
	});

	it("reads the row back on a lost claim (count 0) and returns its status + analyzedAt", async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });
		const analyzedAt = new Date("2026-06-20T00:00:00.000Z");
		mockFindUnique.mockResolvedValue({
			analysisStatus: "SCANNED",
			analyzedAt,
		});

		const result = await claimMeetingTranscriptForAnalysis("tr-2");

		expect(result).toEqual({
			claimed: false,
			status: "SCANNED",
			analyzedAt,
		});
		expect(mockFindUnique).toHaveBeenCalledTimes(1);
	});

	it("returns null status/analyzedAt when the row is gone on a lost claim", async () => {
		mockUpdateMany.mockResolvedValue({ count: 0 });
		mockFindUnique.mockResolvedValue(null);

		const result = await claimMeetingTranscriptForAnalysis("tr-gone");

		expect(result).toEqual({
			claimed: false,
			status: null,
			analyzedAt: null,
		});
	});
});

describe("markMeetingTranscriptScanned", () => {
	it("sets SCANNED + analyzedAt + analyzedProposalId when a proposalId is passed", async () => {
		await markMeetingTranscriptScanned("tr-1", "pbp-1");

		const arg = mockUpdateMany.mock.calls[0][0] as {
			where: { id: string };
			data: {
				analysisStatus: string;
				analyzedAt: Date;
				analyzedProposalId?: string;
			};
		};
		expect(arg.where).toEqual({ id: "tr-1" });
		expect(arg.data.analysisStatus).toBe("SCANNED");
		expect(arg.data.analyzedAt).toBeInstanceOf(Date);
		expect(arg.data.analyzedProposalId).toBe("pbp-1");
	});

	it("sets SCANNED + analyzedAt ONLY (analyzedProposalId absent) on a zero-change run", async () => {
		await markMeetingTranscriptScanned("tr-2");

		const arg = mockUpdateMany.mock.calls[0][0] as {
			where: { id: string };
			data: { analysisStatus: string; analyzedProposalId?: string };
		};
		expect(arg.data.analysisStatus).toBe("SCANNED");
		// The key must be ABSENT so Prisma leaves the column NULL.
		expect("analyzedProposalId" in arg.data).toBe(false);
	});
});

describe("attachProposalToMeetingTranscript (back-compat alias)", () => {
	it("delegates to markMeetingTranscriptScanned with the proposal id", async () => {
		await attachProposalToMeetingTranscript("tr-1", "pbp-9");

		const arg = mockUpdateMany.mock.calls[0][0] as {
			where: { id: string };
			data: { analysisStatus: string; analyzedProposalId?: string };
		};
		expect(arg.where).toEqual({ id: "tr-1" });
		expect(arg.data.analysisStatus).toBe("SCANNED");
		expect(arg.data.analyzedProposalId).toBe("pbp-9");
	});
});

describe("releaseMeetingTranscriptAnalysisClaim", () => {
	it("resets the row to NOT_SCANNED and clears the markers so a retry can re-claim", async () => {
		await releaseMeetingTranscriptAnalysisClaim("tr-1");

		const arg = mockUpdateMany.mock.calls[0][0] as {
			where: { id: string };
			data: {
				analysisStatus: string;
				analysisStartedAt: null;
				analyzedAt: null;
			};
		};
		expect(arg.where).toEqual({ id: "tr-1" });
		expect(arg.data).toEqual({
			analysisStatus: "NOT_SCANNED",
			analysisStartedAt: null,
			analyzedAt: null,
		});
	});
});

describe("markMeetingTranscriptAnalysisFailed", () => {
	it("sets FAILED + failedAt and stores the error message", async () => {
		await markMeetingTranscriptAnalysisFailed("tr-1", "LLM 503");

		const arg = mockUpdateMany.mock.calls[0][0] as {
			where: { id: string };
			data: {
				analysisStatus: string;
				analysisError: string;
				analysisFailedAt: Date;
			};
		};
		expect(arg.where).toEqual({ id: "tr-1" });
		expect(arg.data.analysisStatus).toBe("FAILED");
		expect(arg.data.analysisError).toBe("LLM 503");
		expect(arg.data.analysisFailedAt).toBeInstanceOf(Date);
	});

	it("truncates an overly long error message to 2000 chars", async () => {
		await markMeetingTranscriptAnalysisFailed("tr-1", "x".repeat(5000));

		const arg = mockUpdateMany.mock.calls[0][0] as {
			data: { analysisError: string };
		};
		expect(arg.data.analysisError).toHaveLength(2000);
	});
});
