import { FabricToolError } from "@saas/mcp/lib/fabric-tool-client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FRAME_RUNTIME_CALL_TIMEOUT_MS } from "../frame-embed-protocol";
import {
	createFrameRuntimeHost,
	FRAME_RUNTIME_MAX_PROMPT_LENGTH,
	FRAME_RUNTIME_RATE_LIMIT,
	type FrameRuntimeHostOptions,
	resolveAppPath,
} from "../frame-runtime-host";
import { createPageTaint } from "../page-approval-rules";

const mocks = {
	loadToolInfo: vi.fn(),
	callTool: vi.fn(),
	confirmTool: vi.fn(),
	confirmDownload: vi.fn(),
	saveDownload: vi.fn(),
	openAgent: vi.fn(),
	navigate: vi.fn(),
};

let clock = 0;

afterEach(() => vi.useRealTimers());

function host(overrides: Partial<FrameRuntimeHostOptions> = {}) {
	return createFrameRuntimeHost({
		runtimeTools: ["fabric_list_workflows", "fabric_execute_workflow"],
		frameId: "frame-1",
		taint: createPageTaint(),
		organizationId: "org-a",
		viewingOrganizationId: () => "org-a",
		now: () => clock,
		...mocks,
		...overrides,
	});
}

const call = (name: string, args: Record<string, unknown> = {}, id = "r1") =>
	({
		type: "fabric-frame:call",
		requestId: id,
		name,
		args,
	}) as const;

beforeEach(() => {
	vi.resetAllMocks();
	clock = 1_000_000;
	mocks.loadToolInfo.mockResolvedValue(
		new Map([
			["fabric_list_workflows", { readOnlyHint: true }],
			["fabric_execute_workflow", {}],
		]),
	);
	mocks.callTool.mockResolvedValue({ ok: "result" });
	mocks.confirmTool.mockResolvedValue(true);
});

