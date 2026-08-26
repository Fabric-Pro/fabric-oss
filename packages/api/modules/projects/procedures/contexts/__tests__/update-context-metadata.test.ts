/**
 * Unit tests for `updateContextMetadataProcedure` — Context Source Type
 * Labeling (Fizzy #1888).
 *
 * Focus: permission and tenant-XOR guards hold, and the patch maps `null`
 * to "clear" vs `undefined` to "leave untouched" so a save that clears both
 * fields writes explicit nulls.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockGetContextById,
	mockHasProjectAccess,
	mockDbUpdate,
	mockEmitContextChange,
} = vi.hoisted(() => ({
	mockGetContextById: vi.fn(),
	mockHasProjectAccess: vi.fn(),
	mockDbUpdate: vi.fn(),
	mockEmitContextChange: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	getContextById: mockGetContextById,
	hasProjectAccess: mockHasProjectAccess,
	db: {
		projectContext: {
			update: mockDbUpdate,
		},
	},
}));

vi.mock("../../../../lib/realtime", () => ({
	emitContextChange: mockEmitContextChange,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const builder: Record<string, unknown> = {};
	builder.use = () => builder;
	builder.route = () => builder;
	builder.input = () => builder;
	builder.handler = (fn: unknown) => ({ handler: fn });
	return {
		tenantProtectedProcedure: builder,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) => {
			if (input) {
				return input;
			}
			if (input === null) {
				return undefined;
			}
			return session?.activeOrganizationId ?? undefined;
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		requireInputOrgPermission: () => (c: unknown) => c,
	};
});

type Handler = (args: {
	input: {
		contextId: string;
		projectId: string;
		organizationId?: string | null;
		sourceType?: string | null;
		aiInstructions?: string | null;
	};
	context: {
		user: { id: string; name?: string; email?: string };
		session: { activeOrganizationId?: string };
	};
}) => Promise<unknown>;

async function loadHandler(): Promise<Handler> {
	const mod = await import("../update-context-metadata");
	return (
		mod.updateContextMetadataProcedure as unknown as {
			handler: Handler;
		}
	).handler;
}

const personalCtx = {
	user: { id: "user-1", name: "Test User", email: "test@example.com" },
	session: { activeOrganizationId: undefined },
};

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockEmitContextChange.mockResolvedValue(undefined);
});

describe("updateContextMetadata — guards", () => {
	it("answers FORBIDDEN when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-1", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockGetContextById).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the context row does not exist in this tenant", async () => {
		mockGetContextById.mockResolvedValue(null);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-missing", projectId: "proj-1" },
				context: personalCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mockDbUpdate).not.toHaveBeenCalled();
	});
});

describe("updateContextMetadata — patch mapping", () => {
	it("writes both fields and returns the updated values", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			type: "LINK",
			projectId: "proj-1",
			sourceTitle: "Docs",
		});
		mockDbUpdate.mockResolvedValue({
			id: "ctx-1",
			sourceType: "Client Chat",
			aiInstructions: "Use as source of truth.",
		});

		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth.",
			},
			context: personalCtx,
		})) as { sourceType?: string; aiInstructions?: string };

		expect(mockDbUpdate).toHaveBeenCalledWith({
			where: { id: "ctx-1" },
			data: {
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth.",
			},
			select: { id: true, sourceType: true, aiInstructions: true },
		});
		expect(result.sourceType).toBe("Client Chat");
		expect(result.aiInstructions).toBe("Use as source of truth.");
	});

	it("maps null to an explicit clear and undefined to leave-untouched", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			type: "TEXT",
			projectId: "proj-1",
			sourceTitle: null,
		});
		mockDbUpdate.mockResolvedValue({
			id: "ctx-1",
			sourceType: null,
			aiInstructions: "Keep me",
		});

		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: null,
			},
			context: personalCtx,
		});

		expect(mockDbUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: { sourceType: null },
			}),
		);
	});

	it("does not write anything when neither field was supplied", async () => {
		mockGetContextById.mockResolvedValue({
			id: "ctx-1",
			type: "TEXT",
			projectId: "proj-1",
			sourceTitle: null,
		});

		const handler = await loadHandler();
		await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: personalCtx,
		});

		expect(mockDbUpdate).not.toHaveBeenCalled();
	});
});
