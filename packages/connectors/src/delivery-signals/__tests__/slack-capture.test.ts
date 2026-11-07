import { afterEach, describe, expect, it, vi } from "vitest";
import {
	DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES,
	DELIVERY_SOURCE_CAPTURE_PAGE_SIZE,
} from "../capture-limits";
import {
	qualifySlackDeliverySource,
	readExactSlackDeliveryMessage,
	readSlackDeliveryPage,
	SlackDeliveryCaptureError,
	type SlackDeliveryPageInput,
} from "../slack-capture";

const input: SlackDeliveryPageInput = {
	botToken: "xoxb-example-secret",
	userToken: "xoxp-example-secret",
	expectedTeamId: "TEXAMPLE",
	channelId: "CEXAMPLE",
	expectedHumanUserId: "UEXAMPLE",
	expectedBotId: "BEXAMPLE",
	oldest: "1730000000.000000",
	latest: "1730086400.000000",
};
function channel() {
	return {
		id: input.channelId,
		context_team_id: input.expectedTeamId,
		is_channel: true,
		is_private: false,
		is_im: false,
		is_mpim: false,
		is_member: true,
		is_shared: false,
		is_ext_shared: false,
		is_org_shared: false,
		is_pending_ext_shared: false,
		is_archived: false,
	};
}
function message(overrides: Record<string, unknown> = {}) {
	return {
		type: "message",
		ts: "1730000100.000001",
		text: "Example untrusted source text.",
		user: "UOTHER",
		...overrides,
	};
}
function history(
	messages: unknown[] = [message()],
	overrides: Record<string, unknown> = {},
) {
	return {
		ok: true,
		messages,
		has_more: false,
		response_metadata: { next_cursor: "" },
		...overrides,
	};
}
function protocol(
	overrides: {
		human?: Record<string, unknown>;
		bot?: Record<string, unknown>;
		channel?: Record<string, unknown>;
		rosters?: unknown[];
		history?: unknown;
	} = {},
) {
	const replies: unknown[] = [
		{
			ok: true,
			team_id: "TEXAMPLE",
			user_id: "UEXAMPLE",
			...overrides.human,
		},
		{
			ok: true,
			team_id: "TEXAMPLE",
			user_id: "UBOT",
			bot_id: "BEXAMPLE",
			...overrides.bot,
		},
		{ ok: true, channel: { ...channel(), ...overrides.channel } },
		...(overrides.rosters ?? [
			{
				ok: true,
				members: ["UEXAMPLE", "UOTHER"],
				response_metadata: { next_cursor: "" },
			},
		]),
		overrides.history ?? history(),
	];
	const fetcher = vi.fn<typeof fetch>(async () => {
		const reply = replies.shift();
		if (reply instanceof Response) {
			return reply;
		}
		if (reply === undefined) {
			throw new Error("Unexpected protocol request");
		}
		return new Response(JSON.stringify(reply), {
			headers: { "content-type": "application/json" },
		});
	});
	return { fetcher, replies };
}
async function expectError(promise: Promise<unknown>, code: string) {
	try {
		await promise;
		throw new Error("Expected source refusal");
	} catch (error) {
		expect(error).toBeInstanceOf(SlackDeliveryCaptureError);
		expect(error).toHaveProperty("code", code);
		expect(String(error)).not.toMatch(
			/xox[bp]-|private-provider-error|CEXAMPLE|UEXAMPLE/,
		);
	}
}
afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