describe("a call from the page", () => {
	it("settles cancellation while metadata is unresolved and never dispatches when it later arrives", async () => {
		let resolveMetadata!: (
			value: ReadonlyMap<string, { readOnlyHint: boolean }>,
		) => void;
		mocks.loadToolInfo.mockReturnValue(
			new Promise((resolve) => {
				resolveMetadata = resolve;
			}),
		);
		const controller = new AbortController();
		const result = host().handleCall(call("fabric_list_workflows"), {
			signal: controller.signal,
		});
		controller.abort();
		await expect(result).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("cancelled"),
		});
		resolveMetadata(
			new Map([["fabric_list_workflows", { readOnlyHint: true }]]),
		);
		await Promise.resolve();
		expect(mocks.confirmTool).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it.each([undefined, 10_000_000])(
		"caps metadata waits at five minutes for expiry %s",
		async (expiresAt) => {
			vi.useFakeTimers();
			mocks.loadToolInfo.mockReturnValue(new Promise(() => {}));
			const result = host().handleCall({
				...call("fabric_list_workflows"),
				expiresAt,
			});
			await vi.advanceTimersByTimeAsync(FRAME_RUNTIME_CALL_TIMEOUT_MS);
			await expect(result).resolves.toMatchObject({
				ok: false,
				error: expect.stringContaining("expired"),
			});
			expect(mocks.callTool).not.toHaveBeenCalled();
			expect(vi.getTimerCount()).toBe(0);
		},
	);

	it("checks the wall clock after metadata even if the timer is delayed", async () => {
		mocks.loadToolInfo.mockImplementation(async () => {
			clock += FRAME_RUNTIME_CALL_TIMEOUT_MS;
			return new Map([["fabric_list_workflows", { readOnlyHint: true }]]);
		});
		await expect(
			host().handleCall(call("fabric_list_workflows")),
		).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("expired"),
		});
		expect(mocks.confirmTool).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("checks the wall clock after consent before dispatch", async () => {
		mocks.confirmTool.mockImplementation(async () => {
			clock += FRAME_RUNTIME_CALL_TIMEOUT_MS;
			return true;
		});
		await expect(
			host().handleCall(call("fabric_execute_workflow")),
		).resolves.toMatchObject({
			ok: false,
			error: expect.stringContaining("expired"),
		});
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("does not describe cancellation after dispatch as a rollback", async () => {
		let finish!: (value: unknown) => void;
		mocks.callTool.mockReturnValue(
			new Promise((resolve) => {
				finish = resolve;
			}),
		);
		const controller = new AbortController();
		const result = host().handleCall(call("fabric_list_workflows"), {
			signal: controller.signal,
		});
		await Promise.resolve();
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
		controller.abort();
		await expect(result).resolves.toMatchObject({
			ok: false,
			error: "This Fabric call expired or was cancelled.",
		});
		finish({ alreadyDispatched: true });
		await Promise.resolve();
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
	});

	it.each([
		"fabric_page_configure_story_review",
		"fabric_page_run_story_review",
	])(
		"asks on every %s call and derives its own Workspace ID",
		async (name) => {
			mocks.loadToolInfo.mockResolvedValue(
				new Map([
					[name, { readOnlyHint: false, confirm: "always" as const }],
				]),
			);
			const page = host({ runtimeTools: [name] });
			const input = {
				workflowId: "workflow-1",
				frameId: "foreign-frame",
			};
			await page.handleCall(call(name, input));
			await page.handleCall(call(name, input, "r2"));
			expect(
				mocks.confirmTool.mock.calls.map((entry) => entry[2]),
			).toEqual([
				{ every: true, because: "confirm" },
				{ every: true, because: "tainted" },
			]);
			expect(mocks.callTool).toHaveBeenCalledWith(name, {
				workflowId: "workflow-1",
				frameId: "frame-1",
			});
		},
	);

	it("runs a declared read-only tool at once, as the viewer, and answers with its result", async () => {
		const answer = await host().handleCall(
			call("fabric_list_workflows", { limit: 3 }),
		);

		expect(mocks.callTool).toHaveBeenCalledWith("fabric_list_workflows", {
			limit: 3,
		});
		expect(mocks.confirmTool).not.toHaveBeenCalled();
		expect(answer).toEqual({
			type: "fabric-frame:call-result",
			requestId: "r1",
			ok: true,
			result: { ok: "result" },
		});
	});

	it("refuses a tool the page did not declare, without reading the tool list or calling anything", async () => {
		const answer = await host().handleCall(call("fabric_get_frame"));

		expect(answer).toMatchObject({ ok: false, requestId: "r1" });
		expect(answer.ok === false && answer.error).toContain(
			"fabric_get_frame",
		);
		expect(mocks.loadToolInfo).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it.each([
		"fabric_switch_organization",
		"fabric_request_authority",
		"fabric_revoke_authority",
		"fabric_share_frame",
		"fabric_create_workflow",
		"fabric_update_workflow",
		"fabric_publish_workflow",
		"fabric_create_frame",
		"fabric_update_frame",
		"fabric_edit_frame_block",
		"fabric_create_slideshow",
		"fabric_get_identity",
		"fabric_list_organizations",
		"fabric_restore_frame_version",
		"fabric_duplicate_frame",
		"fabric_page_comment_add",
	])("refuses %s even when a stored page declares it", async (name) => {
		mocks.loadToolInfo.mockResolvedValue(new Map([[name, {}]]));

		const answer = await host({ runtimeTools: [name] }).handleCall(
			call(name, { anything: 1 }),
		);

		expect(answer).toMatchObject({ ok: false, requestId: "r1" });
		expect(answer.ok === false && answer.error).toContain(
			"not available to pages",
		);
		expect(mocks.loadToolInfo).not.toHaveBeenCalled();
		expect(mocks.confirmTool).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("refuses everything when the page declared nothing", async () => {
		const answer = await host({ runtimeTools: [] }).handleCall(
			call("fabric_list_workflows"),
		);

		expect(answer.ok).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("asks the viewer before a tool that is not read-only, and runs it on a yes", async () => {
		const answer = await host().handleCall(
			call("fabric_execute_workflow", { workflowId: "w1" }),
		);

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_execute_workflow",
			{ workflowId: "w1" },
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
		expect(mocks.callTool).toHaveBeenCalledWith("fabric_execute_workflow", {
			workflowId: "w1",
		});
		expect(answer.ok).toBe(true);
	});

	it("does not run a tool the viewer declined", async () => {
		mocks.confirmTool.mockResolvedValue(false);

		const answer = await host().handleCall(call("fabric_execute_workflow"));

		expect(mocks.callTool).not.toHaveBeenCalled();
		expect(answer).toMatchObject({ ok: false });
		expect(answer.ok === false && answer.error).toContain(
			"did not allow fabric_execute_workflow",
		);
	});

	it("treats a tool the list does not mention as one that needs the viewer's yes", async () => {
		mocks.loadToolInfo.mockResolvedValue(new Map());

		await host().handleCall(call("fabric_list_workflows"));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_list_workflows",
			{},
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it("does not take a read-only hint as proof for a tool that says otherwise", async () => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([["fabric_execute_workflow", { readOnlyHint: false }]]),
		);

		await host().handleCall(call("fabric_execute_workflow"));

		expect(mocks.confirmTool).toHaveBeenCalledTimes(1);
	});

	it("asks on every call to a tool whose definition says to, a read included, and names why", async () => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				[
					"fabric_list_workflows",
					{ readOnlyHint: true, confirm: "always" as const },
				],
			]),
		);

		await host().handleCall(call("fabric_list_workflows", { limit: 1 }));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_list_workflows",
			{ limit: 1 },
			{ every: true, because: "confirm", readOnly: true },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
	});

	it("asks every time only when the argument a tool's definition names is given", async () => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				[
					"fabric_execute_workflow",
					{ confirm: { whenArgumentPresent: "runtimeTools" } },
				],
			]),
		);

		await host().handleCall(call("fabric_execute_workflow", {}));
		await host().handleCall(
			call("fabric_execute_workflow", { runtimeTools: ["a"] }),
		);

		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: false },
			{ every: true, because: "confirm" },
		]);
	});

	it("runs nothing when the viewer does not allow a tool that always asks", async () => {
		mocks.confirmTool.mockResolvedValue(false);
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				["fabric_execute_workflow", { confirm: "always" as const }],
			]),
		);

		const answer = await host().handleCall(call("fabric_execute_workflow"));

		expect(answer.ok).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("answers with the reason when the tool fails", async () => {
		mocks.callTool.mockRejectedValue(new Error("Workflow not found"));

		const answer = await host().handleCall(call("fabric_list_workflows"));

		expect(answer).toEqual({
			type: "fabric-frame:call-result",
			requestId: "r1",
			ok: false,
			error: "Workflow not found",
		});
	});

	it("answers when the tool list cannot be read, and runs nothing", async () => {
		mocks.loadToolInfo.mockRejectedValue(new Error("offline"));

		const answer = await host().handleCall(call("fabric_list_workflows"));

		expect(answer).toMatchObject({ ok: false, error: "offline" });
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("keeps each answer under the request id it was asked with", async () => {
		const [first, second] = await Promise.all([
			host().handleCall(call("fabric_list_workflows", {}, "a")),
			host().handleCall(call("fabric_get_frame", {}, "b")),
		]);

		expect(first).toMatchObject({ requestId: "a", ok: true });
		expect(second).toMatchObject({ requestId: "b", ok: false });
	});
});

