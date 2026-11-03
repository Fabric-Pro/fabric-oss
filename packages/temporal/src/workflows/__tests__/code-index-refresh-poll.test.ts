import { beforeEach, describe, expect, it, vi } from "vitest";

const acts = vi.hoisted(() => ({
	claimDueCodeIndexRefreshesActivity: vi.fn(),
	requestCodeIndexRefreshActivity: vi.fn(),
}));

vi.mock("@temporalio/workflow", () => ({
	proxyActivities: () => acts,
	log: { warn: vi.fn() },
}));

import {
	CODE_INDEX_REFRESH_CLAIM_LIMIT,
	codeIndexRefreshPollWorkflow,
} from "../code-index-refresh-poll";

beforeEach(() => {
	vi.clearAllMocks();
});

describe("codeIndexRefreshPollWorkflow", () => {
	it("checks every claimed index and counts outcomes, a failure never stopping the rest", async () => {
		acts.claimDueCodeIndexRefreshesActivity.mockResolvedValue([
			"i1",
			"i2",
			"i3",
			"i4",
			"i5",
		]);
		acts.requestCodeIndexRefreshActivity.mockImplementation(
			async ({ codeIndexId }: { codeIndexId: string }) => {
				if (codeIndexId === "i2") {
					throw new Error("web app down");
				}
				return {
					outcome: codeIndexId === "i5" ? "started" : "up-to-date",
				};
			},
		);

		const result = await codeIndexRefreshPollWorkflow();

		expect(acts.claimDueCodeIndexRefreshesActivity).toHaveBeenCalledWith({
			limit: CODE_INDEX_REFRESH_CLAIM_LIMIT,
		});
		expect(acts.requestCodeIndexRefreshActivity).toHaveBeenCalledTimes(5);
		expect(result).toEqual({
			claimed: 5,
			outcomes: { "up-to-date": 3, started: 1 },
			failed: 1,
		});
	});

	it("does nothing when no index is due", async () => {
		acts.claimDueCodeIndexRefreshesActivity.mockResolvedValue([]);
		const result = await codeIndexRefreshPollWorkflow();
		expect(acts.requestCodeIndexRefreshActivity).not.toHaveBeenCalled();
		expect(result).toEqual({ claimed: 0, outcomes: {}, failed: 0 });
	});
});