describe("current owner-only Slack source proof", () => {
	it("uses only fixed Slack read methods, exact paired credentials and a bounded history probe", async () => {
		const { fetcher } = protocol();
		const result = await qualifySlackDeliverySource(input, {
			fetch: fetcher,
		});
		expect(result).toEqual({
			teamId: "TEXAMPLE",
			channelId: "CEXAMPLE",
			humanUserId: "UEXAMPLE",
			botId: "BEXAMPLE",
			botUserId: "UBOT",
		});
		expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
			"https://slack.com/api/auth.test",
			"https://slack.com/api/auth.test",
			"https://slack.com/api/conversations.info",
			"https://slack.com/api/conversations.members",
			"https://slack.com/api/conversations.history",
		]);
		for (const [index, [, options]] of fetcher.mock.calls.entries()) {
			expect(options?.method).toBe("POST");
			expect(options?.redirect).toBe("error");
			expect(options?.signal).toBeInstanceOf(AbortSignal);
			expect(
				(options?.headers as Record<string, string>).Authorization,
			).toBe(`Bearer ${index === 0 ? input.userToken : input.botToken}`);
		}
		const probe = new URLSearchParams(
			fetcher.mock.calls[4][1]?.body as string,
		);
		expect(probe.get("channel")).toBe(input.channelId);
		expect(probe.get("limit")).toBe("1");
		expect(
			BigInt(probe.get("latest") ?? "") -
				BigInt(probe.get("oldest") ?? ""),
		).toBe(BigInt(604800));
		expect(JSON.stringify(result)).not.toMatch(
			/xox[bp]-|Example untrusted/,
		);
	});
	it("allows enrollment to derive live principals without client email mapping", async () => {
		const { fetcher } = protocol();
		const result = await qualifySlackDeliverySource(
			{
				botToken: input.botToken,
				userToken: input.userToken,
				expectedTeamId: input.expectedTeamId,
				channelId: input.channelId,
			},
			{ fetch: fetcher },
		);
		expect(result.humanUserId).toBe("UEXAMPLE");
	});
	it("returns an optional bounded authorized channel label without using it as identity", async () => {
		const { fetcher } = protocol({ channel: { name: "example-channel" } });
		const proof = await qualifySlackDeliverySource(input, {
			fetch: fetcher,
		});
		expect(proof.channelName).toBe("example-channel");
		expect(proof.channelId).toBe(input.channelId);
	});
	it.each([
		"",
		"   ",
		" example-channel",
		"x".repeat(81),
		"example\nprivate",
		null,
	])(
		"omits an unproven display label %# without changing source identity",
		async (name) => {
			const { fetcher } = protocol({ channel: { name } });
			const proof = await qualifySlackDeliverySource(input, {
				fetch: fetcher,
			});
			expect(proof).not.toHaveProperty("channelName");
			expect(proof.channelId).toBe(input.channelId);
		},
	);
	it.each([
		{ human: { bot_id: "BBAD" } },
		{ human: { bot_id: null } },
		{ human: { user_id: "UOTHER" } },
		{ human: { team_id: "TOTHER" } },
		{ human: { enterprise_id: "EEXAMPLE" } },
		{ bot: { team_id: "TOTHER" } },
		{ bot: { user_id: "UEXAMPLE" } },
		{ bot: { bot_id: "BOTHER" } },
		{ bot: { bot_id: undefined } },
		{ bot: { is_enterprise_install: true } },
	])(
		"refuses principal/workspace/bot/enterprise mismatch %#",
		async (changes) => {
			const { fetcher } = protocol(changes);
			await expectError(
				qualifySlackDeliverySource(input, { fetch: fetcher }),
				"SLACK_DELIVERY_ACCESS_DENIED",
			);
			expect(
				fetcher.mock.calls.some(([url]) =>
					String(url).endsWith("conversations.history"),
				),
			).toBe(false);
		},
	);
	it.each([
		{ id: "COTHER" },
		{ context_team_id: "TOTHER" },
		{ is_channel: false },
		{ is_member: false },
		{ is_im: true },
		{ is_mpim: true },
		{ is_shared: true },
		{ is_ext_shared: true },
		{ is_org_shared: true },
		{ is_pending_ext_shared: true },
		{ is_private: undefined },
		{ is_archived: true },
		{ is_ext_shared: undefined },
	])(
		"refuses unsupported or unproven channel metadata %#",
		async (changes) => {
			const { fetcher } = protocol({ channel: changes });
			await expectError(
				readSlackDeliveryPage(input, { fetch: fetcher }),
				"SLACK_DELIVERY_ACCESS_DENIED",
			);
			expect(fetcher).toHaveBeenCalledTimes(3);
		},
	);
	it("requires membership for a public channel and does not substitute bot reachability", async () => {
		const { fetcher } = protocol({
			rosters: [
				{
					ok: true,
					members: ["UBOT", "UOTHER"],
					response_metadata: { next_cursor: "" },
				},
			],
		});
		await expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_ACCESS_DENIED",
		);
		expect(fetcher).toHaveBeenCalledTimes(4);
	});
	it("follows short roster pages to completion even when the owner was found early", async () => {
		const { fetcher } = protocol({
			rosters: [
				{
					ok: true,
					members: ["UEXAMPLE"],
					response_metadata: { next_cursor: "example-next==" },
				},
				{
					ok: true,
					members: [],
					response_metadata: { next_cursor: "" },
				},
			],
		});
		await readSlackDeliveryPage(input, { fetch: fetcher });
		expect(
			new URLSearchParams(fetcher.mock.calls[4][1]?.body as string).get(
				"cursor",
			),
		).toBe("example-next==");
		expect(fetcher).toHaveBeenCalledTimes(6);
	});
	it("fails closed when the complete roster exceeds its page/request budget", async () => {
		const { fetcher } = protocol({
			rosters: Array.from({ length: 5 }, (_, i) => ({
				ok: true,
				members: ["UEXAMPLE"],
				response_metadata: { next_cursor: `example-next-${i}` },
			})),
		});
		await expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
		expect(fetcher).toHaveBeenCalledTimes(8);
	});
	it("uses at most nine requests for a complete five-page roster and history read", async () => {
		const { fetcher } = protocol({
			rosters: Array.from({ length: 5 }, (_, i) => ({
				ok: true,
				members: i === 4 ? ["UEXAMPLE"] : [],
				response_metadata: {
					next_cursor: i === 4 ? "" : `example-next-${i}`,
				},
			})),
		});
		expect(
			(await readSlackDeliveryPage(input, { fetch: fetcher })).messages,
		).toHaveLength(1);
		expect(fetcher).toHaveBeenCalledTimes(9);
	});
	it.each(
		[
			[{ ok: true, members: ["UEXAMPLE"], response_metadata: {} }],
			[
				{
					ok: true,
					members: "UEXAMPLE",
					response_metadata: { next_cursor: "" },
				},
			],
			[
				{
					ok: true,
					members: ["UEXAMPLE"],
					response_metadata: {
						next_cursor: "https://example.com/private",
					},
				},
			],
			Array.from({ length: 2 }, () => ({
				ok: true,
				members: ["UEXAMPLE"],
				response_metadata: { next_cursor: "example-repeat" },
			})),
		].map((rosters) => ({ rosters })),
	)(
		"refuses malformed/incomplete or cyclic roster protocol %#",
		async ({ rosters }) => {
			const { fetcher } = protocol({ rosters });
			await expectError(
				readSlackDeliveryPage(input, { fetch: fetcher }),
				"SLACK_DELIVERY_RESPONSE_INVALID",
			);
		},
	);
	it("repeats the live source proof on every call and refuses revoked membership", async () => {
		const { fetcher } = protocol();
		await readSlackDeliveryPage(input, { fetch: fetcher });
		const revoked = protocol({
			rosters: [
				{
					ok: true,
					members: [],
					response_metadata: { next_cursor: "" },
				},
			],
		});
		await expectError(
			readSlackDeliveryPage(input, { fetch: revoked.fetcher }),
			"SLACK_DELIVERY_ACCESS_DENIED",
		);
		expect(revoked.fetcher.mock.calls[0][0]).toBe(
			"https://slack.com/api/auth.test",
		);
	});
});