describe("the organization of a call", () => {
	it("refuses a page of another organization than the one the viewer is looking at, calling nothing", async () => {
		const answer = await host({
			organizationId: "org-a",
			viewingOrganizationId: () => "org-b",
		}).handleCall(call("fabric_list_workflows"));

		expect(answer).toMatchObject({ ok: false, requestId: "r1" });
		expect(answer.ok === false && answer.error).toContain(
			"does not belong to the organization you are viewing",
		);
		expect(mocks.loadToolInfo).not.toHaveBeenCalled();
		expect(mocks.confirmTool).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("refuses when either organization is not known", async () => {
		const unknownPage = await host({ organizationId: null }).handleCall(
			call("fabric_list_workflows"),
		);
		const unknownView = await host({
			viewingOrganizationId: () => null,
		}).handleCall(call("fabric_list_workflows", {}, "r2"));
		const neither = await host({
			organizationId: null,
			viewingOrganizationId: () => null,
		}).handleCall(call("fabric_list_workflows", {}, "r3"));

		expect(unknownPage.ok).toBe(false);
		expect(unknownView.ok).toBe(false);
		expect(neither.ok).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("reads the organization being viewed at each call, so a switch in between is seen", async () => {
		let viewing = "org-a";
		const page = host({ viewingOrganizationId: () => viewing });

		const first = await page.handleCall(call("fabric_list_workflows"));
		viewing = "org-b";
		const second = await page.handleCall(
			call("fabric_list_workflows", {}, "r2"),
		);

		expect(first.ok).toBe(true);
		expect(second.ok).toBe(false);
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
	});
});

describe("the rate limit", () => {
	it("allows the limit within a minute and refuses the next call, whatever its tool", async () => {
		const runtime = host();
		for (
			let index = 0;
			index < FRAME_RUNTIME_RATE_LIMIT.maxCalls;
			index++
		) {
			const answer = await runtime.handleCall(
				call("fabric_list_workflows", {}, `r${index}`),
			);
			expect(answer.ok).toBe(true);
		}

		const over = await runtime.handleCall(call("fabric_list_workflows"));
		expect(over.ok).toBe(false);
		expect(over.ok === false && over.error).toContain("too often");
		expect(mocks.callTool).toHaveBeenCalledTimes(
			FRAME_RUNTIME_RATE_LIMIT.maxCalls,
		);

		const undeclared = await runtime.handleCall(call("fabric_get_frame"));
		expect(undeclared.ok === false && undeclared.error).toContain(
			"too often",
		);
	});

	it("lets calls through again once the minute has passed", async () => {
		const runtime = host();
		for (
			let index = 0;
			index < FRAME_RUNTIME_RATE_LIMIT.maxCalls;
			index++
		) {
			await runtime.handleCall(call("fabric_list_workflows"));
		}

		clock += FRAME_RUNTIME_RATE_LIMIT.windowMs;
		const answer = await runtime.handleCall(call("fabric_list_workflows"));

		expect(answer.ok).toBe(true);
	});

	it("counts per host, so one page's calls do not use up another's", async () => {
		const busy = host();
		for (
			let index = 0;
			index < FRAME_RUNTIME_RATE_LIMIT.maxCalls;
			index++
		) {
			await busy.handleCall(call("fabric_list_workflows"));
		}

		const other = await host().handleCall(call("fabric_list_workflows"));

		expect(other.ok).toBe(true);
	});
});

describe("navigate", () => {
	it.each([
		["/app/acme/projects", "/app/acme/projects"],
		[
			"/app/acme/projects?tab=artifacts",
			"/app/acme/projects?tab=artifacts",
		],
		["/app/acme/workspaces/f1#top", "/app/acme/workspaces/f1#top"],
	])("goes to %s", (path, expected) => {
		host().handleNavigate(path);

		expect(mocks.navigate).toHaveBeenCalledWith(expected);
	});

	it.each([
		["another site", "https://evil.example/app/x"],
		["a protocol-relative address", "//evil.example/app/x"],
		["a path outside the app", "/api/auth/sign-out"],
		["the app root without a segment", "/app"],
		["a path that climbs out of the app", "/app/../api/session"],
		["an encoded climb", "/app/%2e%2e/api/session"],
		["a backslash trick", "/app/\\evil.example"],
		["a script", "javascript:alert(1)"],
		["a relative path", "app/acme"],
		["nothing", ""],
	])("refuses %s", (_label, path) => {
		host().handleNavigate(path);

		expect(mocks.navigate).not.toHaveBeenCalled();
	});

	it("resolves the path it goes to, so what is checked is what is opened", () => {
		expect(resolveAppPath("/app/a/./b")).toBe("/app/a/b");
		expect(resolveAppPath("/app/a/../b")).toBe("/app/b");
		expect(resolveAppPath("/app/a/../../b")).toBeNull();
	});
});

describe("openAgent", () => {
	it("opens Fabric Agent with the prompt as a draft", () => {
		host().handleOpenAgent("  Summarise this week  ");

		expect(mocks.openAgent).toHaveBeenCalledWith("Summarise this week");
	});

	it("ignores an empty prompt", () => {
		host().handleOpenAgent("   ");

		expect(mocks.openAgent).not.toHaveBeenCalled();
	});

	it("cuts a prompt that is far longer than anyone writes", () => {
		host().handleOpenAgent(
			"x".repeat(FRAME_RUNTIME_MAX_PROMPT_LENGTH + 500),
		);

		expect(mocks.openAgent.mock.calls[0][0]).toHaveLength(
			FRAME_RUNTIME_MAX_PROMPT_LENGTH,
		);
	});
});

describe("a tool that refuses", () => {
	function refusal(
		message: string,
		details: { reason?: string; retryable?: boolean },
	) {
		return new FabricToolError(message, "fabric_list_workflows", details);
	}

	it("tells the page the reason it gave and whether to try again", async () => {
		mocks.callTool.mockRejectedValue(
			refusal("The page is busy. Try again in a moment.", {
				reason: "busy",
				retryable: true,
			}),
		);

		const answer = await host().handleCall(call("fabric_list_workflows"));

		expect(answer).toEqual({
			type: "fabric-frame:call-result",
			requestId: "r1",
			ok: false,
			error: "The page is busy. Try again in a moment.",
			reason: "busy",
			retryable: true,
		});
	});

	it.each(["version_conflict", "limit", "rate_limited", "usage_limit"])(
		"passes %s on as it came",
		async (reason) => {
			mocks.callTool.mockRejectedValue(refusal("Refused.", { reason }));

			const answer = await host().handleCall(
				call("fabric_list_workflows"),
			);

			expect(answer).toMatchObject({ ok: false, reason });
			expect(answer).not.toHaveProperty("retryable");
		},
	);

	it("says nothing of a reason when the failure gave none, or was not a tool's refusal", async () => {
		mocks.callTool.mockRejectedValueOnce(new Error("plain"));
		mocks.callTool.mockRejectedValueOnce(
			Object.assign(new Error("not a tool's refusal"), {
				reason: "busy",
				retryable: true,
			}),
		);
		mocks.callTool.mockRejectedValueOnce(refusal("none given", {}));

		const plain = await host().handleCall(call("fabric_list_workflows"));
		const imitation = await host().handleCall(
			call("fabric_list_workflows", {}, "r2"),
		);
		const none = await host().handleCall(
			call("fabric_list_workflows", {}, "r3"),
		);

		for (const answer of [plain, imitation, none]) {
			expect(answer).not.toHaveProperty("reason");
			expect(answer).not.toHaveProperty("retryable");
		}
	});

	it("gives the page no reason for a call the host itself refused", async () => {
		const answer = await host().handleCall(call("fabric_get_frame"));

		expect(answer).toMatchObject({ ok: false });
		expect(answer).not.toHaveProperty("reason");
	});
});

describe("the page's own frame", () => {
	const PAGE_TOOLS = [
		"fabric_page_data_list",
		"fabric_page_data_set",
		"fabric_get_page_viewer",
		"fabric_list_workflows",
	];

	beforeEach(() => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				["fabric_page_data_list", { readOnlyHint: true }],
				["fabric_page_data_set", {}],
				["fabric_get_page_viewer", { readOnlyHint: true }],
				["fabric_list_workflows", { readOnlyHint: true }],
			]),
		);
	});

	it("runs a page tool for the page's own frame, whatever frame the page named", async () => {
		await host({ runtimeTools: PAGE_TOOLS }).handleCall(
			call("fabric_page_data_list", {
				frameId: "somebody-elses-page",
				collection: "votes",
			}),
		);

		expect(mocks.callTool).toHaveBeenCalledWith("fabric_page_data_list", {
			frameId: "frame-1",
			collection: "votes",
		});
	});

	it("gives the page its own frame when it named none", async () => {
		await host({ runtimeTools: PAGE_TOOLS }).handleCall(
			call("fabric_get_page_viewer"),
		);

		expect(mocks.callTool).toHaveBeenCalledWith("fabric_get_page_viewer", {
			frameId: "frame-1",
		});
	});

	it("leaves the arguments of a tool that is not about the page's own data as they were sent", async () => {
		await host({ runtimeTools: PAGE_TOOLS }).handleCall(
			call("fabric_list_workflows", { limit: 3 }),
		);

		expect(mocks.callTool).toHaveBeenCalledWith("fabric_list_workflows", {
			limit: 3,
		});
	});

	it("shows the viewer the call as the page made it", async () => {
		await host({ runtimeTools: PAGE_TOOLS }).handleCall(
			call("fabric_page_data_set", {
				frameId: "somebody-elses-page",
				collection: "votes",
				records: [{ key: "a", value: 1 }],
			}),
		);

		expect(mocks.confirmTool.mock.calls[0][1]).toEqual({
			frameId: "somebody-elses-page",
			collection: "votes",
			records: [{ key: "a", value: 1 }],
		});
		expect(mocks.callTool.mock.calls[0][1]).toMatchObject({
			frameId: "frame-1",
		});
	});

	it("refuses every call while the page has not been saved, asking and running nothing", async () => {
		const answer = await host({
			runtimeTools: PAGE_TOOLS,
			frameId: null,
		}).handleCall(call("fabric_page_data_list", { collection: "votes" }));

		expect(answer).toMatchObject({ ok: false, requestId: "r1" });
		expect(answer.ok === false && answer.error).toContain("not been saved");
		expect(mocks.loadToolInfo).not.toHaveBeenCalled();
		expect(mocks.confirmTool).not.toHaveBeenCalled();
		expect(mocks.callTool).not.toHaveBeenCalled();
	});
});

