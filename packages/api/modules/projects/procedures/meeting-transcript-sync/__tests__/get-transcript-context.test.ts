/**
 * Unit tests for `getTranscriptContextProcedure`, the recent-transcripts
 * context the document and feature assistants add to a prompt. A confidential
 * series' transcripts and every Parlume transcript stay out of it, as they do
 * from search and summaries.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	contextFindMany: vi.fn(),
	hasProjectAccess: vi.fn(),
	findConfidentialTranscriptContextIds: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		projectContext: {
			findMany: (...args: unknown[]) => mocks.contextFindMany(...args),
		},
	},
	findConfidentialTranscriptContextIds: (...args: unknown[]) =>
		mocks.findConfidentialTranscriptContextIds(...args),
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: { projectId: string; organizationId?: string; limit: number };
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<{
	transcripts: Array<{ meetingSubject: string; content: string }>;
	transcriptCount: number;
}>;

const mod = await import("../get-transcript-context");
const procedure: unknown = mod.getTranscriptContextProcedure;
const handler = (procedure as { handler: Handler }).handler;

const call = () =>
	handler({
		input: { projectId: "project-1", organizationId: "org-1", limit: 10 },
		context: { user: { id: "user-1" }, session: {} },
	});

beforeEach(() => {
	vi.resetAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findConfidentialTranscriptContextIds.mockResolvedValue(new Set());
	mocks.contextFindMany.mockResolvedValue([
		{
			content: "Sprint planning notes",
			metadata: { meetingSubject: "Sprint planning" },
		},
	]);
});

describe("getTranscriptContextProcedure", () => {
	it("leaves Parlume and confidential-series transcripts out of the query", async () => {
		mocks.findConfidentialTranscriptContextIds.mockResolvedValue(
			new Set(["parlume", "confidential"]),
		);

		const result = await call();

		expect(mocks.findConfidentialTranscriptContextIds).toHaveBeenCalledWith(
			{
				projectId: "project-1",
			},
		);
		expect(mocks.contextFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project-1",
					type: "MEETING_TRANSCRIPT",
					id: { notIn: ["parlume", "confidential"] },
				},
			}),
		);
		expect(result.transcripts).toEqual([
			expect.objectContaining({
				meetingSubject: "Sprint planning",
				content: "Sprint planning notes",
			}),
		]);
	});

	it("adds no id filter when the project has no such transcript", async () => {
		await call();

		expect(mocks.contextFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { projectId: "project-1", type: "MEETING_TRANSCRIPT" },
			}),
		);
	});

	it("refuses a caller without project access before reading anything", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);

		await expect(call()).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.contextFindMany).not.toHaveBeenCalled();
		expect(
			mocks.findConfidentialTranscriptContextIds,
		).not.toHaveBeenCalled();
	});
});
