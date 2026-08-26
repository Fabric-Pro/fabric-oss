/**
 * Category persistence (B1/B2): `persistBusinessGraph` writes the AI category
 * onto capability nodes, and `updateModuleDescriptions` writes the category onto
 * module nodes (only when the AI returned one).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mockNodeDeleteMany = vi.fn();
const mockNodeCreateMany = vi.fn();
const mockNodeUpdateMany = vi.fn();
const mockEdgeDeleteMany = vi.fn();
const mockEdgeCreateMany = vi.fn();
const mockTransaction = vi.fn();

vi.mock("@repo/database", () => ({
	db: {
		atlasNode: {
			deleteMany: (...a: unknown[]) => mockNodeDeleteMany(...a),
			createMany: (...a: unknown[]) => mockNodeCreateMany(...a),
			updateMany: (...a: unknown[]) => mockNodeUpdateMany(...a),
		},
		atlasEdge: {
			deleteMany: (...a: unknown[]) => mockEdgeDeleteMany(...a),
			createMany: (...a: unknown[]) => mockEdgeCreateMany(...a),
		},
		$transaction: (...a: unknown[]) => mockTransaction(...a),
	},
	Prisma: {},
}));
vi.mock("@repo/utils", () => ({ decryptApiKey: vi.fn() }));

import { persistBusinessGraph, updateModuleDescriptions } from "../queries";

const ctx = { userId: "user-1", organizationId: "org-1" };

beforeEach(() => {
	vi.clearAllMocks();
	mockTransaction.mockResolvedValue([]);
});

describe("persistBusinessGraph — capability category", () => {
	it("writes the AI category onto each capability node row", async () => {
		await persistBusinessGraph(ctx, {
			analysisId: "an-1",
			projectId: "p1",
			draft: {
				capabilities: [
					{
						key: "billing",
						label: "Billing",
						description: "Handles billing",
						category: "data",
						moduleKeys: ["mod-1"],
					},
					{
						key: "auth",
						label: "Auth",
						description: "Handles auth",
						category: null,
						moduleKeys: ["mod-2"],
					},
				],
				relations: [],
			},
		});

		const nodeRows = mockNodeCreateMany.mock.calls[0][0].data;
		expect(nodeRows[0]).toMatchObject({ key: "billing", category: "data" });
		expect(nodeRows[1]).toMatchObject({ key: "auth", category: null });
	});
});

describe("updateModuleDescriptions — module category", () => {
	it("sets category when the AI returned one, and omits it when null", async () => {
		await updateModuleDescriptions("an-1", [
			{ key: "mod-1", technical: "t1", business: "b1", category: "ai" },
			{ key: "mod-2", technical: "t2", business: "b2", category: null },
		]);

		const firstData = mockNodeUpdateMany.mock.calls[0][0].data;
		const secondData = mockNodeUpdateMany.mock.calls[1][0].data;
		expect(firstData).toMatchObject({
			technicalDescription: "t1",
			businessDescription: "b1",
			category: "ai",
		});
		// A null/absent category must not wipe a previously-good one.
		expect(secondData).not.toHaveProperty("category");
	});
});
