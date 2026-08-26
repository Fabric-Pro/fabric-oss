import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		count: vi.fn(),
		reorderStoriesPriority: vi.fn(),
		recordAudit: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			count: mocks.count,
		},
	},
	reorderStoriesPriority: mocks.reorderStoriesPriority,
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: mocks.recordAudit,
}));

vi.mock("../../../../../orpc/procedures", () => {
	const importedHandlerKeys = ["reorderStoriesPriority"];
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

await import("../reorder-stories-priority");

const ctx = { user: { id: "u-1" }, session: {} };

const validInput = {
	projectId: "p-1",
	organizationId: null,
	storyOrders: [
		{ id: "story-1", priorityOrder: 1 },
		{ id: "story-2", priorityOrder: 2 },
	],
};

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.count.mockResolvedValue(validInput.storyOrders.length);
	mocks.reorderStoriesPriority.mockResolvedValue(undefined);
});

describe("reorder-stories-priority — happy path", () => {
	it("calls reorderStoriesPriority with the projectId and storyOrders", async () => {
		await handlers.reorderStoriesPriority({
			input: validInput,
			context: ctx,
		});

		expect(mocks.reorderStoriesPriority).toHaveBeenCalledWith(
			"p-1",
			validInput.storyOrders,
		);
	});

	it("records exactly one audit row with the priority-drag metadata", async () => {
		await handlers.reorderStoriesPriority({
			input: validInput,
			context: ctx,
		});

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			ctx,
			expect.objectContaining({
				action: "story.updated",
				metadata: expect.objectContaining({
					changedFields: ["priorityOrder"],
					via: "priority-drag",
				}),
			}),
		);
	});

	it("proceeds when the owned count matches the supplied ids", async () => {
		mocks.count.mockResolvedValue(2);

		await handlers.reorderStoriesPriority({
			input: validInput,
			context: ctx,
		});

		expect(mocks.reorderStoriesPriority).toHaveBeenCalledTimes(1);
	});
});

describe("reorder-stories-priority — validation", () => {
	it("rejects duplicate ids in the payload without calling reorderStoriesPriority", async () => {
		const dupInput = {
			projectId: "p-1",
			organizationId: null,
			storyOrders: [
				{ id: "story-1", priorityOrder: 1 },
				{ id: "story-1", priorityOrder: 2 },
			],
		};

		await expect(
			handlers.reorderStoriesPriority({ input: dupInput, context: ctx }),
		).rejects.toThrow(/duplicate/i);
		expect(mocks.reorderStoriesPriority).not.toHaveBeenCalled();
	});

	it("rejects when the owned count is fewer than the supplied ids (foreign-project ids)", async () => {
		mocks.count.mockResolvedValue(1); // only 1 of 2 ids belong to this project

		await expect(
			handlers.reorderStoriesPriority({
				input: validInput,
				context: ctx,
			}),
		).rejects.toThrow(/do not belong to this project/i);
		expect(mocks.reorderStoriesPriority).not.toHaveBeenCalled();
	});
});
