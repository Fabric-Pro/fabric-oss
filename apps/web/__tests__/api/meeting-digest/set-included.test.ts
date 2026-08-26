import { beforeEach, describe, expect, it, vi } from "vitest";

const { updateMany, recordAudit } = vi.hoisted(() => ({
	updateMany: vi.fn(),
	recordAudit: vi.fn(),
}));

vi.mock("@repo/database", async (importOriginal) => {
	const actual = await importOriginal();
	return {
		...actual,
		db: {
			...actual.db,
			projectLinkedMeeting: { updateMany },
		},
	};
});
vi.mock("@repo/api/lib/audit", () => ({
	recordAuditFromRequest: recordAudit,
}));

import { applyInclusion } from "@repo/api/modules/projects/procedures/meeting-digest/set-included";

describe("applyInclusion", () => {
	beforeEach(() => vi.clearAllMocks());

	it("updates the scoped linked meeting and returns the new flag", async () => {
		updateMany.mockResolvedValue({ count: 1 });
		const result = await applyInclusion({
			projectId: "pr1",
			linkedMeetingId: "lm1",
			included: false,
		});
		expect(updateMany).toHaveBeenCalledWith({
			where: { id: "lm1", projectId: "pr1" },
			data: { includedInDigest: false },
		});
		expect(result).toEqual({ success: true, includedInDigest: false });
	});

	it("throws NOT_FOUND when nothing was updated", async () => {
		updateMany.mockResolvedValue({ count: 0 });
		await expect(
			applyInclusion({
				projectId: "pr1",
				linkedMeetingId: "nope",
				included: true,
			}),
		).rejects.toThrow();
	});
});