describe("a read from the viewer's own connected server", () => {
	const READ = {
		provider: "linear",
		tool: "list_issues",
		args: { first: 5 },
	};

	beforeEach(() => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([["fabric_page_read_connected", { readOnlyHint: true }]]),
		);
	});

	it("runs a read the page declared by its server and tool, after asking the viewer once", async () => {
		const answer = await host({
			runtimeTools: ["connected:linear/list_issues"],
		}).handleCall(call("fabric_page_read_connected", READ));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_page_read_connected",
			READ,
			{ every: false, readOnly: true },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
		expect(mocks.callTool).toHaveBeenCalledWith(
			"fabric_page_read_connected",
			{
				...READ,
				frameId: "frame-1",
			},
		);
		expect(answer.ok).toBe(true);
	});

	it("asks even though the tool list calls the tool a read", async () => {
		await host({
			runtimeTools: ["connected:linear/list_issues"],
		}).handleCall(call("fabric_page_read_connected", READ));

		expect(mocks.confirmTool).toHaveBeenCalledTimes(1);
	});

	it("refuses another tool of the same server than the page declared", async () => {
		const answer = await host({
			runtimeTools: ["connected:linear/list_issues"],
		}).handleCall(
			call("fabric_page_read_connected", {
				...READ,
				tool: "delete_issue",
			}),
		);

		expect(answer.ok === false && answer.error).toContain(
			"connected:linear/delete_issue",
		);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("refuses the same tool of another server", async () => {
		const answer = await host({
			runtimeTools: ["connected:linear/list_issues"],
		}).handleCall(
			call("fabric_page_read_connected", { ...READ, provider: "jira" }),
		);

		expect(answer.ok).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("is not covered by declaring the reading tool itself", async () => {
		const answer = await host({
			runtimeTools: ["fabric_page_read_connected"],
		}).handleCall(call("fabric_page_read_connected", READ));

		expect(answer.ok).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});

	it("refuses a read that names no server or tool", async () => {
		const answer = await host({
			runtimeTools: ["connected:linear/list_issues"],
		}).handleCall(
			call("fabric_page_read_connected", { provider: "linear" }),
		);

		expect(answer.ok).toBe(false);
		expect(mocks.callTool).not.toHaveBeenCalled();
	});
});

describe("trusted metadata for sensitive project reads", () => {
	it("passes read-only metadata to consent without reducing per-call approval after taint", async () => {
		const name = "fabric_list_project_pm_members";
		mocks.loadToolInfo.mockResolvedValue(
			new Map([[name, { readOnlyHint: true }]]),
		);
		mocks.confirmTool
			.mockResolvedValueOnce(true)
			.mockResolvedValueOnce(false);
		const page = host({ runtimeTools: [name] });
		const args = { projectId: "project-1", readOnlyHint: false };
		expect((await page.handleCall(call(name, args, "r1"))).ok).toBe(true);
		expect((await page.handleCall(call(name, args, "r2"))).ok).toBe(false);
		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: false, readOnly: true },
			{ every: true, because: "tainted", readOnly: true },
		]);
		expect(mocks.callTool).toHaveBeenCalledTimes(1);
	});
});

