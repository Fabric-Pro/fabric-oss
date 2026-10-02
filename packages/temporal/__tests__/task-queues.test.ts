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
	COMPANY_CONTEXT_TASK_QUEUE,
	CONTEXT_SYNC_ACTIVITY_TASK_QUEUE,
	GLOSSY_EDITION_TASK_QUEUE,
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

describe("GLOSSY_EDITION_TASK_QUEUE", () => {
	it("names the queue the Glossy edition worker polls", () => {
		// worker.ts creates that worker with this constant, and the build
		// procedure starts glossyEditionBuildWorkflow on it; API tests mock
		// @repo/temporal, so the literal is pinned here.
		expect(GLOSSY_EDITION_TASK_QUEUE).toBe("glossy-edition");
	});
});

describe("COMPANY_CONTEXT_TASK_QUEUE", () => {
	it("names the queue the company context worker polls, apart from every project queue", () => {
		// worker.ts creates that worker with this constant, and every company
		// context start goes there (`contextOwnerTaskQueue`); API tests mock
		// @repo/temporal, so the literal is pinned here.
		expect(COMPANY_CONTEXT_TASK_QUEUE).toBe("company-context");
		for (const projectQueue of [
			"project-documents",
			"document-processing",
			"fabric-worker",
		]) {
			expect(COMPANY_CONTEXT_TASK_QUEUE).not.toBe(projectQueue);
		}
	});
});
