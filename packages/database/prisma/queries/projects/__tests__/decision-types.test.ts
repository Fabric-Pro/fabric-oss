import { beforeEach, describe, expect, it, vi } from "vitest";

// Unit-test the taxonomy helpers without a database.
const dtFindFirst = vi.fn();
const dtCreate = vi.fn();
const dtUpdate = vi.fn();
const dtUpdateMany = vi.fn();
const dtFindUnique = vi.fn();

vi.mock("../../../client", () => ({
	db: {
		decisionType: {
			findFirst: (...a: unknown[]) => dtFindFirst(...a),
			create: (...a: unknown[]) => dtCreate(...a),
			update: (...a: unknown[]) => dtUpdate(...a),
			updateMany: (...a: unknown[]) => dtUpdateMany(...a),
			findUnique: (...a: unknown[]) => dtFindUnique(...a),
		},
	},
}));

import {
	archiveDecisionType,
	ensureDecisionType,
	restoreDecisionType,
} from "../decision-types";

const row = (name: string) => ({
	id: `id-${name}`,
	name,
	origin: "HUMAN",
	archivedAt: null,
	createdAt: new Date(),
});

const archivedRow = (name: string) => ({
	...row(name),
	archivedAt: new Date("2026-01-01T00:00:00.000Z"),
});

beforeEach(() => {
	dtFindFirst.mockReset();
	dtCreate.mockReset();
	dtUpdate.mockReset();
	dtUpdateMany.mockReset();
	dtFindUnique.mockReset();
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

	// The unique constraint spans archived rows, so re-minting an archived name
	// cannot create a second row. Reviving the original is the only outcome that
	// leaves the type visible in the picker again.
	it("revives an archived row instead of returning it archived", async () => {
		dtFindFirst.mockResolvedValue(archivedRow("Reliability"));
		dtUpdate.mockResolvedValue(row("Reliability"));
		const out = await ensureDecisionType({
			projectId: "p1",
			name: "reliability",
		});
		expect(dtUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "id-Reliability" },
				data: { archivedAt: null },
			}),
		);
		expect(out.archivedAt).toBeNull();
		expect(dtCreate).not.toHaveBeenCalled();
	});

	it("revives the winner when a concurrent create loses to an archived row", async () => {
		dtFindFirst
			.mockResolvedValueOnce(null)
			.mockResolvedValueOnce(archivedRow("Deployment"));
		dtCreate.mockRejectedValue(
			Object.assign(new Error("unique"), { code: "P2002" }),
		);
		dtUpdate.mockResolvedValue(row("Deployment"));
		const out = await ensureDecisionType({
			projectId: "p1",
			name: "Deployment",
		});
		expect(out.archivedAt).toBeNull();
	});
});

describe("archiveDecisionType", () => {
	it("stamps archivedAt and returns the row", async () => {
		dtUpdateMany.mockResolvedValue({ count: 1 });
		dtFindUnique.mockResolvedValue(archivedRow("Reliability"));
		const out = await archiveDecisionType({
			id: "id-Reliability",
			projectId: "p1",
		});
		expect(out?.archivedAt).not.toBeNull();
		expect(dtUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "id-Reliability",
					projectId: "p1",
					archivedAt: null,
				}),
			}),
		);
	});

	// Scoping the update by projectId is what stops one project archiving
	// another's taxonomy entry by id.
	it("returns null when the id does not belong to the project", async () => {
		dtUpdateMany.mockResolvedValue({ count: 0 });
		const out = await archiveDecisionType({
			id: "id-Reliability",
			projectId: "other-project",
		});
		expect(out).toBeNull();
		expect(dtFindUnique).not.toHaveBeenCalled();
	});

	it("is idempotent — archiving an already-archived type is a no-op", async () => {
		dtUpdateMany.mockResolvedValue({ count: 0 });
		const out = await archiveDecisionType({
			id: "id-Reliability",
			projectId: "p1",
		});
		expect(out).toBeNull();
	});
});

describe("restoreDecisionType", () => {
	it("clears archivedAt and returns the row", async () => {
		dtUpdateMany.mockResolvedValue({ count: 1 });
		dtFindUnique.mockResolvedValue(row("Reliability"));
		const out = await restoreDecisionType({
			id: "id-Reliability",
			projectId: "p1",
		});
		expect(out?.archivedAt).toBeNull();
		expect(dtUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					id: "id-Reliability",
					projectId: "p1",
					archivedAt: { not: null },
				}),
			}),
		);
	});

	// Same scoping guarantee as archive: an id alone must not reach across
	// projects.
	it("returns null when the id does not belong to the project", async () => {
		dtUpdateMany.mockResolvedValue({ count: 0 });
		const out = await restoreDecisionType({
			id: "id-Reliability",
			projectId: "other-project",
		});
		expect(out).toBeNull();
		expect(dtFindUnique).not.toHaveBeenCalled();
	});

	it("returns null for a type that was never archived", async () => {
		dtUpdateMany.mockResolvedValue({ count: 0 });
		await expect(
			restoreDecisionType({ id: "id-Live", projectId: "p1" }),
		).resolves.toBeNull();
	});
});
