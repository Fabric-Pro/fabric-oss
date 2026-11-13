import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	conversation: vi.fn(),
	member: vi.fn(),
	turn: vi.fn(),
	list: vi.fn(),
	read: vi.fn(),
	transaction: vi.fn(),
	info: vi.fn(),
	warn: vi.fn(),
}));
vi.mock("@repo/database/prisma/queries/verify-organization-membership", () => ({
	isOrganizationMember: mocks.member,
}));
vi.mock("@repo/database/prisma/client", () => ({
	db: { $transaction: mocks.transaction },
}));
vi.mock(
	"@repo/database/prisma/queries/advisor-tool-results",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@repo/database/prisma/queries/advisor-tool-results")
		>()),
		advisorToolResultStorage: {
			list: mocks.list,
			read: mocks.read,
			readTransaction: (
				await importOriginal<
					typeof import("@repo/database/prisma/queries/advisor-tool-results")
				>()
			).advisorToolResultStorage.readTransaction,
		},
	}),
);
vi.mock("@repo/logs", () => ({
	logger: { info: mocks.info, warn: mocks.warn },
}));

import { parseResultReadArgs } from "../../workflows/orchestrator/advisor-result-read";
import {
	loadAdvisorStoredResults,
	readAdvisorStoredResult,
} from "../advisor-result-reuse";

