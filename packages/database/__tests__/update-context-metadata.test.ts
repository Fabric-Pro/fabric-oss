/**
 * `updateContextMetadata` — the one write behind the Context tab's
 * source-details dialog and the `fabric_update_project_context` MCP tool.
 *
 * What this pins:
 *  - the tenant + project scope on the read AND on the write;
 *  - the compare-and-swap: a stale `expected` writes nothing, a matching one
 *    writes and stamps who and when, and a write that loses a race to a
 *    concurrent save (zero rows matched) is reported stale, not retried;
 *  - one representation: blank is stored as NULL and compares equal to NULL;
 *  - `undefined` leaves a field alone, and a save that changes nothing writes
 *    nothing — no stamp, so "last edited" means an edit happened.
 *
 * Run with: pnpm --filter @repo/database test __tests__/update-context-metadata.test.ts
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	projectContext: {
		findFirst: vi.fn(),
		findFirstOrThrow: vi.fn(),
		updateMany: vi.fn(),
	},
}));

vi.mock("../prisma/client", () => ({
	db: {
		$transaction: (fn: (client: typeof tx) => Promise<unknown>) => fn(tx),
	},
	Prisma: { sql: vi.fn(), join: vi.fn() },
}));

import {
	normalizeContextMetadataValue,
	updateContextMetadata,
} from "../prisma/queries/projects/contexts";

const ORG_TENANT = { userId: "user-1", organizationId: "org-1" };

function row(overrides: Record<string, unknown> = {}) {
	return {
		id: "ctx-1",
		projectId: "proj-1",
		type: "MEETING_TRANSCRIPT",
		sourceTitle: "Weekly sync",
		originalFilename: null,
		metadata: null,
		sourceType: "Client Chat",
		aiInstructions: null,
		metadataUpdatedAt: null,
		metadataUpdatedByUserId: null,
		updatedAt: new Date("2026-09-01T00:00:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	tx.projectContext.findFirst.mockResolvedValue(row());
	tx.projectContext.updateMany.mockResolvedValue({ count: 1 });
	tx.projectContext.findFirstOrThrow.mockImplementation(async () =>
		row({
			sourceType: "Architect Chat",
			metadataUpdatedAt: new Date("2026-09-22T10:00:00Z"),
			metadataUpdatedByUserId: "user-1",
		}),
	);
});

describe("normalizeContextMetadataValue", () => {
	it("trims, and stores blank as null", () => {
		expect(normalizeContextMetadataValue("  Client Chat  ")).toBe(
			"Client Chat",
		);
		expect(normalizeContextMetadataValue("")).toBeNull();
		expect(normalizeContextMetadataValue("   ")).toBeNull();
		expect(normalizeContextMetadataValue(null)).toBeNull();
		expect(normalizeContextMetadataValue(undefined)).toBeNull();
	});
});

describe("updateContextMetadata — scope", () => {
	it("finds the row under the organization arm and the project", async () => {
		await updateContextMetadata("ctx-1", "proj-1", ORG_TENANT, {
			sourceType: "Architect Chat",
		});

		expect(tx.projectContext.findFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					id: "ctx-1",
					projectId: "proj-1",
					organizationId: "org-1",
				},
			}),
		);
	});

	it("uses the exclusive null arm, never an OR, without an organization", async () => {
		await updateContextMetadata(
			"ctx-1",
			"proj-1",
			{ userId: "user-1", organizationId: null },
			{ sourceType: "Architect Chat" },
		);

		expect(tx.projectContext.findFirst.mock.calls[0][0].where).toEqual({
			id: "ctx-1",
			projectId: "proj-1",
			organizationId: null,
			userId: "user-1",
		});
	});

	it("reports not-found and writes nothing for a row outside the scope", async () => {
		tx.projectContext.findFirst.mockResolvedValue(null);

		const result = await updateContextMetadata(
			"ctx-other",
			"proj-1",
			ORG_TENANT,
			{ sourceType: "Architect Chat" },
			{ expected: { sourceType: null, aiInstructions: null } },
		);

		expect(result).toEqual({ status: "not-found" });
		expect(tx.projectContext.updateMany).not.toHaveBeenCalled();
	});
});

describe("updateContextMetadata — compare-and-swap", () => {
	it("refuses a stale expected value and writes nothing", async () => {
		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ sourceType: "Architect Chat" },
			{ expected: { sourceType: "QA Thread", aiInstructions: null } },
		);

		expect(result.status).toBe("stale");
		expect(result.status === "stale" && result.current.sourceType).toBe(
			"Client Chat",
		);
		expect(tx.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("writes and stamps who and when when expected matches", async () => {
		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ sourceType: "Architect Chat" },
			{ expected: { sourceType: "Client Chat", aiInstructions: null } },
		);

		expect(tx.projectContext.updateMany).toHaveBeenCalledTimes(1);
		const call = tx.projectContext.updateMany.mock.calls[0][0];
		// Keyed on the values read, so a concurrent save cannot be overwritten.
		expect(call.where).toEqual({
			id: "ctx-1",
			projectId: "proj-1",
			organizationId: "org-1",
			sourceType: "Client Chat",
			aiInstructions: null,
		});
		expect(call.data).toEqual({
			sourceType: "Architect Chat",
			metadataUpdatedAt: expect.any(Date),
			metadataUpdatedByUserId: "user-1",
		});
		expect(result).toMatchObject({
			status: "updated",
			before: { sourceType: "Client Chat", aiInstructions: null },
			after: { sourceType: "Architect Chat", aiInstructions: null },
			changed: ["sourceType"],
			context: { metadataUpdatedByUserId: "user-1" },
		});
	});

	it("compares after normalisation, so a stored blank matches an expected null", async () => {
		tx.projectContext.findFirst.mockResolvedValue(
			row({ sourceType: "  Client Chat ", aiInstructions: "" }),
		);

		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ aiInstructions: "Use as the source of truth." },
			{ expected: { sourceType: "Client Chat", aiInstructions: null } },
		);

		expect(result.status).toBe("updated");
		// The CAS still keys on the raw stored bytes.
		expect(
			tx.projectContext.updateMany.mock.calls[0][0].where,
		).toMatchObject({ sourceType: "  Client Chat ", aiInstructions: "" });
	});

	it("skips the comparison when no expected is given (compatibility path)", async () => {
		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ sourceType: "Architect Chat" },
		);

		expect(result.status).toBe("updated");
		expect(tx.projectContext.updateMany).toHaveBeenCalledTimes(1);
	});

	it("reports stale, with the winner's values, when a concurrent save lands first", async () => {
		tx.projectContext.updateMany.mockResolvedValue({ count: 0 });
		tx.projectContext.findFirst
			.mockResolvedValueOnce(row())
			.mockResolvedValueOnce(row({ sourceType: "SDK Docs" }));

		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ sourceType: "Architect Chat" },
			{ expected: { sourceType: "Client Chat", aiInstructions: null } },
		);

		expect(result.status).toBe("stale");
		expect(result.status === "stale" && result.current.sourceType).toBe(
			"SDK Docs",
		);
		expect(tx.projectContext.findFirstOrThrow).not.toHaveBeenCalled();
	});
});

describe("updateContextMetadata — patch semantics", () => {
	it("stores a blank value as null", async () => {
		tx.projectContext.findFirst.mockResolvedValue(
			row({ aiInstructions: "Old guidance" }),
		);

		await updateContextMetadata("ctx-1", "proj-1", ORG_TENANT, {
			aiInstructions: "   ",
		});

		expect(
			tx.projectContext.updateMany.mock.calls[0][0].data,
		).toMatchObject({ aiInstructions: null });
	});

	it("maps null to a clear and leaves an undefined field untouched", async () => {
		await updateContextMetadata("ctx-1", "proj-1", ORG_TENANT, {
			sourceType: null,
		});

		const data = tx.projectContext.updateMany.mock.calls[0][0].data;
		expect(data.sourceType).toBeNull();
		expect(data).not.toHaveProperty("aiInstructions");
	});

	it("writes and stamps nothing when the values are already stored", async () => {
		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ sourceType: " Client Chat ", aiInstructions: "" },
			{ expected: { sourceType: "Client Chat", aiInstructions: null } },
		);

		expect(result.status).toBe("unchanged");
		expect(tx.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("treats a retry whose values already landed as done, not as a conflict", async () => {
		// The first attempt wrote "Architect Chat" but its response was lost;
		// the caller retries with the `expected` it read before that write.
		tx.projectContext.findFirst.mockResolvedValue(
			row({ sourceType: "Architect Chat" }),
		);

		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{ sourceType: "Architect Chat" },
			{ expected: { sourceType: "Client Chat", aiInstructions: null } },
		);

		expect(result.status).toBe("unchanged");
		expect(tx.projectContext.updateMany).not.toHaveBeenCalled();
	});

	it("writes nothing when no field is supplied", async () => {
		const result = await updateContextMetadata(
			"ctx-1",
			"proj-1",
			ORG_TENANT,
			{},
		);

		expect(result.status).toBe("unchanged");
		expect(tx.projectContext.updateMany).not.toHaveBeenCalled();
	});
});
