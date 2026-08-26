import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		clearStoriesPriorityOrder: vi.fn(),
		recordAudit: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	clearStoriesPriorityOrder: mocks.clearStoriesPriorityOrder,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["resetStoriesPriorityOrder"];
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
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null) =>
			organizationId,
	};
});

await import("../reset-stories-priority-order");

const ctx = { user: { id: "u-1" }, session: {} };

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.clearStoriesPriorityOrder.mockResolvedValue(3);
});

describe("reset-stories-priority-order — happy path", () => {
	it("calls clearStoriesPriorityOrder(projectId, kind) and returns { cleared }", async () => {
		mocks.clearStoriesPriorityOrder.mockResolvedValue(7);

		const result = await handlers.resetStoriesPriorityOrder({
			input: { projectId: "p-1", organizationId: null, kind: "FEATURE" },
			context: ctx,
		});

		expect(mocks.clearStoriesPriorityOrder).toHaveBeenCalledWith(
			"p-1",
			"FEATURE",
		);
		expect(result).toEqual({ cleared: 7 });
	});

	it("passes exactly 'BUG' when resetting bugs — never leaks FEATURE", async () => {
		await handlers.resetStoriesPriorityOrder({
			input: { projectId: "p-1", organizationId: null, kind: "BUG" },
			context: ctx,
		});

		expect(mocks.clearStoriesPriorityOrder).toHaveBeenCalledWith(
			"p-1",
			"BUG",
		);
		expect(mocks.clearStoriesPriorityOrder).not.toHaveBeenCalledWith(
			"p-1",
			"FEATURE",
		);
	});

	it("records an audit row with via=priority-reset and the kind in metadata", async () => {
		await handlers.resetStoriesPriorityOrder({
			input: { projectId: "p-1", organizationId: null, kind: "BUG" },
			context: ctx,
		});

		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.updated",
				metadata: expect.objectContaining({
					via: "priority-reset",
					kind: "BUG",
				}),
			}),
		);
	});
});
