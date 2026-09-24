/**
 * The orchestrator queue name is shared between the worker and every
 * starter. API-side tests mock `@repo/temporal` and therefore cannot see the
 * real value, so this is where the literal the worker actually polls is
 * pinned.
 *
 * Run with: pnpm --filter @repo/temporal test -- task-queues
 */

import { describe, expect, it } from "vitest";
import {
	CONTEXT_SYNC_ACTIVITY_TASK_QUEUE,
	ORCHESTRATOR_TASK_QUEUE,
} from "../src/task-queues";

describe("ORCHESTRATOR_TASK_QUEUE", () => {
	it("names the queue the orchestrator worker polls", () => {
		expect(ORCHESTRATOR_TASK_QUEUE).toBe("fabric-orchestrator");
	});
});

describe("CONTEXT_SYNC_ACTIVITY_TASK_QUEUE", () => {
	it("names the general-purpose queue the fabric-worker worker polls", () => {
		// worker.ts creates that worker with the literal "fabric-worker".
		expect(CONTEXT_SYNC_ACTIVITY_TASK_QUEUE).toBe("fabric-worker");
	});
});
