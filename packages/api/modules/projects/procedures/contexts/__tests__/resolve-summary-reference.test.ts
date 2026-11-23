/**
 * Unit tests for `resolveContextSummaryReferenceProcedure`: a summary that
 * cites a Parlume meeting transcript does not open that transcript to a reader
 * who may not read it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	hasProjectAccess: vi.fn(),
	resolveContextSummaryReference: vi.fn(),
	resolveParlumeTranscriptAccess: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => mocks.hasProjectAccess(...args),
	resolveContextSummaryReference: (...args: unknown[]) =>
		mocks.resolveContextSummaryReference(...args),
}));

vi.mock("../../../lib/context-summarization-feature", () => ({
	assertContextSummarizationEnabled: () => undefined,
}));

vi.mock("../../../lib/parlume-transcript-access", () => ({
	PARLUME_TRANSCRIPT_WITHHELD: "Only the inviter and project managers.",
	resolveParlumeTranscriptAccess: (...args: unknown[]) =>
		mocks.resolveParlumeTranscriptAccess(...args),
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
	input: {
		projectId: string;
		summaryId: string;
		sourceId: string;
		organizationId?: string;
	};
	context: { user: { id: string }; session: Record<string, unknown> };
}) => Promise<{ reference: { sourceType: string; content: string } }>;

const mod = await import("../resolve-summary-reference");
const procedure: unknown = mod.resolveContextSummaryReferenceProcedure;
const handler = (procedure as { handler: Handler }).handler;

const call = (sourceId: string) =>
	handler({
		input: {
			projectId: "project-1",
			summaryId: "summary-1",
			sourceId,
			organizationId: "org-1",
		},
		context: { user: { id: "user-1" }, session: {} },
	});

function reference(sourceType: string, sourceId: string) {
	return {
		sourceType,
		sourceId,
		sourceTimestamp: "2026-11-01T10:00:00.000Z",
		label: "Parlume meeting transcript",
		content: "Captured incoming speech:\n[chat] Dana: ship it",
		sourceUrl: null,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.resolveParlumeTranscriptAccess.mockResolvedValue(null);
});

describe("resolveContextSummaryReferenceProcedure", () => {
	it("refuses a cited Parlume transcript the caller may not read", async () => {
		mocks.resolveContextSummaryReference.mockResolvedValue(
			reference("MEETING_TRANSCRIPT", "transcript-1"),
		);
		mocks.resolveParlumeTranscriptAccess.mockResolvedValue("withheld");

		await expect(call("transcript-1")).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Only the inviter and project managers.",
		});
		expect(mocks.resolveParlumeTranscriptAccess).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
			contextId: "transcript-1",
		});
	});

	it("opens a cited Parlume transcript for a reader who may read it", async () => {
		mocks.resolveContextSummaryReference.mockResolvedValue(
			reference("MEETING_TRANSCRIPT", "transcript-1"),
		);
		mocks.resolveParlumeTranscriptAccess.mockResolvedValue("readable");

		const result = await call("transcript-1");

		expect(result.reference.content).toContain("Dana: ship it");
	});

	it("does not look up Parlume access for a source of another type", async () => {
		mocks.resolveContextSummaryReference.mockResolvedValue(
			reference("TEXT", "spec-1"),
		);

		const result = await call("spec-1");

		expect(result.reference.sourceType).toBe("TEXT");
		expect(mocks.resolveParlumeTranscriptAccess).not.toHaveBeenCalled();
	});
});
