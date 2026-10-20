import { beforeEach, expect, it, vi } from "vitest";

const tx = vi.hoisted(() => ({
	userStory: { updateMany: vi.fn() },
	testCase: { updateMany: vi.fn() },
	pmTicketMissingStreak: { deleteMany: vi.fn() },
	pendingPmStateChange: { updateMany: vi.fn() },
}));
vi.mock("../prisma/client", () => ({
	db: { $transaction: vi.fn(async (fn) => fn(tx)) },
}));

import { applyPmLink } from "../prisma/queries/apply-pm-link";

beforeEach(() => {
	vi.clearAllMocks();
	tx.userStory.updateMany.mockResolvedValue({ count: 1 });
	tx.testCase.updateMany.mockResolvedValue({ count: 1 });
});
it.each([{ storyId: "example-story" }, { testCaseId: "example-case" }])(
	"writes the target with the server stamp",
	async (row) => {
		await applyPmLink({
			...row,
			projectId: "example-project",
			expectedPmCreateClaimId: null,
			externalId: "123",
			externalUrl: "https://pm.example.com/123",
			externalMcpServerId: "example-server",
			externalPmTarget: "example-target",
		});
		const model = "storyId" in row ? tx.userStory : tx.testCase;
		expect(model.updateMany.mock.calls[0][0].data).toMatchObject({
			externalMcpServerId: "example-server",
			externalPmTarget: "example-target",
		});
	},
);
