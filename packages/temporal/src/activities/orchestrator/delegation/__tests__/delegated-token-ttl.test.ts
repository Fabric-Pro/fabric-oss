/**
 * The delegated agent's AI token has to outlive the run it authorises.
 *
 * Tokens default to five minutes. A delegated run is a full agent turn and
 * routinely runs longer, and every call the agent makes after expiry is
 * rejected — including usage logging, which is dropped with no retry. The
 * visible symptom is silently missing billing rows, always undercounting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const info = vi.hoisted(() => ({ startToCloseTimeoutMs: 0, throws: false }));

vi.mock("@temporalio/activity", () => ({
	Context: {
		current: () => {
			if (info.throws) {
				throw new Error("not in an activity context");
			}
			return {
				info: { startToCloseTimeoutMs: info.startToCloseTimeoutMs },
			};
		},
	},
}));

vi.mock("@repo/agent-core", () => ({
	A2AClient: class {},
	SecureA2AClient: class {},
}));
vi.mock("@repo/ai", () => ({
	DEFAULT_BASE_URLS: {},
	GATEWAY_PROVIDERS: [],
	getAIModelWithMetadata: vi.fn(),
}));
vi.mock("@repo/ai-token", () => ({ issueAIToken: vi.fn() }));

import { delegatedTokenTtlSeconds } from "../delegate-to-agent";

beforeEach(() => {
	info.startToCloseTimeoutMs = 0;
	info.throws = false;
});

describe("delegatedTokenTtlSeconds", () => {
	it("outlives the activity that will use it", () => {
		info.startToCloseTimeoutMs = 10 * 60 * 1000;
		// 10 minutes of work plus headroom, comfortably past the 300s default
		// that was expiring mid-run.
		expect(delegatedTokenTtlSeconds()).toBe(10 * 60 + 120);
	});

	it("stays bounded when the activity timeout is very long", () => {
		// The Weave delegation activity allows 120 minutes; the token should
		// not simply inherit that without a ceiling.
		info.startToCloseTimeoutMs = 120 * 60 * 1000;
		expect(delegatedTokenTtlSeconds()).toBe(2 * 60 * 60);
	});

	it("falls back when no activity timeout is available", () => {
		info.startToCloseTimeoutMs = 0;
		expect(delegatedTokenTtlSeconds()).toBe(900);
	});

	it("falls back outside an activity context", () => {
		info.throws = true;
		expect(delegatedTokenTtlSeconds()).toBe(900);
	});

	it("is never shorter than the issuer default it replaces", () => {
		// Deriving from the activity timeout must only ever lengthen the token.
		// A one-minute activity would otherwise come out at 180s — shorter than
		// the 300s it had before this function existed.
		for (const ms of [0, 60_000, 10 * 60_000, 120 * 60_000]) {
			info.startToCloseTimeoutMs = ms;
			expect(delegatedTokenTtlSeconds()).toBeGreaterThanOrEqual(300);
		}
	});

	it("floors a short activity at the issuer default", () => {
		info.startToCloseTimeoutMs = 60_000;
		expect(delegatedTokenTtlSeconds()).toBe(300);
	});
});
