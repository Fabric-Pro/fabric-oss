/**
 * `listContexts` returns metadata, never the body.
 *
 * A project's contexts can hold megabytes of text each, and the Context tab
 * refetches this list every couple of seconds while a repository sync runs, so
 * a body per row was downloaded to the browser every two seconds. The list now
 * omits `content` at the query and carries a bounded preview and the length.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	findMany: vi.fn(),
	count: vi.fn(),
	$queryRaw: vi.fn(),
}));

vi.mock("../prisma/client", () => ({
	db: {
		projectContext: { findMany: m.findMany, count: m.count },
		$queryRaw: m.$queryRaw,
	},
	Prisma: {},
}));

import { listContexts } from "../prisma/queries/projects/contexts";

beforeEach(() => {
	m.findMany.mockReset();
	m.count.mockReset();
	m.$queryRaw.mockReset();
	m.count.mockResolvedValue(2);
});

describe("listContexts", () => {
	it("omits the body at the query", async () => {
		m.findMany.mockResolvedValue([]);

		await listContexts({ projectId: "proj_1", limit: "none" });

		expect(m.findMany.mock.calls[0]?.[0].omit).toEqual({ content: true });
		expect(m.findMany.mock.calls[0]?.[0]).not.toHaveProperty("select");
	});

	it("carries a bounded preview and the character length per row, in one extra statement", async () => {
		m.findMany.mockResolvedValue([
			{ id: "a", contentHash: "h1" },
			{ id: "b", contentHash: null },
		]);
		m.$queryRaw.mockResolvedValue([
			{ id: "a", preview: "# Title\nbody", length: 12 },
			{ id: "b", preview: null, length: null },
		]);

		const result = await listContexts({
			projectId: "proj_1",
			limit: "none",
		});

		expect(m.$queryRaw).toHaveBeenCalledTimes(1);
		const [strings, ...values] = m.$queryRaw.mock.calls[0] as [
			readonly string[],
			...unknown[],
		];
		expect(strings.join("?")).toContain('left(c."content"');
		// Bounded: the preview length is a fixed 300, whatever the body holds.
		expect(values).toContain(300);
		expect(values).toContain("proj_1");
		expect(values).toContainEqual(["a", "b"]);
		expect(result.contexts).toEqual([
			{
				id: "a",
				contentHash: "h1",
				contentPreview: "# Title\nbody",
				contentLength: 12,
			},
			{
				id: "b",
				contentHash: null,
				contentPreview: null,
				contentLength: 0,
			},
		]);
		for (const row of result.contexts) {
			expect(row).not.toHaveProperty("content");
		}
	});

	it("issues no statistics query for an empty list", async () => {
		m.findMany.mockResolvedValue([]);
		m.count.mockResolvedValue(0);

		const result = await listContexts({
			projectId: "proj_1",
			limit: "none",
		});

		expect(m.$queryRaw).not.toHaveBeenCalled();
		expect(result).toEqual({ contexts: [], total: 0, hasMore: false });
	});
});
