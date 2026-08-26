import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-test the taxonomy helpers without a database.
const dtFindFirst = vi.fn();
const dtCreate = vi.fn();

vi.mock("../../../client", () => ({
	db: {
		decisionType: {
			findFirst: (...a: unknown[]) => dtFindFirst(...a),
			create: (...a: unknown[]) => dtCreate(...a),
		},
	},
}));

import { ensureDecisionType } from "../decision-types";

const row = (name: string) => ({
	id: `id-${name}`,
	name,
	origin: "HUMAN",
	archivedAt: null,
	createdAt: new Date(),
});

beforeEach(() => {
	dtFindFirst.mockReset();
	dtCreate.mockReset();
});

describe("ensureDecisionType", () => {
	it("returns the existing case-insensitive match without creating", async () => {
		dtFindFirst.mockResolvedValue(row("Architecture"));
		const out = await ensureDecisionType({
			projectId: "p1",
			name: "architecture",
		});
		expect(out.name).toBe("Architecture");
		expect(dtCreate).not.toHaveBeenCalled();
	});

	it("creates with the AI origin when nothing matches", async () => {
		dtFindFirst.mockResolvedValueOnce(null);
		dtCreate.mockResolvedValue(row("Deployment"));
		const out = await ensureDecisionType({
			projectId: "p1",
			name: "Deployment",
			origin: "AI",
		});
		expect(dtCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					name: "Deployment",
					origin: "AI",
					projectId: "p1",
				}),
			}),
		);
		expect(out.id).toBe("id-Deployment");
	});

	it("re-reads the winner's row after losing a concurrent create", async () => {
		dtFindFirst
			.mockResolvedValueOnce(null) // pre-check misses
			.mockResolvedValueOnce(row("Deployment")); // post-P2002 re-read
		dtCreate.mockRejectedValue(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);
		const out = await ensureDecisionType({
			projectId: "p1",
			name: "Deployment",
		});
		expect(out.name).toBe("Deployment");
	});

	it("rethrows non-uniqueness errors", async () => {
		dtFindFirst.mockResolvedValue(null);
		dtCreate.mockRejectedValue(new Error("connection refused"));
		await expect(
			ensureDecisionType({ projectId: "p1", name: "X" }),
		).rejects.toThrow("connection refused");
	});
});