describe("bounded selected Slack root messages", () => {
	it("selects immutable plain text metadata and exact edited decimal revisions without float loss", async () => {
		const { fetcher } = protocol({
			history: history([
				message({
					edited: { ts: "1730000100.000002", user: "UOTHER" },
					reply_count: 3,
					credentials: "private-provider-error",
					permalink: "https://example.com/private",
					blocks: [],
				}),
			]),
		});
		const page = await readSlackDeliveryPage(input, { fetch: fetcher });
		expect(page.messages).toEqual([
			{
				externalItemId: "1730000100.000001",
				revision: { kind: "DECIMAL", value: "1730000100.000002" },
				text: "Example untrusted source text.",
				occurredAt: "2024-10-27T03:35:00.000Z",
				hasReplies: true,
			},
		]);
		expect(page.coverage).toBe("ROOT_MESSAGES_ONLY");
		expect(page.limitations).toEqual([
			"TEXT_ONLY",
			"THREAD_REPLIES_NOT_CAPTURED",
		]);
		expect(JSON.stringify(page)).not.toMatch(
			/private-provider-error|example.com|xox[bp]-/,
		);
		const body = new URLSearchParams(
			fetcher.mock.calls[4][1]?.body as string,
		);
		expect(Object.fromEntries(body)).toEqual({
			channel: "CEXAMPLE",
			oldest: input.oldest,
			latest: input.latest,
			inclusive: "true",
			limit: "50",
		});
	});
	it("keeps root-only coverage explicit while omitting replies and its own bot output", async () => {
		const { fetcher } = protocol({
			history: history([
				message(),
				message({
					ts: "1730000101.000001",
					thread_ts: "1730000100.000001",
				}),
				message({
					ts: "1730000102.000001",
					bot_id: "BEXAMPLE",
					subtype: "bot_message",
				}),
			]),
		});
		const page = await readSlackDeliveryPage(input, { fetch: fetcher });
		expect(page.messages).toHaveLength(1);
		expect(page.coverage).toBe("ROOT_MESSAGES_ONLY");
	});
	it("accepts the current full page and rejects any provider response above its shared bound", async () => {
		const messages = Array.from(
			{ length: DELIVERY_SOURCE_CAPTURE_PAGE_SIZE },
			(_, index) =>
				message({ ts: `1730000100.${String(index).padStart(6, "0")}` }),
		);
		const full = protocol({ history: history(messages) });
		expect(
			(await readSlackDeliveryPage(input, { fetch: full.fetcher }))
				.messages,
		).toHaveLength(DELIVERY_SOURCE_CAPTURE_PAGE_SIZE);
		const body = new URLSearchParams(
			full.fetcher.mock.calls[4][1]?.body as string,
		);
		expect(body.get("limit")).toBe(
			String(DELIVERY_SOURCE_CAPTURE_PAGE_SIZE),
		);
		const excessive = protocol({
			history: history([...messages, message()]),
		});
		await expect(
			readSlackDeliveryPage(input, { fetch: excessive.fetcher }),
		).rejects.toMatchObject({ code: "SLACK_DELIVERY_RESPONSE_INVALID" });
	});
	it("accepts worst-escaped text at the exact shared byte limit and excludes one extra byte", async () => {
		const text = `${"\u0000".repeat(DELIVERY_SOURCE_CAPTURE_MAX_TEXT_BYTES - 1)}x`;
		const allowed = protocol({ history: history([message({ text })]) });
		expect(
			(await readSlackDeliveryPage(input, { fetch: allowed.fetcher }))
				.messages[0]?.text,
		).toBe(text);
		const oversized = protocol({
			history: history([message({ text: `${text}x` })]),
		});
		const result = await readSlackDeliveryPage(input, {
			fetch: oversized.fetcher,
		});
		expect(result.messages).toEqual([]);
		expect(result.partialReasons).toContain("OVERSIZED_TEXT");
	});
	it.each([
		[{ subtype: "message_deleted" }, "UNSUPPORTED_SUBTYPE"],
		[{ subtype: "message_changed" }, "UNSUPPORTED_SUBTYPE"],
		[
			{
				files: [
					{
						id: "FEXAMPLE",
						url_private: "https://example.com/private",
					},
				],
			},
			"UNSUPPORTED_CONTENT",
		],
		[{ attachments: [{}] }, "UNSUPPORTED_CONTENT"],
		[{ text: "😀".repeat(4097) }, "OVERSIZED_TEXT"],
		[{ text: "x".repeat(16385) }, "OVERSIZED_TEXT"],
		[{ edited: { ts: "1730000099.999999" } }, "INVALID_MESSAGE"],
		[{ ts: "not-a-timestamp" }, "INVALID_MESSAGE"],
		[{ ts: "1730999999.000000" }, "INVALID_MESSAGE"],
		[{ channel: "COTHER" }, "INVALID_MESSAGE"],
		[{ team: "TOTHER" }, "INVALID_MESSAGE"],
		[{ bot_id: "BOTHER" }, "UNSUPPORTED_BOT_MESSAGE"],
	])(
		"marks unsupported or malformed evidence partial without exposing it %#",
		async (changes, reason) => {
			const { fetcher } = protocol({
				history: history([message(changes as Record<string, unknown>)]),
			});
			const page = await readSlackDeliveryPage(input, { fetch: fetcher });
			expect(page.coverage).toBe("PARTIAL");
			expect(page.messages).toEqual([]);
			expect(page.partialReasons).toContain(reason);
		},
	);
	it("accepts exactly the UTF-8 text cap and keeps source prose untrusted", async () => {
		const text = "😀".repeat(4096);
		const { fetcher } = protocol({ history: history([message({ text })]) });
		expect(
			(await readSlackDeliveryPage(input, { fetch: fetcher })).messages[0]
				.text,
		).toBe(text);
	});
	it("preserves an opaque provider cursor only as a form field under exact selectors", async () => {
		const { fetcher } = protocol({
			history: history(undefined, {
				has_more: true,
				response_metadata: { next_cursor: "ZXhhbXBsZQ==" },
			}),
		});
		const page = await readSlackDeliveryPage(
			{ ...input, cursor: "previous+/==" },
			{ fetch: fetcher },
		);
		expect(page.nextCursor).toBe("ZXhhbXBsZQ==");
		expect(page.hasMore).toBe(true);
		expect(
			new URLSearchParams(fetcher.mock.calls[4][1]?.body as string).get(
				"cursor",
			),
		).toBe("previous+/==");
		expect(fetcher.mock.calls[4][0]).toBe(
			"https://slack.com/api/conversations.history",
		);
	});
	it("does not claim a complete page when Slack reports more without a usable cursor", async () => {
		const { fetcher } = protocol({
			history: history(undefined, { has_more: true }),
		});
		const page = await readSlackDeliveryPage(input, { fetch: fetcher });
		expect(page.coverage).toBe("PARTIAL");
		expect(page.partialReasons).toContain("PAGINATION_UNAVAILABLE");
	});
	it("refuses a provider page exceeding the requested fifty-message bound", async () => {
		const { fetcher } = protocol({
			history: history(Array.from({ length: 51 }, () => message())),
		});
		await expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_RESPONSE_INVALID",
		);
	});
	it.each([
		{ oldest: "1730000000.000000", latest: "1730604800.000001" },
		{ oldest: "1730000000.000000", latest: "1730000000.000000" },
		{ oldest: "1e9" },
		{ cursor: "https://example.com/private" },
		{ channelId: "CEXAMPLE&channel=COTHER" },
		{ expectedTeamId: "TEXAMPLE\n" },
		{ expectedHumanUserId: undefined },
		{ expectedBotId: undefined },
		{ userToken: "" },
		{ botToken: input.userToken },
	])(
		"rejects invalid selectors/window/pins before provider I/O %#",
		async (changes) => {
			const { fetcher } = protocol();
			await expectError(
				readSlackDeliveryPage(
					{ ...input, ...changes } as SlackDeliveryPageInput,
					{ fetch: fetcher },
				),
				"INVALID_SLACK_DELIVERY_INPUT",
			);
			expect(fetcher).not.toHaveBeenCalled();
		},
	);
	it("revalidates an exact root using exact timestamp bounds and never infers deletion from absence", async () => {
		const { fetcher } = protocol();
		const result = await readExactSlackDeliveryMessage(
			{ ...input, messageTs: "1730000100.000001" },
			{ fetch: fetcher },
		);
		expect(result.message.externalItemId).toBe("1730000100.000001");
		expect(
			Object.fromEntries(
				new URLSearchParams(fetcher.mock.calls[4][1]?.body as string),
			),
		).toEqual({
			channel: input.channelId,
			oldest: "1730000100.000001",
			latest: "1730000100.000001",
			inclusive: "true",
			limit: "1",
		});
		const absent = protocol({ history: history([]) });
		await expectError(
			readExactSlackDeliveryMessage(
				{ ...input, messageTs: "1730000100.000001" },
				{ fetch: absent.fetcher },
			),
			"SLACK_DELIVERY_MESSAGE_UNAVAILABLE",
		);
	});
	it("refuses an exact unsupported message rather than presenting a partial body as evidence", async () => {
		const { fetcher } = protocol({
			history: history([message({ files: [{}] })]),
		});
		await expectError(
			readExactSlackDeliveryMessage(
				{ ...input, messageTs: "1730000100.000001" },
				{ fetch: fetcher },
			),
			"SLACK_DELIVERY_MESSAGE_UNAVAILABLE",
		);
	});
});

