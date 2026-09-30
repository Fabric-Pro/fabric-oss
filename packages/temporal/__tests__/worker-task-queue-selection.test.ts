/**
 * Which task queues one worker process polls (Fizzy #2730): the allowlist the
 * dedicated heavy-work copy uses, the denylist the general copy uses, and the
 * mistakes that must stop the process at boot rather than leave a queue
 * unpolled or polled twice.
 *
 * Run with: pnpm --filter @repo/temporal test worker-task-queue-selection
 */

import { describe, expect, it } from "vitest";
import {
	selectTaskQueues,
	WORKER_EXCLUDED_TASK_QUEUES_ENV,
	WORKER_TASK_QUEUES_ENV,
} from "../src/lib/worker-task-queue-selection";

const KNOWN = ["ai-chat", "fabric-worker", "code-indexing", "atlas"] as const;

describe("selectTaskQueues", () => {
	it("polls every queue when neither variable is set", () => {
		expect(selectTaskQueues(KNOWN, {})).toEqual([...KNOWN]);
	});

	it("treats a blank variable as unset", () => {
		expect(
			selectTaskQueues(KNOWN, {
				[WORKER_TASK_QUEUES_ENV]: "  ",
				[WORKER_EXCLUDED_TASK_QUEUES_ENV]: "",
			}),
		).toEqual([...KNOWN]);
	});

	it("polls only the allowlisted queues, in declaration order", () => {
		expect(
			selectTaskQueues(KNOWN, {
				[WORKER_TASK_QUEUES_ENV]: " atlas , code-indexing ,",
			}),
		).toEqual(["code-indexing", "atlas"]);
	});

	it("polls everything except the denylisted queues", () => {
		expect(
			selectTaskQueues(KNOWN, {
				[WORKER_EXCLUDED_TASK_QUEUES_ENV]: "atlas,code-indexing",
			}),
		).toEqual(["ai-chat", "fabric-worker"]);
	});

	it("gives the two copies disjoint queues that together cover every queue", () => {
		const heavy = selectTaskQueues(KNOWN, {
			[WORKER_TASK_QUEUES_ENV]: "atlas,code-indexing",
		});
		const general = selectTaskQueues(KNOWN, {
			[WORKER_EXCLUDED_TASK_QUEUES_ENV]: "atlas,code-indexing",
		});
		expect(heavy.filter((queue) => general.includes(queue))).toEqual([]);
		expect(new Set([...heavy, ...general])).toEqual(new Set(KNOWN));
	});

	it("refuses both variables at once", () => {
		expect(() =>
			selectTaskQueues(KNOWN, {
				[WORKER_TASK_QUEUES_ENV]: "atlas",
				[WORKER_EXCLUDED_TASK_QUEUES_ENV]: "atlas",
			}),
		).toThrow(/both set/);
	});

	it.each([[WORKER_TASK_QUEUES_ENV], [WORKER_EXCLUDED_TASK_QUEUES_ENV]])(
		"refuses an unknown queue name in %s",
		(variable) => {
			expect(() =>
				selectTaskQueues(KNOWN, { [variable]: "atlas,code-indexng" }),
			).toThrow(`${variable} names unknown task queue(s): code-indexng`);
		},
	);

	it("refuses a denylist that leaves nothing to poll", () => {
		expect(() =>
			selectTaskQueues(KNOWN, {
				[WORKER_EXCLUDED_TASK_QUEUES_ENV]: KNOWN.join(","),
			}),
		).toThrow(/no task queue to poll/);
	});

	it("refuses an allowlist of only separators", () => {
		expect(() =>
			selectTaskQueues(KNOWN, { [WORKER_TASK_QUEUES_ENV]: " , " }),
		).toThrow(/no task queue to poll/);
	});
});
