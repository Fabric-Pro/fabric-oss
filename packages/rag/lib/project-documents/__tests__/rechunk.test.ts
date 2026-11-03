import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	order: [] as string[],
	list: vi.fn(),
	del: vi.fn(),
	embed: vi.fn(),
}));

vi.mock("../../project-contexts/store", () => ({
	listProjectContextPointIds: m.list,
	deleteProjectContextPoints: m.del,
}));
vi.mock("../embed", () => ({ embedProjectDocument: m.embed }));
vi.mock("@repo/logs", () => ({
	logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { documentPointIds, rechunkProjectDocument } from "../rechunk";

const options = {
	documentId: "d1",
	projectId: "p1",
	userId: "u1",
	organizationId: "org-example",
	content: "# Doc",
	documentType: "PRD",
	title: "Doc",
	apiKey: { apiKey: "k" },
	expectedVersion: 4,
};

beforeEach(() => {
	vi.clearAllMocks();
	m.order.length = 0;
	m.embed.mockImplementation(async () => {
		m.order.push("embed");
		return { success: true, chunksCreated: 2 };
	});
	m.del.mockImplementation(async () => {
		m.order.push("delete");
	});
});

describe("rechunkProjectDocument", () => {
	it("writes the new points before deleting only the old ones it did not overwrite", async () => {
		const kept = documentPointIds("d1", 4, 2);
		m.list.mockResolvedValue([...kept, "old-tail-1", "old-tail-2"]);

		const result = await rechunkProjectDocument(options);

		expect(m.order).toEqual(["embed", "delete"]);
		expect(m.del).toHaveBeenCalledWith(
			["old-tail-1", "old-tail-2"],
			"org-example",
		);
		expect(result.removedPoints).toBe(2);
	});

	it("deletes nothing when the embed fails", async () => {
		m.list.mockResolvedValue(["a", "b"]);
		m.embed.mockResolvedValue({ success: false, error: "down" });
		const result = await rechunkProjectDocument(options);
		expect(result.success).toBe(false);
		expect(m.del).not.toHaveBeenCalled();
	});
});