describe("a page that has read outside its own data", () => {
	const DECLARED = [
		"fabric_get_page_viewer",
		"fabric_execute_workflow",
		"fabric_create_story",
		"connected:linear/list_issues",
	];

	beforeEach(() => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				["fabric_get_page_viewer", { readOnlyHint: true }],
				["fabric_execute_workflow", {}],
				["fabric_create_story", {}],
				["fabric_page_read_connected", {}],
			]),
		);
	});

	it("asks on every call to change anything, and not only to change the page's shared data, even for a page that keeps none", async () => {
		const page = host({ runtimeTools: DECLARED });
		const story = { title: "Fix the login" };

		await page.handleCall(call("fabric_create_story", story, "r1"));
		await page.handleCall(call("fabric_get_page_viewer", {}, "r2"));
		await page.handleCall(call("fabric_create_story", story, "r3"));
		await page.handleCall(call("fabric_execute_workflow", {}, "r4"));

		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: false },
			{ every: true, because: "tainted" },
			{ every: true, because: "tainted" },
		]);
		expect(mocks.confirmTool.mock.calls[1][1]).toEqual(story);
	});

	it("asks on every read of a connected server once it is tainted, though it asked once before", async () => {
		const page = host({ runtimeTools: DECLARED });
		const read = {
			provider: "linear",
			tool: "list_issues",
			args: {},
		};

		await page.handleCall(call("fabric_page_read_connected", read, "r1"));
		await page.handleCall(call("fabric_page_read_connected", read, "r2"));

		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: false },
			{ every: true, because: "tainted" },
		]);
	});

	it("still runs a plain read at once", async () => {
		const page = host({ runtimeTools: DECLARED });
		await page.handleCall(call("fabric_get_page_viewer", {}, "r1"));

		const again = await page.handleCall(
			call("fabric_get_page_viewer", {}, "r2"),
		);

		expect(again.ok).toBe(true);
		expect(mocks.confirmTool).not.toHaveBeenCalled();
	});
});

