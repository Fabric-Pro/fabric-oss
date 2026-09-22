/**
 * Unit tests for `updateContextMetadataProcedure` — Context Source Type
 * Labeling (Fizzy #1888).
 *
 * Focus: the permission and tenant guards hold; the patch reaches the shared
 * write with `null` meaning "clear" and `undefined` meaning "leave untouched";
 * `expected` is a compare-and-swap whose failure is a CONFLICT the dialog can
 * show, and whose absence is the compatibility path for older clients; and an
 * actual change — only an actual change — records one audit row and one
 * realtime event.
 *
 * The write itself (`updateContextMetadata`) is covered in
 * `packages/database/__tests__/update-context-metadata.test.ts`; here it is
 * mocked so each outcome can be driven directly.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	mockHasProjectAccess,
	mockUpdateContextMetadata,
	mockEmitContextChange,
	mockRecordAuditFromRequest,
} = vi.hoisted(() => ({
	mockHasProjectAccess: vi.fn(),
	mockUpdateContextMetadata: vi.fn(),
	mockEmitContextChange: vi.fn(),
	mockRecordAuditFromRequest: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	hasProjectAccess: mockHasProjectAccess,
	updateContextMetadata: mockUpdateContextMetadata,
	normalizeContextMetadataValue: (value: string | null | undefined) =>
		value?.trim() ? value.trim() : null,
}));

vi.mock("../../../../../lib/realtime", () => ({
	emitContextChange: mockEmitContextChange,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mockRecordAuditFromRequest,
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
		expected?: { sourceType: string | null; aiInstructions: string | null };
	};
	context: {
		user: { id: string; name?: string; email?: string };
		session: { id?: string; activeOrganizationId?: string };
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

const orgCtx = {
	user: { id: "user-1", name: "Test User", email: "test@example.com" },
	session: { id: "sess-1", activeOrganizationId: "org-1" },
};

function contextRow(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		projectId: "proj-1",
		type: "LINK",
		sourceTitle: "Docs",
		originalFilename: null,
		metadata: null,
		sourceType: "Client Chat",
		aiInstructions: "Use as source of truth.",
		metadataUpdatedAt: new Date("2026-09-22T10:00:00Z"),
		metadataUpdatedByUserId: "user-1",
		updatedAt: new Date("2026-09-22T10:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	mockHasProjectAccess.mockResolvedValue(true);
	mockEmitContextChange.mockResolvedValue(undefined);
	mockUpdateContextMetadata.mockResolvedValue({
		status: "updated",
		context: contextRow(),
		before: { sourceType: null, aiInstructions: null },
		after: {
			sourceType: "Client Chat",
			aiInstructions: "Use as source of truth.",
		},
		changed: ["sourceType", "aiInstructions"],
	});
});

describe("updateContextMetadata — guards", () => {
	it("answers FORBIDDEN when the caller lacks project access", async () => {
		mockHasProjectAccess.mockResolvedValue(false);

		const handler = await loadHandler();
		await expect(
			handler({
				input: { contextId: "ctx-1", projectId: "proj-1" },
				context: orgCtx,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockUpdateContextMetadata).not.toHaveBeenCalled();
	});

	it("answers NOT_FOUND when the context row does not exist in this tenant", async () => {
		mockUpdateContextMetadata.mockResolvedValue({ status: "not-found" });

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					contextId: "ctx-missing",
					projectId: "proj-1",
					sourceType: "Client Chat",
				},
				context: orgCtx,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });

		expect(mockRecordAuditFromRequest).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
	});

	it("scopes the write to the resolved organization and the caller", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
			},
			context: orgCtx,
		});

		expect(mockUpdateContextMetadata).toHaveBeenCalledWith(
			"ctx-1",
			"proj-1",
			{ userId: "user-1", organizationId: "org-1" },
			expect.anything(),
			expect.anything(),
		);
	});
});

describe("updateContextMetadata — patch mapping", () => {
	it("passes both fields through and returns the stored values and edit stamp", async () => {
		const handler = await loadHandler();
		const result = (await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth.",
			},
			context: orgCtx,
		})) as Record<string, unknown>;

		expect(mockUpdateContextMetadata.mock.calls[0][3]).toEqual({
			sourceType: "Client Chat",
			aiInstructions: "Use as source of truth.",
		});
		expect(result).toMatchObject({
			contextId: "ctx-1",
			sourceType: "Client Chat",
			aiInstructions: "Use as source of truth.",
			metadataUpdatedByUserId: "user-1",
		});
		expect(result.metadataUpdatedAt).toBeInstanceOf(Date);
	});

	it("maps null to an explicit clear and undefined to leave-untouched", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: null,
			},
			context: orgCtx,
		});

		expect(mockUpdateContextMetadata.mock.calls[0][3]).toEqual({
			sourceType: null,
			aiInstructions: undefined,
		});
	});
});

describe("updateContextMetadata — compare-and-swap", () => {
	it("hands `expected` to the write when the client sends it", async () => {
		const handler = await loadHandler();
		const expected = { sourceType: "QA Thread", aiInstructions: null };
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
				expected,
			},
			context: orgCtx,
		});

		expect(mockUpdateContextMetadata.mock.calls[0][4]).toEqual({
			expected,
		});
	});

	it("answers CONFLICT with the current values when the row moved, and records nothing", async () => {
		mockUpdateContextMetadata.mockResolvedValue({
			status: "stale",
			current: contextRow({
				sourceType: "SDK Docs",
				aiInstructions: "",
			}),
		});

		const handler = await loadHandler();
		await expect(
			handler({
				input: {
					contextId: "ctx-1",
					projectId: "proj-1",
					sourceType: "Client Chat",
					expected: { sourceType: "QA Thread", aiInstructions: null },
				},
				context: orgCtx,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			data: {
				current: {
					sourceType: "SDK Docs",
					aiInstructions: null,
					metadataUpdatedByUserId: "user-1",
				},
			},
		});

		expect(mockRecordAuditFromRequest).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
	});

	it("skips the comparison when `expected` is absent — the compatibility path for older clients", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
			},
			context: orgCtx,
		});

		expect(mockUpdateContextMetadata.mock.calls[0][4]).toEqual({
			expected: undefined,
		});
	});
});

describe("updateContextMetadata — audit and realtime", () => {
	it("records one audit row with before and after, and emits one realtime event", async () => {
		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth.",
			},
			context: orgCtx,
		});

		expect(mockRecordAuditFromRequest).toHaveBeenCalledTimes(1);
		const [auditContext, event] = mockRecordAuditFromRequest.mock.calls[0];
		expect(auditContext).toBe(orgCtx);
		expect(event).toEqual({
			action: "project.context_source.metadata_updated",
			category: "project",
			organizationId: "org-1",
			projectId: "proj-1",
			resource: { type: "project_context", id: "ctx-1", name: "Docs" },
			metadata: {
				changed: ["sourceType", "aiInstructions"],
				before: { sourceType: null, aiInstructions: null },
				after: {
					sourceType: "Client Chat",
					aiInstructions: "Use as source of truth.",
				},
				via: "web",
			},
		});
		expect(mockEmitContextChange).toHaveBeenCalledTimes(1);
		expect(mockEmitContextChange).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj-1",
				contextId: "ctx-1",
				action: "updated",
			}),
		);
	});

	it("reports what actually changed to the operator trail, not what was sent", async () => {
		mockUpdateContextMetadata.mockResolvedValue({
			status: "updated",
			context: contextRow(),
			before: {
				sourceType: "Client Chat",
				aiInstructions: null,
			},
			after: {
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth.",
			},
			changed: ["aiInstructions"],
		});
		const info = vi.spyOn(console, "info").mockImplementation(() => {});

		const handler = await loadHandler();
		await handler({
			input: {
				contextId: "ctx-1",
				projectId: "proj-1",
				sourceType: "Client Chat",
				aiInstructions: "Use as source of truth.",
			},
			context: orgCtx,
		});

		expect(info).toHaveBeenCalledWith(
			"analytics_event",
			expect.objectContaining({
				event: "project_context_metadata_updated",
				sourceTypeChanged: false,
				instructionsChanged: true,
			}),
		);
		info.mockRestore();
	});

	it("records and emits nothing for a save that changed nothing", async () => {
		mockUpdateContextMetadata.mockResolvedValue({
			status: "unchanged",
			context: contextRow(),
		});

		const handler = await loadHandler();
		const result = await handler({
			input: { contextId: "ctx-1", projectId: "proj-1" },
			context: orgCtx,
		});

		expect(result).toMatchObject({
			contextId: "ctx-1",
			sourceType: "Client Chat",
		});
		expect(mockRecordAuditFromRequest).not.toHaveBeenCalled();
		expect(mockEmitContextChange).not.toHaveBeenCalled();
	});
});
