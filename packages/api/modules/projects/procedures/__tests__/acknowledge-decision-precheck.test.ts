/**
 * Tests for `acknowledgeDecisionPrecheckProcedure` (the document "Keep anyway"
 * action). The real override-audit helper runs; only `recordAuditFromRequest`,
 * the DB queries, and the oRPC chain are boundary-mocked.
 *
 * Cases: a doc carrying conflicts logs the override then clears the finding;
 * a no-conflicts result writes no records but still clears; tenant/membership
 * are enforced; and an audit-write failure never blocks the acknowledge.
 */

import { ORPCError } from "@orpc/client";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		hasProjectAccess: vi.fn(),
		getDocumentById: vi.fn(),
		clearProjectDocumentDecisionPrecheck: vi.fn(),
		recordAuditFromRequest: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	hasProjectAccess: mocks.hasProjectAccess,
	getDocumentById: mocks.getDocumentById,
	clearProjectDocumentDecisionPrecheck:
		mocks.clearProjectDocumentDecisionPrecheck,
}));

vi.mock("../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) =>
		mocks.recordAuditFromRequest(...args),
}));

vi.mock("../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["acknowledge"];
	let cursor = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			const key = importedHandlerKeys[cursor++] ?? `proc-${cursor}`;
			handlers[key] = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: { PROJECT_UPDATE: "project:update" },
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? undefined,
	};
});

await import("../acknowledge-decision-precheck");

const context = {
	user: { id: "user-1", email: "reviewer@example.com", name: "Reviewer" },
	session: { id: "sess-1" },
};

const baseInput = {
	projectId: "proj-1",
	documentId: "doc-1",
	organizationId: "org-1",
};

const conflictsPrecheck = {
	checkedAt: "2020-01-01T00:00:00.000Z",
	status: "conflicts",
	checkedContentHash: "hash-1",
	findings: [
		{
			decisionId: "dec-1",
			decisionIdentifier: "ADR-012",
			decisionTitle: "Use Postgres",
			natureOfConflict: "Spec proposes MongoDB",
			conflictType: "violates_accepted",
			confidence: 0.8,
		},
	],
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		m.mockReset();
	}
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.clearProjectDocumentDecisionPrecheck.mockResolvedValue(undefined);
	mocks.getDocumentById.mockResolvedValue({
		id: "doc-1",
		projectId: "proj-1",
		content: "The system will use MongoDB.",
		decisionPrecheck: conflictsPrecheck,
	});
});

describe("acknowledgeDecisionPrecheck — happy path", () => {
	it("logs the override then clears the finding", async () => {
		const result = await handlers.acknowledge({
			input: baseInput,
			context,
		});

		expect(mocks.recordAuditFromRequest).toHaveBeenCalledTimes(1);
		const auditInput = mocks.recordAuditFromRequest.mock.calls[0]?.[1] as {
			action: string;
			metadata: { surface: string; artifactId: string };
			resource: { id: string };
		};
		expect(auditInput.action).toBe("decision.override_accepted");
		expect(auditInput.metadata.surface).toBe("document");
		expect(auditInput.metadata.artifactId).toBe("doc-1");
		expect(auditInput.resource.id).toBe("dec-1");

		expect(mocks.clearProjectDocumentDecisionPrecheck).toHaveBeenCalledWith(
			"doc-1",
		);
		expect(result).toEqual({ acknowledged: true });
	});
});

describe("acknowledgeDecisionPrecheck — no override written", () => {
	it("writes no record for a status:ok document but still clears", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: "doc-1",
			projectId: "proj-1",
			content: "clean",
			decisionPrecheck: {
				checkedAt: "2020-01-01T00:00:00.000Z",
				status: "ok",
				findings: [],
			},
		});
		await handlers.acknowledge({ input: baseInput, context });
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(mocks.clearProjectDocumentDecisionPrecheck).toHaveBeenCalledWith(
			"doc-1",
		);
	});
});

describe("acknowledgeDecisionPrecheck — access + tenant isolation", () => {
	it("throws FORBIDDEN when the caller lacks project access", async () => {
		mocks.hasProjectAccess.mockResolvedValue(false);
		await expect(
			handlers.acknowledge({ input: baseInput, context }),
		).rejects.toBeInstanceOf(ORPCError);
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(
			mocks.clearProjectDocumentDecisionPrecheck,
		).not.toHaveBeenCalled();
	});

	it("throws NOT_FOUND when the document belongs to another project", async () => {
		mocks.getDocumentById.mockResolvedValue({
			id: "doc-1",
			projectId: "other-project",
			content: "x",
			decisionPrecheck: conflictsPrecheck,
		});
		await expect(
			handlers.acknowledge({ input: baseInput, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.recordAuditFromRequest).not.toHaveBeenCalled();
		expect(
			mocks.clearProjectDocumentDecisionPrecheck,
		).not.toHaveBeenCalled();
	});
});

describe("acknowledgeDecisionPrecheck — resilience", () => {
	it("does not block the acknowledge when the audit write throws", async () => {
		mocks.recordAuditFromRequest.mockImplementation(() => {
			throw new Error("audit down");
		});
		const result = await handlers.acknowledge({
			input: baseInput,
			context,
		});
		expect(result).toEqual({ acknowledged: true });
		expect(mocks.clearProjectDocumentDecisionPrecheck).toHaveBeenCalledWith(
			"doc-1",
		);
	});
});
