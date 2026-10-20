/**
 * `getWorkflowStats` counts a workflow as active when it is live: PUBLISHED, or
 * ACTIVE from before publishing had its own status. A published workflow used
 * to fall into the remainder and be reported as archived.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const workflowCountMock = vi.fn();

vi.mock("../prisma/client", () => ({
	db: {
		workflow: { count: (args: unknown) => workflowCountMock(args) },
	},
}));

import { getWorkflowStats } from "../prisma/queries/workflows/workflows";

type CountArgs = { where: { status?: unknown } };

beforeEach(() => {
	workflowCountMock.mockReset();
});

describe("getWorkflowStats", () => {
	it("asks for the live workflows under active, both statuses", async () => {
		workflowCountMock.mockResolvedValue(0);

		await getWorkflowStats("user-1", "org-1");

		const statuses = workflowCountMock.mock.calls.map(
			([args]) => (args as CountArgs).where.status,
		);
		expect(statuses).toContainEqual({ in: ["PUBLISHED", "ACTIVE"] });
	});

	it("does not report a published workflow as archived", async () => {
		workflowCountMock.mockImplementation(async ({ where }: CountArgs) => {
			if (where.status === undefined) {
				return 3;
			}
			if (
				typeof where.status === "object" &&
				where.status !== null &&
				"in" in where.status
			) {
				return 1;
			}
			return 1;
		});

		const stats = await getWorkflowStats("user-1", "org-1");

		expect(stats).toEqual({
			total: 3,
			active: 1,
			draft: 1,
			paused: 1,
			archived: 0,
		});
	});
});