describe("when the viewer is asked about a page that keeps data", () => {
	const KEEPING = [
		"fabric_page_data_list",
		"fabric_page_data_set",
		"fabric_page_ask",
		"fabric_get_page_viewer",
		"fabric_list_workflows",
		"fabric_execute_workflow",
	];
	const VOTE = {
		collection: "votes",
		records: [{ key: "@me", value: { pick: "a" } }],
	};

	beforeEach(() => {
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				["fabric_page_data_list", { readOnlyHint: true }],
				["fabric_page_data_set", {}],
				["fabric_page_ask", { readOnlyHint: true }],
				["fabric_get_page_viewer", { readOnlyHint: true }],
				["fabric_list_workflows", { readOnlyHint: true }],
				["fabric_execute_workflow", {}],
			]),
		);
	});

	it("asks once about a write to the page's data, and not at all about reading it", async () => {
		const page = host({ runtimeTools: KEEPING });

		await page.handleCall(
			call("fabric_page_data_list", { collection: "votes" }),
		);
		await page.handleCall(call("fabric_page_data_set", VOTE, "r2"));

		expect(mocks.confirmTool).toHaveBeenCalledTimes(1);
		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_page_data_set",
			VOTE,
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it("asks on every call about any other write, so what a viewer typed cannot become a standing yes", async () => {
		await host({ runtimeTools: KEEPING }).handleCall(
			call("fabric_execute_workflow", { workflowId: "w1" }),
		);

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_execute_workflow",
			{ workflowId: "w1" },
			{ every: true, because: "keeps-data" },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it("asks only once about that write when the page keeps no data", async () => {
		await host({
			runtimeTools: ["fabric_execute_workflow"],
		}).handleCall(call("fabric_execute_workflow", { workflowId: "w1" }));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_execute_workflow",
			{ workflowId: "w1" },
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it.each([
		["the viewer", "fabric_get_page_viewer"],
		["the model", "fabric_page_ask"],
		["another read of Fabric", "fabric_list_workflows"],
	])(
		"asks on every write to shared data once the page has read %s",
		async (_label, reader) => {
			const page = host({ runtimeTools: KEEPING });

			await page.handleCall(
				call(reader, { question: "Summarise" }, "r1"),
			);
			mocks.confirmTool.mockClear();
			await page.handleCall(call("fabric_page_data_set", VOTE, "r2"));

			expect(mocks.confirmTool).toHaveBeenCalledWith(
				"fabric_page_data_set",
				VOTE,
				{ every: true, because: "tainted" },
				expect.objectContaining({
					signal: expect.any(AbortSignal),
					expiresAt: expect.any(Number),
				}),
			);
		},
	);

	it("does not take a page to have read outside its store because it read its own", async () => {
		const page = host({ runtimeTools: KEEPING });

		await page.handleCall(
			call("fabric_page_data_list", { collection: "votes" }),
		);
		mocks.confirmTool.mockClear();
		await page.handleCall(call("fabric_page_data_set", VOTE, "r2"));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_page_data_set",
			VOTE,
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it("leaves a record the viewer keeps for themselves to the usual question, tainted or not", async () => {
		const page = host({ runtimeTools: KEEPING });
		const mine = {
			collection: "votes",
			records: [{ key: "@me", value: 1, scope: "mine" }],
		};

		await page.handleCall(call("fabric_get_page_viewer"));
		mocks.confirmTool.mockClear();
		await page.handleCall(call("fabric_page_data_set", mine, "r2"));
		await page.handleCall(call("fabric_page_data_set", VOTE, "r3"));

		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: false },
			{ every: true, because: "tainted" },
		]);
	});

	it("does not take a page to have read anything when the read failed", async () => {
		const page = host({ runtimeTools: KEEPING });
		mocks.callTool.mockRejectedValueOnce(new Error("offline"));

		await page.handleCall(call("fabric_get_page_viewer"));
		mocks.confirmTool.mockClear();
		await page.handleCall(call("fabric_page_data_set", VOTE, "r2"));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_page_data_set",
			VOTE,
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it("does not take a page to have read anything when the viewer refused the read", async () => {
		const page = host({ runtimeTools: KEEPING });
		mocks.confirmTool.mockResolvedValueOnce(false);

		await page.handleCall(call("fabric_page_ask", { question: "q" }));
		mocks.confirmTool.mockClear();
		mocks.confirmTool.mockResolvedValue(true);
		await page.handleCall(call("fabric_page_data_set", VOTE, "r2"));

		expect(mocks.confirmTool).toHaveBeenCalledWith(
			"fabric_page_data_set",
			VOTE,
			{ every: false },
			expect.objectContaining({
				signal: expect.any(AbortSignal),
				expiresAt: expect.any(Number),
			}),
		);
	});

	it("keeps what a page has read across a host made again for the same page, but not for another", async () => {
		const taint = createPageTaint();
		await host({ runtimeTools: KEEPING, taint }).handleCall(
			call("fabric_get_page_viewer"),
		);
		mocks.confirmTool.mockClear();

		await host({ runtimeTools: KEEPING, taint }).handleCall(
			call("fabric_page_data_set", VOTE, "r2"),
		);
		await host({
			runtimeTools: KEEPING,
			taint: createPageTaint(),
		}).handleCall(call("fabric_page_data_set", VOTE, "r3"));

		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: true, because: "tainted" },
			{ every: false },
		]);
	});

	it("asks once about a question for the model, even for a page that keeps data, and on every read of a connected server after it", async () => {
		const page = host({
			runtimeTools: [...KEEPING, "connected:linear/list_issues"],
		});
		mocks.loadToolInfo.mockResolvedValue(
			new Map([
				["fabric_page_ask", { readOnlyHint: true }],
				["fabric_page_read_connected", { readOnlyHint: true }],
			]),
		);

		await page.handleCall(call("fabric_page_ask", { question: "q" }));
		await page.handleCall(
			call(
				"fabric_page_read_connected",
				{ provider: "linear", tool: "list_issues", args: {} },
				"r2",
			),
		);

		expect(mocks.confirmTool.mock.calls.map((entry) => entry[2])).toEqual([
			{ every: false, readOnly: true },
			{ every: true, because: "tainted", readOnly: true },
		]);
	});
});

describe("a file a page offers", () => {
	const OFFER = {
		type: "fabric-frame:download",
		filename: "report.csv",
		mimeType: "text/csv",
		dataBase64: btoa("a,b\n1,2\n"),
	} as const;

	beforeEach(() => {
		mocks.confirmDownload.mockResolvedValue(true);
	});

	it("is saved once the viewer accepts it, after being checked", async () => {
		const outcome = await host().handleDownload(OFFER);

		expect(outcome).toBe("saved");
		expect(mocks.confirmDownload).toHaveBeenCalledWith({
			filename: "report.csv",
			mimeType: "text/csv",
			bytes: 8,
			dataBase64: OFFER.dataBase64,
		});
		expect(mocks.saveDownload).toHaveBeenCalledWith(
			mocks.confirmDownload.mock.calls[0][0],
		);
	});

	it("is not saved when the viewer declines", async () => {
		mocks.confirmDownload.mockResolvedValue(false);

		const outcome = await host().handleDownload(OFFER);

		expect(outcome).toBe("declined");
		expect(mocks.saveDownload).not.toHaveBeenCalled();
	});

	it("is offered under the cleaned name, not the one the page chose", async () => {
		await host().handleDownload({
			...OFFER,
			filename: "../../etc/report.csv",
		});

		expect(mocks.confirmDownload.mock.calls[0][0]).toMatchObject({
			filename: "report.csv",
		});
	});

	it.each([
		["a kind that may not be offered", { filename: "setup.exe" }],
		["a type the extension does not have", { mimeType: "text/html" }],
		["text that is not a file", { dataBase64: "not base64!!" }],
	])(
		"is refused for %s, without asking the viewer",
		async (_label, change) => {
			const outcome = await host().handleDownload({
				...OFFER,
				...change,
			});

			expect(outcome).toBe("refused");
			expect(mocks.confirmDownload).not.toHaveBeenCalled();
			expect(mocks.saveDownload).not.toHaveBeenCalled();
		},
	);

	it("is refused for a page of another organization than the one being viewed", async () => {
		const outcome = await host({
			viewingOrganizationId: () => "org-b",
		}).handleDownload(OFFER);

		expect(outcome).toBe("refused");
		expect(mocks.confirmDownload).not.toHaveBeenCalled();
	});

	it("counts toward the page's calls a minute, so it cannot ask without end", async () => {
		const page = host();
		for (
			let index = 0;
			index < FRAME_RUNTIME_RATE_LIMIT.maxCalls;
			index++
		) {
			await page.handleDownload(OFFER);
		}

		const outcome = await page.handleDownload(OFFER);

		expect(outcome).toBe("refused");
		expect(mocks.confirmDownload).toHaveBeenCalledTimes(
			FRAME_RUNTIME_RATE_LIMIT.maxCalls,
		);
	});
});
