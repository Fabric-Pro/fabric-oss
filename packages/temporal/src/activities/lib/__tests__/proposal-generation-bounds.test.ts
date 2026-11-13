/**
 * The first-chunk allowance of a coordinated Proposal's agent stream: a run
 * allowed to research gets its research time on top, an operator's override
 * still wins, and the wall cap is untouched.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../activity-logger", () => ({
	activityLogger: {
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

import { ProposalStreamLimits } from "../proposal-generation-bounds";

const MINUTE = 60_000;
const ENV_NAMES = [
	"AGENT_STREAM_TIMEOUT_MS",
	"AGENT_STREAM_FIRST_CHUNK_TIMEOUT_MS",
	"AGENT_STREAM_IDLE_TIMEOUT_MS",
] as const;
const savedEnv = Object.fromEntries(
	ENV_NAMES.map((name) => [name, process.env[name]]),
);

/** Limits for an attempt whose deadline leaves a long wall cap. */
function limits(options?: { extraFirstChunkMs?: number }) {
	const budget = {
		deadline: new Date(Date.now() + 60 * MINUTE),
		fallbackReserveMs: 5 * MINUTE,
	};
	const created = new ProposalStreamLimits(
		budget,
		() => {},
		{ documentId: "doc-1" },
		options,
	);
	return created;
}

beforeEach(() => {
	for (const name of ENV_NAMES) {
		delete process.env[name];
	}
});

afterEach(() => {
	vi.useRealTimers();
	for (const [name, value] of Object.entries(savedEnv)) {
		if (value === undefined) {
			delete process.env[name];
		} else {
			process.env[name] = value;
		}
	}
});

describe("ProposalStreamLimits — the first-chunk allowance", () => {
	it("is today's five minutes without options", () => {
		const created = limits();
		expect(created.limitMs("first-chunk")).toBe(5 * MINUTE);
		created.dispose();
	});

	it("adds the research time a run allowed to research is given", () => {
		const created = limits({ extraFirstChunkMs: 325_000 });
		expect(created.limitMs("first-chunk")).toBe(625_000);
		created.dispose();
	});

	it("ignores an extra that is not a positive number", () => {
		for (const extraFirstChunkMs of [0, -1, Number.NaN]) {
			const created = limits({ extraFirstChunkMs });
			expect(created.limitMs("first-chunk")).toBe(5 * MINUTE);
			created.dispose();
		}
	});

	it("lets an operator's override win over the extra", () => {
		process.env.AGENT_STREAM_FIRST_CHUNK_TIMEOUT_MS = "120000";
		const created = limits({ extraFirstChunkMs: 325_000 });
		expect(created.limitMs("first-chunk")).toBe(120_000);
		created.dispose();
	});

	it("leaves the wall cap as the deadline leaves it", () => {
		const plain = limits();
		const research = limits({ extraFirstChunkMs: 325_000 });
		expect(research.limitMs("wall")).toBe(plain.limitMs("wall"));
		plain.dispose();
		research.dispose();
	});

	it("cuts a silent stream at the longer allowance, not at five minutes", async () => {
		vi.useFakeTimers();
		const onCut = vi.fn();
		const created = new ProposalStreamLimits(
			{
				deadline: new Date(Date.now() + 60 * MINUTE),
				fallbackReserveMs: 5 * MINUTE,
			},
			onCut,
			{ documentId: "doc-1" },
			{ extraFirstChunkMs: 325_000 },
		);

		await vi.advanceTimersByTimeAsync(5 * MINUTE);
		expect(onCut).not.toHaveBeenCalled();
		expect(created.cutReason).toBeUndefined();
		await vi.advanceTimersByTimeAsync(325_000);
		expect(onCut).toHaveBeenCalledTimes(1);
		await expect(created.cut).resolves.toBe("first-chunk");
		created.dispose();
	});
});
