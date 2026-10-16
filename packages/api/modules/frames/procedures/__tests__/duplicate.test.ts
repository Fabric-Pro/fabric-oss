/**
 * Duplicating a frame copies the page and where it lives, not what it may do.
 *
 * The copy itself (the surface and project of the original, fresh block ids,
 * private, and only the tools its caller names) is `duplicateFrame` in
 * `@repo/database`, the command the Fabric Agent's fork uses too; its own test
 * pins that. What this procedure adds, and what is pinned here: it copies only
 * the caller's own page, a project that does not take the copy (the placement
 * rule is `duplicateFrame`'s, so the app and the agent's fork share it) is
 * answered as "not found", and the caller's copy says it came from the run the
 * original did.
 *
 * Run with: pnpm --filter @repo/api test modules/frames/procedures/__tests__/duplicate.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

type InputSchema = {
	safeParse: (input: unknown) => {
		success: boolean;
		data?: Record<string, unknown>;
	};
};

const {
	handlers,
	schemas,
	mockGetFrameById,
	mockDuplicateFrame,
	MockFramePlacementRefusedError,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	schemas: {} as Record<string, InputSchema>,
	mockGetFrameById: vi.fn(),
	mockDuplicateFrame: vi.fn(),
	MockFramePlacementRefusedError: class extends Error {
		constructor(readonly refusal: string) {
			super(refusal);
		}
	},
}));

vi.mock("@repo/database", () => ({
	duplicateFrame: mockDuplicateFrame,
	FramePlacementRefusedError: MockFramePlacementRefusedError,
	getFrameById: mockGetFrameById,
}));

vi.mock("../../../../orpc/procedures", () => {
	let current = "";
	const chainable: any = {
		use: () => chainable,
		route: (route: { path: string }) => {
			current = route.path;
			return chainable;
		},
		input: (schema: InputSchema) => {
			schemas[current] = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers[current] = fn;
			return { _handler: fn };
		},
	};
	return {
		tenantProtectedProcedure: chainable,
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		resolveOrganizationId: vi.fn(
			(organizationId: string | null | undefined) =>
				organizationId ?? undefined,
		),
	};
});

import "../duplicate";

const now = new Date("2026-10-15T00:00:00Z");

function original(overrides: Record<string, unknown> = {}) {
	return {
		id: "frame-1",
		userId: "owner-1",
		organizationId: "org-1",
		projectId: undefined,
		surface: "workspace",
		runtimeTools: ["fabric_page_data_get", "fabric_share_frame"],
		conversationId: null,
		title: "Sign-ups",
		description: "A sheet",
		kind: "frame",
		sourceRunType: null,
		sourceRunId: null,
		authoritySessionId: null,
		providerKeys: [],
		document: {
			theme: { mode: "light" },
			blocks: [{ id: "page", type: "html", content: "<p>hi</p>" }],
		},
		...overrides,
	};
}

const duplicate = (input: Record<string, unknown> = {}, userId = "owner-1") =>
	handlers["/frames/{id}/duplicate"]({
		input: { id: "frame-1", organizationId: "org-1", ...input },
		context: { user: { id: userId }, session: {} },
	});

beforeEach(() => {
	vi.clearAllMocks();
	mockGetFrameById.mockResolvedValue(original());
	mockDuplicateFrame.mockResolvedValue({
		id: "frame-2",
		title: "Sign-ups (Copy)",
		description: "A sheet",
		kind: "frame",
		contentType: "application/vnd.fabric.frame",
		isPublic: false,
		shareToken: null,
		createdAt: now,
		updatedAt: now,
	});
});

const copied = () => mockDuplicateFrame.mock.calls[0]?.[0];

describe("frames.duplicate", () => {
	it("copies the caller's own page, for the caller, in their organization", async () => {
		const result = await duplicate();

		expect(mockGetFrameById).toHaveBeenCalledWith({
			id: "frame-1",
			userId: "owner-1",
			organizationId: "org-1",
		});
		expect(copied()).toMatchObject({
			original: original(),
			userId: "owner-1",
			organizationId: "org-1",
		});
		expect(result).toMatchObject({ id: "frame-2", isPublic: false });
	});

	it.each(["not_found", "not_editable"])(
		"answers a project that refuses the copy (%s) as not found, saying nothing of the project",
		async (refusal) => {
			mockGetFrameById.mockResolvedValue(
				original({ projectId: "project-1", surface: "artifact" }),
			);
			mockDuplicateFrame.mockRejectedValue(
				new MockFramePlacementRefusedError(refusal),
			);

			await expect(duplicate()).rejects.toThrow(/^Frame not found$/);
		},
	);

	it("lets any other failure of the copy through", async () => {
		mockDuplicateFrame.mockRejectedValue(new Error("database unavailable"));

		await expect(duplicate()).rejects.toThrow("database unavailable");
	});

	it("takes no tools for the copy: the input has no runtimeTools, so any a caller sends are dropped", () => {
		const parsed = schemas["/frames/{id}/duplicate"].safeParse({
			id: "frame-1",
			organizationId: "org-1",
			runtimeTools: ["not_a_tool", "call_tool"],
		});

		expect(parsed.success).toBe(true);
		expect(parsed.data).toEqual({ id: "frame-1", organizationId: "org-1" });
	});

	it("gives the copy no tools, whatever reaches the handler", async () => {
		await duplicate({ runtimeTools: ["not_a_tool", "call_tool"] });

		expect(copied().runtimeTools).toBeUndefined();
	});

	it("says the copy came from the run the original did", async () => {
		mockGetFrameById.mockResolvedValue(
			original({
				conversationId: "conv-1",
				sourceRunType: "ORCHESTRATOR",
				sourceRunId: "run-1",
				authoritySessionId: "authority-1",
				providerKeys: ["github"],
			}),
		);

		await duplicate();

		expect(copied()).toMatchObject({
			conversationId: "conv-1",
			sourceRunType: "ORCHESTRATOR",
			sourceRunId: "run-1",
			authoritySessionId: "authority-1",
			providerKeys: ["github"],
		});
	});

	it("finds no copy to make of a frame the caller does not own", async () => {
		mockGetFrameById.mockResolvedValue(null);

		await expect(duplicate({}, "someone-else")).rejects.toThrow(
			"Frame not found",
		);
		expect(mockDuplicateFrame).not.toHaveBeenCalled();
	});
});
