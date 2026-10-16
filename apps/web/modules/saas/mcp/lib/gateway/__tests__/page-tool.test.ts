/**
 * How a page tool is built: `pageTool` is the one place a handler's arguments
 * are parsed, its page opened as the caller, its rate limit applied and the
 * store's refusals turned into results, so no handler can leave a step out.
 *
 * What these cases pin is the order (a call that fails a step never reaches a
 * later one, so a bad call costs no page lookup and a call for a page the
 * caller cannot open spends none of their rate limit) and the shape of every
 * refusal, which always carries a `reason`.
 *
 * Run with: pnpm --filter web test modules/saas/mcp/lib/gateway/__tests__/page-tool
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	class PageRecordBusyError extends Error {}
	class PageRecordInputError extends Error {
		readonly problem = "key_too_long";
	}
	return {
		PageRecordBusyError,
		PageRecordInputError,
		getAccessibleFrameById: vi.fn(),
		checkRateLimit: vi.fn(),
	};
});

vi.mock("@repo/database", () => ({
	PageRecordBusyError: mocks.PageRecordBusyError,
	PageRecordInputError: mocks.PageRecordInputError,
	PageRecordLimitError: class extends Error {},
	PageRecordVersionConflictError: class extends Error {},
	getAccessibleFrameById: mocks.getAccessibleFrameById,
}));

vi.mock("@repo/api/lib/rate-limit", () => ({
	checkRateLimit: mocks.checkRateLimit,
}));

import { jsonResult } from "../tool-results";
import { clampLimit } from "../tools/frame-context";
import { noInput, pageTool, refuse } from "../tools/page-store";
import type { GatewaySession } from "../types";

const session: GatewaySession = {
	sessionId: "sess-1",
	userId: "viewer-1",
	organizationId: "org-1",
	projectId: null,
	userName: "Ada Lovelace",
	email: "ada@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01T00:00:00Z"),
	expiresAt: new Date("2026-01-02T00:00:00Z"),
};

const payload = (result: { content: Array<{ text: string }> }) =>
	JSON.parse(result.content[0].text);

beforeEach(() => {
	vi.clearAllMocks();
	mocks.getAccessibleFrameById.mockResolvedValue({
		id: "frame-1",
		userId: "owner-1",
		runtimeTools: ["fabric_page_data_get"],
	});
	mocks.checkRateLimit.mockResolvedValue({
		allowed: true,
		remaining: 5,
		resetInSeconds: 30,
	});
});

describe("pageTool", () => {
	it("hands the handler the arguments it parsed, the page it opened as the caller and the caller", async () => {
		const run = vi.fn().mockResolvedValue(jsonResult({ done: true }));
		const handler = pageTool(
			{ parse: (args) => ({ ok: true, value: String(args.word) }) },
			run,
		);

		await handler({ frameId: "frame-1", word: "hi" }, session);

		expect(mocks.getAccessibleFrameById).toHaveBeenCalledWith({
			id: "frame-1",
			userId: "viewer-1",
			userEmail: "ada@example.com",
			organizationId: "org-1",
		});
		expect(run).toHaveBeenCalledWith({
			args: { frameId: "frame-1", word: "hi" },
			input: "hi",
			page: {
				frameId: "frame-1",
				organizationId: "org-1",
				ownerUserId: "owner-1",
				projectId: undefined,
				isOwner: false,
				runtimeTools: ["fabric_page_data_get"],
			},
			session,
		});
	});

	it("answers arguments it refuses with the refusal, opening no page and spending no rate limit", async () => {
		const run = vi.fn();
		const handler = pageTool(
			{
				rate: "write",
				parse: () => refuse("word", "`word` is required."),
			},
			run,
		);

		const result = await handler({ frameId: "frame-1" }, session);

		expect(payload(result)).toEqual({
			error: "`word` is required.",
			reason: "word",
		});
		expect(result.isError).toBe(true);
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("answers a page the caller cannot open as not found, spending no rate limit", async () => {
		mocks.getAccessibleFrameById.mockResolvedValue(null);
		const run = vi.fn();

		const result = await pageTool({ rate: "write", parse: noInput }, run)(
			{ frameId: "frame-1" },
			session,
		);

		expect(payload(result)).toEqual({
			error: "Frame not found.",
			reason: "page_not_found",
		});
		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
		expect(run).not.toHaveBeenCalled();
	});

	it("asks for a page when none is named and none is open", async () => {
		const result = await pageTool({ parse: noInput }, vi.fn())({}, session);

		expect(payload(result)).toMatchObject({ reason: "no_page" });
		expect(mocks.getAccessibleFrameById).not.toHaveBeenCalled();
	});

	it.each([
		["write", 120],
		["ask", 10],
	] as const)(
		"holds a %s tool to %i a minute for this viewer on this page",
		async (rate, perMinute) => {
			await pageTool({ rate, parse: noInput }, async () =>
				jsonResult({}),
			)({ frameId: "frame-1" }, session);

			expect(mocks.checkRateLimit).toHaveBeenCalledWith(
				`page-${rate}:frame-1:viewer-1`,
				perMinute,
				60_000,
			);
		},
	);

	it("holds a tool with no rate to none", async () => {
		await pageTool({ parse: noInput }, async () => jsonResult({}))(
			{ frameId: "frame-1" },
			session,
		);

		expect(mocks.checkRateLimit).not.toHaveBeenCalled();
	});

	it("runs nothing for a viewer over the limit, and says when to try again", async () => {
		mocks.checkRateLimit.mockResolvedValue({
			allowed: false,
			remaining: 0,
			resetInSeconds: 12,
		});
		const run = vi.fn();

		const result = await pageTool({ rate: "write", parse: noInput }, run)(
			{ frameId: "frame-1" },
			session,
		);

		expect(payload(result)).toMatchObject({
			reason: "rate_limited",
			retryAfterSeconds: 12,
		});
		expect(run).not.toHaveBeenCalled();
	});

	it("turns the store's refusals into results a caller can act on, and lets any other error through", async () => {
		const busy = pageTool({ parse: noInput }, async () => {
			throw new mocks.PageRecordBusyError("busy");
		});
		const input = pageTool({ parse: noInput }, async () => {
			throw new mocks.PageRecordInputError("too long");
		});
		const broken = pageTool({ parse: noInput }, async () => {
			throw new Error("database unavailable");
		});

		expect(
			payload(await busy({ frameId: "frame-1" }, session)),
		).toMatchObject({ reason: "busy", retryable: true });
		expect(
			payload(await input({ frameId: "frame-1" }, session)),
		).toMatchObject({ reason: "key_too_long" });
		await expect(broken({ frameId: "frame-1" }, session)).rejects.toThrow(
			"database unavailable",
		);
	});
});

describe("clampLimit", () => {
	const limits = { fallback: 50, max: 200 };

	it.each([
		[undefined, 50],
		[null, 50],
		["10", 50],
		[Number.NaN, 50],
		[Number.POSITIVE_INFINITY, 50],
		[0, 1],
		[-5, 1],
		[7.9, 7],
		[200, 200],
		[5000, 200],
	])("answers %s with %i", (value, expected) => {
		expect(clampLimit(value, limits)).toBe(expected);
	});
});
