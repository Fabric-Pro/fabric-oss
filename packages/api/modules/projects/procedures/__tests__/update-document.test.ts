/**
 * Tests for updateDocumentProcedure mention dispatch.
 *
 * Verifies:
 * - No fan-out when there are no newly added mentions.
 * - Fan-out fires only for new mentions, dropping previously-existing ones.
 * - The fire-and-forget dispatch never fails the save when fanOut throws.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockHasProjectAccess,
	mockUpdateDocument,
	mockApplySideEffects,
	mockFanOutDocumentMention,
	mockProjectDocumentFindUnique,
	mockOrganizationFindUnique,
	mockMemberFindMany,
	mockProjectMemberFindMany,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockHasProjectAccess: vi.fn(),
	mockUpdateDocument: vi.fn(),
	mockApplySideEffects: vi.fn(),
	mockFanOutDocumentMention: vi.fn(),
	mockProjectDocumentFindUnique: vi.fn(),
	mockOrganizationFindUnique: vi.fn(),
	mockMemberFindMany: vi.fn(),
	mockProjectMemberFindMany: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: (...args: unknown[]) => mockHasProjectAccess(...args),
	updateDocument: (...args: unknown[]) => mockUpdateDocument(...args),
	// Real implementation, not a stub: it is a pure string builder, and this
	// suite asserts the context-relative link it produces.
	buildDocumentLink: (args: { projectId: string; documentId: string }) =>
		`projects/${args.projectId}/documents/${args.documentId}`,
	db: {
		projectDocument: {
			findUnique: (...args: unknown[]) =>
				mockProjectDocumentFindUnique(...args),
		},
		organization: {
			findUnique: (...args: unknown[]) =>
				mockOrganizationFindUnique(...args),
		},
		member: {
			findMany: (...args: unknown[]) => mockMemberFindMany(...args),
		},
		projectMember: {
			findMany: (...args: unknown[]) =>
				mockProjectMemberFindMany(...args),
		},
	},
}));

vi.mock("@repo/database/prisma/zod", () => ({
	ProjectDocumentStatusSchema: {
		optional: () => ({}),
	},
}));

vi.mock("../../../../lib/document-side-effects", () => ({
	applyDocumentUpdateSideEffects: (...args: unknown[]) =>
		mockApplySideEffects(...args),
}));

vi.mock("../../../../lib/notification-service", () => ({
	fanOut: {
		documentMention: (...args: unknown[]) =>
			mockFanOutDocumentMention(...args),
	},
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: unknown) => {
			(chainable as { _input?: unknown })._input = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.updateDocument = fn;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? null,
		),
		requirePermission: vi.fn(() => ({})),
		requireProjectPermission: vi.fn(() => ({})),
		Permissions: new Proxy(
			{},
			{ get: (_, prop: string) => prop.toLowerCase() },
		),
	};
});

// Side-effect: register the handler.
import "../update-document";

const ctx = {
	user: { id: "actor_1", name: "Alice" },
	session: { id: "session-1", activeOrganizationId: "org_1" },
} as any;

const baseInput = {
	projectId: "proj_1",
	id: "doc_1",
	organizationId: "org_1",
	content: "",
	title: "PRD",
};

async function flushPromises() {
	// Allow the fire-and-forget `void dispatchDocumentMentions(...)` to settle.
	await new Promise((resolve) => setImmediate(resolve));
	await new Promise((resolve) => setImmediate(resolve));
}

describe("updateDocumentProcedure mention dispatch", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mockHasProjectAccess.mockResolvedValue(true);
		mockUpdateDocument.mockResolvedValue({
			id: "doc_1",
			title: "PRD",
			content: "",
		});
		mockApplySideEffects.mockResolvedValue(undefined);
		mockOrganizationFindUnique.mockResolvedValue({ slug: "acme" });
		mockMemberFindMany.mockResolvedValue([
			{ userId: "u_2" },
			{ userId: "u_3" },
		]);
		mockProjectMemberFindMany.mockResolvedValue([]);
		mockFanOutDocumentMention.mockResolvedValue(undefined);
	});

	it("does not fan out when content is unchanged (no new mentions)", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content:
				'<p><span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span></p>',
			title: "PRD",
		});

		await handlers.updateDocument({
			input: {
				...baseInput,
				content:
					'<p><span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span></p>',
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockFanOutDocumentMention).not.toHaveBeenCalled();
	});

	it("fans out only for newly added mentions", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content:
				'<p><span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span></p>',
			title: "PRD",
		});

		await handlers.updateDocument({
			input: {
				...baseInput,
				content:
					'<p><span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span> <span data-type="mention" data-id="u_3" data-mention-id="m_b">@Carol</span></p>',
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockFanOutDocumentMention).toHaveBeenCalledTimes(1);
		const args = mockFanOutDocumentMention.mock.calls[0][0];
		expect(args.recipients).toEqual([{ userId: "u_3", anchorId: "m_b" }]);
		expect(args.link).toBe("projects/proj_1/documents/doc_1");
	});

	it("does not fail the save when fanOut throws", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content: "",
			title: "PRD",
		});
		mockFanOutDocumentMention.mockRejectedValueOnce(new Error("boom"));

		const result = (await handlers.updateDocument({
			input: {
				...baseInput,
				content:
					'<span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span>',
			},
			context: ctx,
		})) as { document: unknown };
		await flushPromises();

		expect(result.document).toEqual({
			id: "doc_1",
			title: "PRD",
			content: "",
		});
	});

	it("builds a context-relative link when organizationId is null", async () => {
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content: "",
			title: "PRD",
		});
		mockProjectMemberFindMany.mockResolvedValue([{ userId: "u_2" }]);

		await handlers.updateDocument({
			input: {
				...baseInput,
				organizationId: null,
				content:
					'<span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span>',
			},
			context: {
				...ctx,
				session: { ...ctx.session, activeOrganizationId: null },
			},
		});
		await flushPromises();

		expect(mockFanOutDocumentMention).toHaveBeenCalledTimes(1);
		const args = mockFanOutDocumentMention.mock.calls[0][0];
		expect(args.link).toBe("projects/proj_1/documents/doc_1");
	});

	it("dispatches fanOut.documentMention with actorUserId equal to ctx.user.id (AI-actor policy)", async () => {
		// Test B: the authoritative actor for document mentions is always the
		// session caller (ctx.user.id). This test locks that invariant so any
		// future change that passes a different actor ID will be caught.
		mockProjectDocumentFindUnique.mockResolvedValue({
			projectId: "proj_1",
			content: "",
			title: "PRD",
		});

		await handlers.updateDocument({
			input: {
				...baseInput,
				content:
					'<span data-type="mention" data-id="u_2" data-mention-id="m_a">@Bob</span>',
			},
			context: ctx,
		});
		await flushPromises();

		expect(mockFanOutDocumentMention).toHaveBeenCalledTimes(1);
		const args = mockFanOutDocumentMention.mock.calls[0][0];
		// The actor must be the session user — never a synthetic/AI actor id.
		expect(args.actorUserId).toBe(ctx.user.id);
	});
});