const tx = {
	agentConversation: { findFirst: mocks.conversation },
	conversationTurn: { findFirst: mocks.turn },
	member: { findFirst: vi.fn() },
	$queryRaw: vi.fn().mockResolvedValue([]),
};
const logKeys = [
	"conversationId",
	"organizationId",
	"outcome",
	"turnId",
	"userId",
];
const scope = {
	userId: "example-user",
	organizationId: "example-org",
	conversationId: "example-chat",
	turnId: "example-turn",
};
const unavailable = '{"v":1,"status":"unavailable"}';
const text = `${"x".repeat(15999)}😀${'a😀\n"'.repeat(9000)}`;
beforeEach(() => {
	vi.resetAllMocks();
	mocks.transaction.mockImplementation((read) => read(tx));
	tx.$queryRaw.mockResolvedValue([]);
	mocks.conversation.mockResolvedValue({ id: scope.conversationId });
	mocks.member.mockResolvedValue(true);
	mocks.turn.mockResolvedValue({ generation: 2 });
	mocks.list.mockResolvedValue([
		{
			id: "example-row",
			toolName: "code_tree",
			createdAt: new Date("2026-01-01"),
			sizeBytes: Buffer.byteLength(text),
			excerpt: text.slice(0, 200),
			valid: true,
		},
	]);
	mocks.read.mockResolvedValue({
		toolName: "code_tree",
		content: { v: 1, text },
	});
});
describe("stored Advisor result access at activity time", () => {
	it("lists and pages the persisted text without writing it back", async () => {
		expect(await loadAdvisorStoredResults(scope)).toEqual([
			{
				ref: "s:example-row",
				tool: "code_tree",
				storedAt: "2026-01-01T00:00:00.000Z",
				sizeBytes: Buffer.byteLength(text),
				excerpt: text.slice(0, 200),
			},
		]);
		let restored = (await loadAdvisorStoredResults(scope))[0].excerpt;
		do {
			const page = JSON.parse(
				await readAdvisorStoredResult({
					...scope,
					args: { ref: "s:example-row", offset: restored.length },
					cap: 32000,
				}),
			);
			expect(page.offset).toBe(restored.length);
			expect(page.text.length).toBeGreaterThan(0);
			restored += page.text;
			expect(page.nextOffset).toBe(
				restored.length < text.length ? restored.length : undefined,
			);
		} while (restored.length < text.length);
		expect(restored).toBe(text);
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
			maxWait: 100,
			timeout: 350,
		});
		expect(mocks.transaction).toHaveBeenCalledWith(expect.any(Function), {
			maxWait: 100,
			timeout: 1300,
		});
		for (const [, client] of [
			...mocks.list.mock.calls,
			...mocks.read.mock.calls,
		]) {
			expect(client).toBe(tx);
		}
		expect(mocks.conversation).toHaveBeenCalledWith({
			where: {
				id: scope.conversationId,
				userId: scope.userId,
				organizationId: scope.organizationId,
			},
			select: { id: true },
		});
		expect(mocks.member).toHaveBeenCalledWith(
			scope.userId,
			scope.organizationId,
			tx,
		);
		expect(mocks.turn).toHaveBeenCalledWith({
			where: {
				id: scope.turnId,
				userId: scope.userId,
				organizationId: scope.organizationId,
				conversationId: scope.conversationId,
			},
			select: { generation: true },
		});
	});
	it.each(["userId", "organizationId", "conversationId", "turnId"] as const)(
		"rejects absent %s",
		async (field) => {
			const input = { ...scope, [field]: "" };
			expect(await loadAdvisorStoredResults(input)).toEqual([]);
			expect(
				await readAdvisorStoredResult({
					...input,
					args: { ref: "s:example-row" },
					cap: 32000,
				}),
			).toBe(unavailable);
			expect(mocks.list).not.toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
			expect(mocks.warn).not.toHaveBeenCalled();
		},
	);
	it.each(["conversation", "member", "turn"] as const)(
		"denies unreadable %s to both readers",
		async (helper) => {
			mocks[helper].mockResolvedValue(null);
			expect(await loadAdvisorStoredResults(scope)).toEqual([]);
			expect(
				await readAdvisorStoredResult({
					...scope,
					args: { ref: "s:example-row" },
					cap: 32000,
				}),
			).toBe(unavailable);
			expect(mocks.list).not.toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
			expect(mocks.warn).not.toHaveBeenCalled();
		},
	);
	it.each(["conversation", "member", "turn", "list", "read"] as const)(
		"catches %s errors without logging content",
		async (helper) => {
			mocks[helper].mockRejectedValue(new Error("SECRET stored content"));
			if (helper !== "read") {
				expect(await loadAdvisorStoredResults(scope)).toEqual([]);
			}
			if (helper !== "list") {
				expect(
					await readAdvisorStoredResult({
						...scope,
						args: { ref: "s:example-row" },
						cap: 32000,
					}),
				).toBe(unavailable);
			}
			for (const [message, payload] of mocks.warn.mock.calls) {
				expect(message).toBe("[AdvisorResultReuse] Read failed");
				expect(Object.keys(payload).sort()).toEqual(logKeys);
				expect(payload).toEqual({ ...scope, outcome: "error" });
			}
			expect(mocks.warn).toHaveBeenCalledTimes(
				helper === "list" || helper === "read" ? 1 : 2,
			);
			expect(
				JSON.stringify([
					...mocks.info.mock.calls,
					...mocks.warn.mock.calls,
				]),
			).not.toContain("SECRET");
		},
	);
	it.each(["list", "read"] as const)(
		"bounds a slow %s without throwing",
		async (helper) => {
			vi.useFakeTimers();
			try {
				tx.$queryRaw.mockReturnValue(new Promise(() => {}));
				const pending =
					helper === "list"
						? loadAdvisorStoredResults(scope)
						: readAdvisorStoredResult({
								...scope,
								args: { ref: "s:example-row" },
								cap: 32000,
							});
				await vi.advanceTimersByTimeAsync(
					helper === "list" ? 350 : 1300,
				);
				expect(await pending).toEqual(
					helper === "list" ? [] : unavailable,
				);
				expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
					"[AdvisorResultReuse] Read timed out",
					{ ...scope, outcome: "timeout" },
				);
				expect(Object.keys(mocks.warn.mock.calls[0][1]).sort()).toEqual(
					logKeys,
				);
			} finally {
				vi.useRealTimers();
			}
		},
	);
	it.each([
		null,
		[],
		{},
		{ ref: "r1" },
		{ ref: "s:" },
		{ ref: "s:a/b" },
		{ ref: `s:${"x".repeat(129)}` },
		{ ref: "s:example-row", userId: "example-forged" },
		{ ref: "s:example-row", offset: -1 },
		{ ref: "s:example-row", offset: 0.5 },
		{ ref: "s:example-row", limit: 0.5 },
	])("rejects malformed model arguments %j before fetching", async (args) => {
		expect(
			await readAdvisorStoredResult({ ...scope, args, cap: 32000 }),
		).toBe(unavailable);
		expect(mocks.read).not.toHaveBeenCalled();
		expect(mocks.warn).not.toHaveBeenCalled();
	});
	it.each([
		null,
		{ toolName: "code_tree", content: { v: 2, text } },
		{ toolName: "code_tree", content: { v: 1, text: 4 } },
	])("denies unknown or unreadable stored content", async (row) => {
		mocks.read.mockResolvedValue(row);
		expect(
			await readAdvisorStoredResult({
				...scope,
				args: { ref: "s:example-row" },
				cap: 32000,
			}),
		).toBe(unavailable);
		expect(mocks.warn).not.toHaveBeenCalled();
	});
	it.each(["userId", "organizationId", "conversationId"] as const)(
		"narrow ownership still denies mismatching %s",
		async (field) => {
			const stored = {
				id: scope.conversationId,
				userId: scope.userId,
				organizationId: scope.organizationId,
			};
			mocks.conversation.mockImplementation(
				async ({ where }: { where: Record<string, unknown> }) =>
					Object.entries(where)
						.filter(([, value]) => value !== undefined)
						.every(
							([key, value]) =>
								stored[key as keyof typeof stored] === value,
						)
						? { id: stored.id }
						: null,
			);
			const input = { ...scope, [field]: "example-other" };
			expect(await loadAdvisorStoredResults(input)).toEqual([]);
			expect(
				await readAdvisorStoredResult({
					...input,
					args: { ref: "s:example-row" },
					cap: 32000,
				}),
			).toBe(unavailable);
			expect(mocks.list).not.toHaveBeenCalled();
			expect(mocks.read).not.toHaveBeenCalled();
		},
	);
	it.each(["list", "page"] as const)(
		"does not return data when %s authorization never resolves or resolves after fallback",
		async (kind) => {
			vi.useFakeTimers();
			try {
				let finish!: (value: { id: string }) => void;
				mocks.conversation.mockReturnValue(
					new Promise((resolve) => {
						finish = resolve;
					}),
				);
				const pending =
					kind === "list"
						? loadAdvisorStoredResults(scope)
						: readAdvisorStoredResult({
								...scope,
								args: { ref: "s:example-row" },
								cap: 32000,
							});
				await vi.advanceTimersByTimeAsync(kind === "list" ? 500 : 1500);
				expect(await pending).toEqual(
					kind === "list" ? [] : unavailable,
				);
				expect(mocks.list).not.toHaveBeenCalled();
				expect(mocks.read).not.toHaveBeenCalled();
				finish({ id: scope.conversationId });
				await vi.advanceTimersByTimeAsync(0);
				expect(await pending).toEqual(
					kind === "list" ? [] : unavailable,
				);
				expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
					"[AdvisorResultReuse] Read timed out",
					{ ...scope, outcome: "timeout" },
				);
			} finally {
				vi.useRealTimers();
			}
		},
	);

	it("rejects an unreadable current-turn generation", async () => {
		mocks.turn.mockResolvedValue({ generation: null });
		expect(await loadAdvisorStoredResults(scope)).toEqual([]);
		expect(
			await readAdvisorStoredResult({
				...scope,
				args: { ref: "s:example-row" },
				cap: 32000,
			}),
		).toBe(unavailable);
		expect(mocks.list).not.toHaveBeenCalled();
		expect(mocks.read).not.toHaveBeenCalled();
	});

	it("returns no partial listing if one row is unreadable", async () => {
		const valid = {
			id: "example-row",
			toolName: "code_tree",
			createdAt: new Date("2026-01-01"),
			sizeBytes: 7,
			excerpt: "example",
			valid: true,
		};
		mocks.list.mockResolvedValue([valid, { ...valid, valid: false }]);
		expect(await loadAdvisorStoredResults(scope)).toEqual([]);
	});
	it("does not split an excerpt surrogate pair", async () => {
		mocks.list.mockResolvedValue([
			{
				id: "example-row",
				toolName: "code_tree",
				createdAt: new Date("2026-01-01"),
				sizeBytes: 203,
				excerpt: `${"x".repeat(199)}😀`,
				valid: true,
			},
		]);
		expect((await loadAdvisorStoredResults(scope))[0].excerpt).toBe(
			"x".repeat(199),
		);
	});
});

