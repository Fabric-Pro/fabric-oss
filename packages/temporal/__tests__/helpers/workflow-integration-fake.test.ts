/**
 * Fidelity of the in-memory WorkflowIntegration fake against Prisma's `where`
 * semantics. Prisma drops a key whose value is `undefined`, so a lookup that
 * passes `userId: undefined` matches ANY member's row in production; the fake
 * must do the same, or a test would pass on exactly the regression it exists
 * to catch.
 */

import { describe, expect, it } from "vitest";
import {
	connectionRow,
	createWorkflowIntegrationFake,
} from "./workflow-integration-fake";

const rows = [
	connectionRow({ id: "wi-teammate", userId: "user-1", provider: "GITHUB" }),
	connectionRow({ id: "wi-caller", userId: "user-2", provider: "GITHUB" }),
];

describe("workflow-integration fake: Prisma where semantics", () => {
	it("ignores a key whose value is undefined (matches any member's row)", async () => {
		const fake = createWorkflowIntegrationFake(rows);

		await expect(
			fake.findFirst({
				where: { organizationId: "org-example", userId: undefined },
			}),
		).resolves.toMatchObject({ id: "wi-teammate" });
		await expect(
			fake.findMany({
				where: { organizationId: "org-example", userId: undefined },
			}),
		).resolves.toHaveLength(2);
	});

	it("still filters on a defined userId", async () => {
		const fake = createWorkflowIntegrationFake(rows);

		await expect(
			fake.findFirst({
				where: { organizationId: "org-example", userId: "user-2" },
			}),
		).resolves.toMatchObject({ id: "wi-caller" });
	});
});
