/**
 * Fidelity of the in-memory WorkflowIntegration store against Prisma's `where`
 * semantics. Prisma drops a key whose value is `undefined`, so a lookup that
 * passes `userId: undefined` matches ANY member's row in production; the store
 * must do the same, or a test would pass on exactly the regression it exists
 * to catch.
 */

import { describe, expect, it } from "vitest";
import {
	createWorkflowIntegrationStore,
	type StoredRow,
} from "./workflow-integration-store";

const row = (id: string, userId: string): StoredRow => ({
	id,
	userId,
	organizationId: "org-example",
	provider: "GITHUB",
	name: "GITHUB",
	isActive: true,
	credentials: "{}",
});

function seeded() {
	const store = createWorkflowIntegrationStore();
	store.rows.push(row("wi-teammate", "user-1"), row("wi-caller", "user-2"));
	return store;
}

describe("workflow-integration store: Prisma where semantics", () => {
	it("ignores a key whose value is undefined (matches any member's row)", async () => {
		const { delegate } = seeded();

		await expect(
			delegate.findFirst({
				where: { organizationId: "org-example", userId: undefined },
			}),
		).resolves.toMatchObject({ id: "wi-teammate" });
		await expect(
			delegate.findMany({
				where: { organizationId: "org-example", userId: undefined },
			}),
		).resolves.toHaveLength(2);
	});

	it("still filters on a defined userId", async () => {
		const { delegate } = seeded();

		await expect(
			delegate.findFirst({
				where: { organizationId: "org-example", userId: "user-2" },
			}),
		).resolves.toMatchObject({ id: "wi-caller" });
	});
});