describe("shared page argument admission", () => {
	it.each([
		null,
		[],
		Object.assign([], { ref: "s:example-row" }),
		Object.assign(() => {}, { ref: "s:example-row" }),
		{ ref: 42 },
		{ ref: "s:example-row", extra: 1 },
		{ ref: "s:example-row", offset: -1 },
		{ ref: "s:example-row", offset: 0.5 },
		{ ref: "s:example-row", limit: 0.5 },
	])("rejects malformed inputs before dispatch %j", (args) => {
		expect(parseResultReadArgs(args)).toBeUndefined();
	});
});

it.each(["list", "page"] as const)(
	"logs one timeout for the outer %s timer even after a late rejection",
	async (kind) => {
		vi.useFakeTimers();
		try {
			let reject!: (error: Error) => void;
			mocks.transaction.mockReturnValue(
				new Promise((_resolve, fail) => {
					reject = fail;
				}),
			);
			const pending =
				kind === "list"
					? loadAdvisorStoredResults(scope)
					: readAdvisorStoredResult({
							...scope,
							args: { ref: "s:example-row" },
							cap: 32000,
						});
			await vi.advanceTimersByTimeAsync(kind === "list" ? 500 : 1500);
			expect(await pending).toEqual(kind === "list" ? [] : unavailable);
			reject(new Error("example late failure"));
			await vi.advanceTimersByTimeAsync(0);
			expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
				"[AdvisorResultReuse] Read timed out",
				{ ...scope, outcome: "timeout" },
			);
			expect(Object.keys(mocks.warn.mock.calls[0][1]).sort()).toEqual(
				logKeys,
			);
		} finally {
			vi.useRealTimers();
		}
	},
);
it.each(["ADVISOR_RESULT_READ_TIMEOUT", "other", undefined])(
	"classifies only the storage code %s through the real wrapper",
	async (code) => {
		tx.$queryRaw.mockRejectedValueOnce(
			Object.assign(new Error("example"), { code }),
		);
		expect(await loadAdvisorStoredResults(scope)).toEqual([]);
		expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
			code === "ADVISOR_RESULT_READ_TIMEOUT"
				? "[AdvisorResultReuse] Read timed out"
				: "[AdvisorResultReuse] Read failed",
			{
				...scope,
				outcome:
					code === "ADVISOR_RESULT_READ_TIMEOUT"
						? "timeout"
						: "error",
			},
		);
		expect(Object.keys(mocks.warn.mock.calls[0][1]).sort()).toEqual(
			logKeys,
		);
	},
);

it.each([null, undefined, "example", 1, {}])(
	"preserves fallback for an unstructured rejection %j",
	async (error) => {
		tx.$queryRaw.mockRejectedValueOnce(error);
		expect(await loadAdvisorStoredResults(scope)).toEqual([]);
		expect(mocks.warn).toHaveBeenCalledExactlyOnceWith(
			"[AdvisorResultReuse] Read failed",
			{ ...scope, outcome: "error" },
		);
	},
);
