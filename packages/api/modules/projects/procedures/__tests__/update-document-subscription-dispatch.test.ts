/**
 * Dispatch-gating for subscriber notifications on document update — the
 * feature's headline guarantee.
 *
 *  - title-only save (version unchanged, status unchanged) → NO notify
 *  - content change (version bumped) → notify with changeKind "content"
 *  - status-only change → notify with changeKind "status"
 *
 * Mocks the db + side-effects + mentions + oRPC chain so the handler is a
 * plain function; asserts on the fanOut.subscriptionUpdate spy.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { hasAccess, updateDoc, priorFindUnique, subUpdate, docMention } =
	vi.hoisted(() => ({
		hasAccess: vi.fn(),
		updateDoc: vi.fn(),
		priorFindUnique: vi.fn(),
		subUpdate: vi.fn(),
		docMention: vi.fn(),
	}));

vi.mock("@repo/database", () => ({
	db: { projectDocument: { findUnique: priorFindUnique } },
	hasProjectAccess: hasAccess,
	updateDocument: updateDoc,
	// Real implementation, not a stub: it is a pure string builder, and this
	// suite asserts the notification's link.
	buildDocumentLink: (args: { projectId: string; documentId: string }) =>
		`projects/${args.projectId}/documents/${args.documentId}`,
}));

vi.mock("@repo/database/prisma/zod", async () => {
	const { z } = await import("zod");
	// Real schema so `.optional()` in the procedure's input builder works;
	// the input schema itself is passed to the no-op `.input()` chain.
	return { ProjectDocumentStatusSchema: z.string() };
});

vi.mock("@repo/logs", () => ({
	logger: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		subscriptionUpdate: subUpdate.mockResolvedValue(undefined),
		documentMention: docMention.mockResolvedValue(undefined),
	},
}));

vi.mock("../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: vi.fn().mockResolvedValue(undefined),
}));

// No mentions in play → the mention dispatch short-circuits before fanOut.
vi.mock("../../lib/document-mentions", () => ({
	extractDocumentMentionIds: () => [],
	diffMentionIds: () => [],
	extractMentionContextSnippet: () => "",
}));

vi.mock("../../lib/user-mention", () => ({
	filterAuthorizedMentionRecipients: vi.fn().mockResolvedValue([]),
}));

vi.mock("../../../../orpc/procedures", () => {
	const makeChain = () => {
		const chain: any = {
			use: () => chain,
			route: () => chain,
			input: () => chain,
			output: () => chain,
			handler: (h: any) => h,
		};
		return chain;
	};
	return {
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => () => undefined,
		resolveOrganizationId: (orgId: string | null | undefined) =>
			orgId ?? null,
		get tenantProtectedProcedure() {
			return makeChain();
		},
	};
});

import { updateDocumentProcedure } from "../update-document";

const ctx = {
	context: { user: { id: "u1", name: "Alice" }, session: {} },
} as const;

beforeEach(() => {
	vi.clearAllMocks();
	hasAccess.mockResolvedValue(true);
});

async function run(input: Record<string, unknown>) {
	return (updateDocumentProcedure as any)({
		...ctx,
		input: { projectId: "p1", id: "doc-1", ...input },
	});
}

describe("update-document subscriber dispatch gating", () => {
	it("does NOT notify on a title-only save (version + status unchanged)", async () => {
		priorFindUnique.mockResolvedValue({
			projectId: "p1",
			content: "body",
			title: "Old",
			status: "DRAFT",
			version: 3,
		});
		updateDoc.mockResolvedValue({
			id: "doc-1",
			title: "New title",
			status: "DRAFT",
			version: 3, // unchanged — updateDocument only bumps on content change
		});

		await run({ title: "New title" });

		expect(subUpdate).not.toHaveBeenCalled();
	});

	it("notifies with changeKind 'content' when the version bumps", async () => {
		priorFindUnique.mockResolvedValue({
			projectId: "p1",
			content: "body",
			title: "Doc",
			status: "DRAFT",
			version: 3,
		});
		updateDoc.mockResolvedValue({
			id: "doc-1",
			title: "Doc",
			status: "DRAFT",
			version: 4, // bumped → real content change
		});

		await run({ content: "new body" });

		expect(subUpdate).toHaveBeenCalledTimes(1);
		expect(subUpdate.mock.calls[0][0]).toMatchObject({
			subjectType: "DOCUMENT",
			subjectId: "doc-1",
			changeKind: "content",
			title: "Doc",
		});
	});

	it("notifies with changeKind 'status' on a status-only change", async () => {
		priorFindUnique.mockResolvedValue({
			projectId: "p1",
			content: "body",
			title: "Doc",
			status: "DRAFT",
			version: 3,
		});
		updateDoc.mockResolvedValue({
			id: "doc-1",
			title: "Doc",
			status: "IN_REVIEW",
			version: 3, // no content change
		});

		await run({ status: "IN_REVIEW" });

		expect(subUpdate).toHaveBeenCalledTimes(1);
		expect(subUpdate.mock.calls[0][0].changeKind).toBe("status");
	});
});
