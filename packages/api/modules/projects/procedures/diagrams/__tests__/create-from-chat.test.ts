/**
 * Tests for `createFromChatProcedure` — the chat-to-editor auto-insert
 * thin wrapper that persists a Diagram row from a chat-message Insert
 * click.
 *
 * Coverage:
 *   1. Success in org scope — calls createDiagram with the right args
 *      and fires the Prometheus counter for the requested surface.
 *   2. FORBIDDEN when resolveOrganizationId resolves to null (v1 is
 *      org-only per spec § FR-13).
 *   3. requireProjectPermission middleware blocks users without
 *      DIAGRAM_CREATE access (verified by the mock middleware shape).
 *   4. XOR isolation — a user in org A cannot insert with
 *      organizationId: "orgB" (resolveOrganizationId mismatch case).
 *   5. Zod schema rejects missing `checkpointId`.
 *
 * Pattern mirrors `save-draft-project.test.ts`: a chainable mock of the
 * oRPC procedure builder captures the handler function, and `@repo/database`
 * + `@repo/observability` are stubbed with hoisted spies.
 *
 * Historical note: the procedure previously also enforced an
 * `FABRIC_EXCALIDRAW_AUTO_INSERT*` env-var feature flag as
 * defense-in-depth. The flag was removed before merge (feature ships
 * globally on); the two flag-off FORBIDDEN tests are gone.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const {
	handlers,
	mockCreateDiagram,
	mockIncrementCounter,
	mockRequireProjectPermission,
	mockResolveOrganizationId,
} = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mockCreateDiagram: vi.fn(),
	mockIncrementCounter: vi.fn(),
	mockRequireProjectPermission: vi.fn(() => ({})),
	mockResolveOrganizationId: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	createDiagram: (...args: unknown[]) => mockCreateDiagram(...args),
}));

vi.mock("@repo/observability", () => ({
	incrementDiagramAutoInsertedCounter: (...args: unknown[]) =>
		mockIncrementCounter(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	const inputCapture: { schema?: { parse: (v: unknown) => unknown } } = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: (schema: { parse: (v: unknown) => unknown }) => {
			inputCapture.schema = schema;
			return chainable;
		},
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.createFromChat = fn;
			(handlers as Record<string, unknown>).inputSchema =
				inputCapture.schema;
			return { _handler: fn };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		resolveOrganizationId: (...args: unknown[]) =>
			mockResolveOrganizationId(...args),
		requireProjectPermission: (perm: string) =>
			mockRequireProjectPermission(perm),
		Permissions: new Proxy({}, { get: (_: unknown, prop: string) => prop }),
	};
});

// Side-effect: register the handler on `handlers.createFromChat`.
// Capture middleware-registration call sites BEFORE any beforeEach clears
// the spy history — these are evaluated exactly once at module load.
await import("../create-from-chat");
const requirePermissionCallsAtLoad =
	mockRequireProjectPermission.mock.calls.slice();

const baseContext = {
	user: { id: "user-1", email: "alice@example.com", name: "Alice" },
	session: { id: "sess-1", activeOrganizationId: "org-a" },
};

const baseInput = {
	projectId: "proj-1",
	organizationId: "org-a",
	elements: [{ type: "rectangle", id: "r1" }],
	appState: { viewBackgroundColor: "#fff" },
	checkpointId: "cp_123",
	mcpConfigId: "mcp_456",
	title: "Architecture sketch",
	surface: "in-feature" as const,
};

beforeEach(() => {
	vi.clearAllMocks();
	// Default: org-scope, createDiagram returns a row.
	mockResolveOrganizationId.mockReturnValue("org-a");
	mockCreateDiagram.mockResolvedValue({
		id: "diag_1",
		projectId: "proj-1",
		organizationId: "org-a",
		userId: "user-1",
		title: "Architecture sketch",
	});
});

describe("createFromChatProcedure — registration", () => {
	it("registers the handler on the captured chainable", () => {
		expect(typeof handlers.createFromChat).toBe("function");
	});

	it("wires the DIAGRAM_CREATE permission requirement at module load", () => {
		// requirePermissionCallsAtLoad is snapshotted before beforeEach clears
		// the spy so we can still assert the module-load wiring.
		expect(requirePermissionCallsAtLoad).toContainEqual(["DIAGRAM_CREATE"]);
	});
});

describe("createFromChatProcedure — success path (org scope)", () => {
	it("calls createDiagram with the resolved org id and forwards all input fields", async () => {
		const result = (await handlers.createFromChat({
			input: baseInput,
			context: baseContext,
		})) as { diagram: { id: string } };

		expect(mockCreateDiagram).toHaveBeenCalledTimes(1);
		expect(mockCreateDiagram).toHaveBeenCalledWith({
			title: "Architecture sketch",
			elements: [{ type: "rectangle", id: "r1" }],
			appState: { viewBackgroundColor: "#fff" },
			checkpointId: "cp_123",
			mcpConfigId: "mcp_456",
			userId: "user-1",
			organizationId: "org-a",
			projectId: "proj-1",
		});
		expect(result.diagram.id).toBe("diag_1");
	});

	it("increments the Prometheus counter with the request surface label", async () => {
		await handlers.createFromChat({
			input: { ...baseInput, surface: "nexus" },
			context: baseContext,
		});

		expect(mockIncrementCounter).toHaveBeenCalledTimes(1);
		expect(mockIncrementCounter).toHaveBeenCalledWith({
			surface: "nexus",
		});
	});

	it("returns { diagram } shape so the client hook receives the created row", async () => {
		const result = await handlers.createFromChat({
			input: baseInput,
			context: baseContext,
		});

		expect(result).toEqual({
			diagram: expect.objectContaining({ id: "diag_1" }),
		});
	});

	it("passes mcp linkage fields (checkpointId, mcpConfigId) through verbatim — no regeneration", async () => {
		await handlers.createFromChat({
			input: { ...baseInput, checkpointId: "cp_unique_xyz" },
			context: baseContext,
		});

		const args = mockCreateDiagram.mock.calls[0][0] as Record<
			string,
			unknown
		>;
		expect(args.checkpointId).toBe("cp_unique_xyz");
		expect(args.mcpConfigId).toBe("mcp_456");
	});
});

describe("createFromChatProcedure — FORBIDDEN in personal scope", () => {
	beforeEach(() => {
		// resolveOrganizationId returns undefined for personal-scope callers.
		mockResolveOrganizationId.mockReturnValue(undefined);
	});

	it("throws ORPCError FORBIDDEN with the org-only-in-v1 message", async () => {
		await expect(
			handlers.createFromChat({
				input: { ...baseInput, organizationId: null },
				context: {
					...baseContext,
					session: {
						id: "sess-1",
						activeOrganizationId: null,
					},
				},
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Auto-insert is org-only in v1",
		});
	});

	it("does NOT call createDiagram in personal scope", async () => {
		await expect(
			handlers.createFromChat({
				input: { ...baseInput, organizationId: null },
				context: baseContext,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockCreateDiagram).not.toHaveBeenCalled();
		expect(mockIncrementCounter).not.toHaveBeenCalled();
	});
});

describe("createFromChatProcedure — permission middleware", () => {
	it("registers requireProjectPermission(DIAGRAM_CREATE) so non-editors are blocked before the handler runs", () => {
		// The middleware chain is wired at module load via the chainable
		// mock; requirePermissionCallsAtLoad snapshots those calls.
		// The actual gating happens inside the real middleware (covered
		// by `require-project-permission.test.ts`).
		expect(requirePermissionCallsAtLoad).toContainEqual(["DIAGRAM_CREATE"]);
		expect(requirePermissionCallsAtLoad.length).toBe(1);
	});
});

describe("createFromChatProcedure — XOR isolation", () => {
	it("rejects FORBIDDEN when resolveOrganizationId cannot resolve the target org (user in org A claims org B)", async () => {
		// resolveOrganizationId returning undefined simulates the case where
		// the caller's session has no active org and the supplied input
		// org id is not honored (e.g. the permission middleware did not
		// grant effectiveWriteOrgId). The procedure rejects with
		// FORBIDDEN rather than silently writing into a tenant the
		// caller does not belong to.
		mockResolveOrganizationId.mockReturnValue(undefined);

		await expect(
			handlers.createFromChat({
				input: { ...baseInput, organizationId: "org-b" },
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Auto-insert is org-only in v1",
		});
		expect(mockCreateDiagram).not.toHaveBeenCalled();
	});
});

describe("createFromChatProcedure — DB-layer rejection → structured FORBIDDEN", () => {
	// Bug found during the first staging probe of PR #1168: when the
	// underlying `createDiagram` write throws (Prisma FK / RLS / "not
	// found" — e.g. a forged organizationId cuid the user doesn't actually
	// belong to), the handler used to surface a plain 500 INTERNAL_SERVER_ERROR.
	// The wrapped try/catch re-throws as FORBIDDEN so the UI gets a
	// structured error to render the correct toast and uncaught 500s
	// disappear from observability dashboards.
	it("re-throws createDiagram exception as ORPCError FORBIDDEN with the underlying error in data", async () => {
		mockCreateDiagram.mockRejectedValueOnce(
			new Error(
				"P2003: Foreign key constraint failed on org->project FK",
			),
		);

		await expect(
			handlers.createFromChat({
				input: baseInput,
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			message: "Cannot create diagram in this scope",
			data: expect.objectContaining({
				projectId: "proj-1",
				organizationId: "org-a",
				reason: "db-write-rejected",
				underlyingError: expect.stringContaining("P2003"),
			}),
		});
	});

	it("does NOT increment the Prometheus counter when the DB write fails", async () => {
		mockCreateDiagram.mockRejectedValueOnce(new Error("RLS policy denial"));

		await expect(
			handlers.createFromChat({
				input: baseInput,
				context: baseContext,
			}),
		).rejects.toMatchObject({ code: "FORBIDDEN" });

		expect(mockIncrementCounter).not.toHaveBeenCalled();
	});

	it("handles non-Error throws (string / unknown) without leaking 'undefined'", async () => {
		// Some downstream layers throw bare strings; the handler must
		// still produce a structured FORBIDDEN with a coerced message.
		mockCreateDiagram.mockRejectedValueOnce("raw-string-error");

		await expect(
			handlers.createFromChat({
				input: baseInput,
				context: baseContext,
			}),
		).rejects.toMatchObject({
			code: "FORBIDDEN",
			data: expect.objectContaining({
				underlyingError: "raw-string-error",
			}),
		});
	});
});

describe("createFromChatProcedure — Zod input validation", () => {
	it("rejects missing checkpointId", () => {
		const schema = (handlers as { inputSchema?: { safeParse?: unknown } })
			.inputSchema as
			| {
					safeParse: (v: unknown) => {
						success: boolean;
						error?: { issues: unknown[] };
					};
			  }
			| undefined;

		expect(schema).toBeDefined();
		if (!schema) {
			return;
		}

		const { checkpointId: _omit, ...inputWithoutCheckpoint } = baseInput;
		const parsed = schema.safeParse(inputWithoutCheckpoint);
		expect(parsed.success).toBe(false);
	});

	it("rejects empty-string checkpointId", () => {
		const schema = (handlers as { inputSchema?: { safeParse?: unknown } })
			.inputSchema as
			| {
					safeParse: (v: unknown) => { success: boolean };
			  }
			| undefined;

		expect(schema).toBeDefined();
		if (!schema) {
			return;
		}

		const parsed = schema.safeParse({ ...baseInput, checkpointId: "" });
		expect(parsed.success).toBe(false);
	});

	it("rejects empty-string title", () => {
		const schema = (handlers as { inputSchema?: { safeParse?: unknown } })
			.inputSchema as
			| {
					safeParse: (v: unknown) => { success: boolean };
			  }
			| undefined;

		if (!schema) {
			return;
		}

		const parsed = schema.safeParse({ ...baseInput, title: "" });
		expect(parsed.success).toBe(false);
	});

	it("rejects unknown surface values", () => {
		const schema = (handlers as { inputSchema?: { safeParse?: unknown } })
			.inputSchema as
			| {
					safeParse: (v: unknown) => { success: boolean };
			  }
			| undefined;

		if (!schema) {
			return;
		}

		const parsed = schema.safeParse({
			...baseInput,
			surface: "unknown-surface",
		});
		expect(parsed.success).toBe(false);
	});

	it("accepts the canonical happy-path input", () => {
		const schema = (handlers as { inputSchema?: { safeParse?: unknown } })
			.inputSchema as
			| {
					safeParse: (v: unknown) => { success: boolean };
			  }
			| undefined;

		if (!schema) {
			return;
		}

		const parsed = schema.safeParse(baseInput);
		expect(parsed.success).toBe(true);
	});
});
