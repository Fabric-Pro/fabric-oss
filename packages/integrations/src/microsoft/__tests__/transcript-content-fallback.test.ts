/**
 * `get_meeting_transcript_content` reads the WebVTT content when Graph will not
 * serve a transcript's structured metadata. Graph has refused it with a 404 and,
 * for some transcripts, with `400 Invalid transcript id`; a meeting sync that
 * treated the 400 as final stopped storing new occurrences of the series.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const findFirstIntegration = vi.fn();

vi.mock("@repo/database", async () => ({
	canUseWorkflowIntegrations: vi.fn().mockResolvedValue(true),
	workflowIntegrationAccessWhere: (
		await import(
			"@repo/database/prisma/queries/workflows/integration-access"
		)
	).workflowIntegrationAccessWhere,
	resolveWorkflowIntegrationForProvider: async (
		...args: Parameters<
			typeof import("@repo/database/prisma/queries/workflows/integration-access").resolveWorkflowIntegrationForProvider
		>
	) => {
		const mocked = await import("@repo/database");
		return mocked.db.workflowIntegration.findFirst({
			where: {
				...mocked.workflowIntegrationAccessWhere(args[1], args[2]),
				provider: args[0],
				isActive: true,
			},
		});
	},
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

vi.mock("@repo/ai", () => ({
	extractRelevantExcerpts: vi.fn(),
}));

import { executeMicrosoftTeamsTool } from "../index";

const VTT = `WEBVTT

00:00:00.000 --> 00:00:04.000
<v Alice>We should ship the export.</v>
`;

function graphError(status: number, statusText: string, message: string) {
	return {
		ok: false,
		status,
		statusText,
		headers: new Headers(),
		json: async () => ({ error: { code: statusText, message } }),
		text: async () => "",
	};
}

const vttResponse = {
	ok: true,
	status: 200,
	statusText: "OK",
	headers: new Headers({ "content-type": "text/vtt" }),
	text: async () => VTT,
};

describe("executeMicrosoftTeamsTool('get_meeting_transcript_content') when structured metadata is refused", () => {
	const fetchMock = vi.fn();
	const originalFetch = globalThis.fetch;

	beforeEach(() => {
		findFirstIntegration.mockReset();
		fetchMock.mockReset();
		globalThis.fetch = fetchMock as unknown as typeof globalThis.fetch;
		findFirstIntegration.mockResolvedValue({
			id: "integration-1",
			credentials: JSON.stringify({ access_token: "graph-test-token" }),
		});
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
	});

	it.each([
		[400, "Bad Request", "Invalid transcript id 'T1'."],
		[404, "Not Found", "Not found"],
	])(
		"reads the WebVTT content after a %i",
		async (status, statusText, message) => {
			fetchMock.mockImplementation(async (url: string) =>
				url.endsWith("/metadataContent")
					? graphError(status, statusText, message)
					: vttResponse,
			);

			const result = (await executeMicrosoftTeamsTool(
				"get_meeting_transcript_content",
				{ meetingId: "M1", transcriptId: "T1" },
				"user-1",
			)) as { format: string; entries: Array<{ speaker: string }> };

			expect(result.format).toBe("vtt_parsed");
			expect(result.entries.length).toBeGreaterThan(0);
			expect(result.entries[0]?.speaker).toBe("Alice");
			const urls = fetchMock.mock.calls.map((call) => String(call[0]));
			const readVtt = urls.some((u) => u.endsWith("/T1/content"));
			expect(readVtt).toBe(true);
		},
	);

	it("still fails when the WebVTT content is refused too", async () => {
		fetchMock.mockResolvedValue(
			graphError(400, "Bad Request", "Invalid transcript id 'T1'."),
		);

		await expect(
			executeMicrosoftTeamsTool(
				"get_meeting_transcript_content",
				{ meetingId: "M1", transcriptId: "T1" },
				"user-1",
			),
		).rejects.toThrow("400 Bad Request");
	});
});
