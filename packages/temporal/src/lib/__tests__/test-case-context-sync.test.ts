import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	create: vi.fn(),
	get: vi.fn(),
	update: vi.fn(),
	link: vi.fn(),
	start: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	createContext: mocks.create,
	getContextById: mocks.get,
	updateContext: mocks.update,
	setTestCaseContextId: mocks.link,
}));
vi.mock("../../client", () => ({
	getTemporalClient: async () => ({ workflow: { start: mocks.start } }),
}));
vi.mock("@repo/logs", () => ({ logger: { error: vi.fn() } }));

import { syncTestCaseContext } from "../test-case-context-sync";

const params = {
	testCaseId: "example-case",
	projectId: "example-project",
	contextId: "example-old-context",
	content: "Example content",
	sourceTitle: "Example case",
	userId: "example-user",
	organizationId: "example-org",
};
beforeEach(() => {
	vi.resetAllMocks();
	mocks.create.mockResolvedValue({ id: "example-new-context" });
	mocks.get.mockResolvedValue({ projectId: "example-project" });
});
describe("syncTestCaseContext", () => {
	it("recreates a context belonging to a different project without updating it", async () => {
		mocks.get.mockResolvedValue({ projectId: "example-other-project" });
		expect(await syncTestCaseContext(params)).toBe("example-new-context");
		expect(mocks.update).not.toHaveBeenCalled();
		expect(mocks.link).toHaveBeenCalledWith({
			id: "example-case",
			contextId: "example-new-context",
		});
	});
	it("persists empty content without starting embedding", async () => {
		expect(await syncTestCaseContext({ ...params, content: "  " })).toBe(
			"example-old-context",
		);
		expect(mocks.update).toHaveBeenCalledWith(
			"example-old-context",
			expect.objectContaining({ content: "  " }),
		);
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("returns the prior context when a database write fails", async () => {
		mocks.update.mockRejectedValue(new Error("Example write failure"));
		expect(await syncTestCaseContext(params)).toBe("example-old-context");
		expect(mocks.start).not.toHaveBeenCalled();
	});
	it("returns the created context when embedding fails", async () => {
		mocks.start.mockRejectedValue(new Error("Example workflow failure"));
		expect(await syncTestCaseContext({ ...params, contextId: null })).toBe(
			"example-new-context",
		);
		expect(mocks.link).toHaveBeenCalledTimes(1);
	});
	it("passes a supplied memo into the embedding workflow start", async () => {
		await syncTestCaseContext({
			...params,
			memo: { correlationId: "example-request" },
		});
		expect(mocks.start).toHaveBeenCalledWith(
			"contextEmbeddingWorkflow",
			expect.objectContaining({
				memo: { correlationId: "example-request" },
			}),
		);
	});
});