describe("network and response budgets", () => {
	it.each([
		[
			new Response("private-provider-error", { status: 429 }),
			"SLACK_DELIVERY_RATE_LIMITED",
		],
		[
			new Response("private-provider-error", { status: 503 }),
			"SLACK_DELIVERY_UNAVAILABLE",
		],
		[
			new Response(JSON.stringify({ ok: false, error: "token_revoked" })),
			"SLACK_DELIVERY_ACCESS_DENIED",
		],
		[
			new Response(JSON.stringify({ ok: false, error: "missing_scope" })),
			"SLACK_DELIVERY_ACCESS_DENIED",
		],
		[
			new Response(
				JSON.stringify({ ok: false, error: "private-provider-error" }),
			),
			"SLACK_DELIVERY_UNAVAILABLE",
		],
		[
			new Response("not-json-private-provider-error"),
			"SLACK_DELIVERY_RESPONSE_INVALID",
		],
	])(
		"sanitizes provider failures without retries, provider prose or credential leaks %#",
		async (response, code) => {
			const fetcher = vi.fn<typeof fetch>(
				async () => response as Response,
			);
			await expectError(
				readSlackDeliveryPage(input, { fetch: fetcher }),
				code as string,
			);
			expect(fetcher).toHaveBeenCalledTimes(1);
		},
	);
	it("rejects oversized declared responses before reading their bodies", async () => {
		const response = new Response("", {
			headers: { "content-length": "1048577" },
		});
		const fetcher = vi.fn<typeof fetch>(async () => response);
		await expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
	});
	it("bounds actual streamed bytes without trusting content-length and cancels the stream", async () => {
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			pull(controller) {
				controller.enqueue(new Uint8Array(65_536));
			},
			cancel() {
				cancelled = true;
			},
		});
		const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
		await expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
		expect(cancelled).toBe(true);
	});
	it("enforces one aggregate byte budget across identity and source responses", async () => {
		const { fetcher } = protocol({
			human: { padding: "x".repeat(600_000) },
			bot: { padding: "x".repeat(600_000) },
		});
		await expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it("enforces the total deadline even when an injected transport ignores its AbortSignal", async () => {
		vi.useFakeTimers();
		const fetcher = vi.fn<typeof fetch>(() => new Promise(() => {}));
		const result = expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
		await vi.advanceTimersByTimeAsync(15_001);
		await result;
	});
	it("applies the same deadline to a stalled response body and cancels it", async () => {
		vi.useFakeTimers();
		let cancelled = false;
		const body = new ReadableStream<Uint8Array>({
			cancel() {
				cancelled = true;
			},
		});
		const fetcher = vi.fn<typeof fetch>(async () => new Response(body));
		const result = expectError(
			readSlackDeliveryPage(input, { fetch: fetcher }),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
		await vi.advanceTimersByTimeAsync(15_001);
		await result;
		expect(cancelled).toBe(true);
	});
	it("does no I/O for an already aborted operation", async () => {
		const controller = new AbortController();
		controller.abort();
		const { fetcher } = protocol();
		await expectError(
			readSlackDeliveryPage(input, {
				fetch: fetcher,
				signal: controller.signal,
			}),
			"SLACK_DELIVERY_BUDGET_EXCEEDED",
		);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it("defaults to global fetch while keeping the provider host fixed", async () => {
		const { fetcher } = protocol();
		vi.stubGlobal("fetch", fetcher);
		await readSlackDeliveryPage(input);
		expect(
			fetcher.mock.calls.every(([url]) =>
				String(url).startsWith("https://slack.com/api/"),
			),
		).toBe(true);
	});
});
