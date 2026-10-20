import { ActivityFailure, ApplicationFailure, log } from "@temporalio/workflow";
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({
	acts: {} as Record<string, ReturnType<typeof vi.fn>>,
	patched: vi.fn((_id: string) => true),
}));

vi.mock("@temporalio/workflow", async () => {
	const actual = await vi.importActual<typeof import("@temporalio/workflow")>(
		"@temporalio/workflow",
	);
	return {
		ActivityFailure: actual.ActivityFailure,
		ApplicationFailure: actual.ApplicationFailure,
		defineQuery: (name: string) => name,
		defineSignal: (name: string) => name,
		setHandler: vi.fn(),
		patched: h.patched,
		log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
		proxyActivities: () =>
			new Proxy(
				{},
				{
					get: (_target, name: string) => {
						h.acts[name] ??= vi.fn(async () => undefined);
						return h.acts[name];
					},
				},
			),
	};
});

const { storySyncWorkflow } = await import(
	"../src/workflows/story-sync-workflow"
);

const PATCH = "bulk-sync-link-guard-v1";
const CAPABILITIES = {
	hasPMCapabilities: true,
	detectedType: "fizzy",
	taskUpdate: {
		toolName: "update_card",
		idParam: "card_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [],
	},
	taskCreation: {
		toolName: "create_card",
		containerParam: "board_id",
		titleParam: "title",
		descriptionParam: "description",
		allParams: [],
	},
};
const link = {
	id: "story-1",
	identifier: "F-1",
	title: "Example story",
	description: null,
	externalId: "42",
	externalUrl: "https://pm.example.com/cards/42",
	externalMcpServerId: "server-old",
};
const input = {
	projectId: "project-1",
	organizationId: "example-org",
	userId: "user-1",
	mcpServerId: "server-active",
	mcpConfigId: "config-1",
	containerId: "board-1",
	additionalContext: { account_slug: "example-org" },
	direction: "push" as const,
	unsyncedOnly: false,
};
function act(name: string): ReturnType<typeof vi.fn> {
	h.acts[name] ??= vi.fn(async () => undefined);
	return h.acts[name];
}
beforeEach(() => {
	for (const stub of Object.values(h.acts)) {
		stub.mockReset();
		stub.mockResolvedValue(undefined);
	}
	h.patched.mockReset();
	h.patched.mockImplementation(() => true);
	act("discoverPMToolCapabilities").mockResolvedValue(CAPABILITIES);
	act("getStoriesToSync").mockResolvedValue([link]);
	act("checkStoryPmLink").mockResolvedValue({
		success: true,
		outcome: "link-ok",
	});
	act("detectAndStampPmPushConflict").mockResolvedValue({
		hasConflict: false,
	});
	act("executeMcpTool").mockResolvedValue({ success: true, output: {} });
	act("createStoryInPmWithClaim").mockResolvedValue({
		success: true,
		outcome: "created",
		externalId: "new-42",
	});
});

describe("bulk story push link guard", () => {
	it.each(["block", "legacy-other-tool", "link-changed", "not-in-project"])(
		"refuses %s before conflict detection, update or link write",
		async (outcome) => {
			const error = "Use Unlink & re-create.";
			act("checkStoryPmLink").mockResolvedValue({
				success: false,
				outcome,
				error,
			});
			const result = await storySyncWorkflow(input);
			expect(act("checkStoryPmLink")).toHaveBeenCalledWith(
				expect.objectContaining({
					storyId: link.id,
					projectId: input.projectId,
					organizationId: "example-org",
					userId: input.userId,
					mcpServerId: "server-active",
					mcpConfigId: "config-1",
					pmTool: "fizzy",
					externalId: link.externalId,
					externalUrl: link.externalUrl,
					externalMcpServerId: link.externalMcpServerId,
				}),
			);
			expect(act("detectAndStampPmPushConflict")).not.toHaveBeenCalled();
			expect(act("executeMcpTool")).not.toHaveBeenCalled();
			expect(act("updateStoryExternalRefs")).not.toHaveBeenCalled();
			expect(act("createStoryInPmWithClaim")).not.toHaveBeenCalled();
			expect(result).toMatchObject({
				success: false,
				failedCount: 1,
				syncedCount: 0,
				results: [{ storyId: link.id, success: false, error }],
			});
		},
	);

	it("continues to a valid story after a refusal and updates with its judged id", async () => {
		const active = {
			...link,
			id: "story-2",
			externalId: "43",
			externalMcpServerId: "server-active",
		};
		act("getStoriesToSync").mockResolvedValue([link, active]);
		act("checkStoryPmLink").mockResolvedValueOnce({
			success: false,
			outcome: "block",
			error: "Use Unlink & re-create.",
		});
		const result = await storySyncWorkflow(input);
		expect(act("checkStoryPmLink")).toHaveBeenCalledTimes(2);
		expect(act("detectAndStampPmPushConflict")).toHaveBeenCalledTimes(1);
		expect(act("detectAndStampPmPushConflict")).toHaveBeenCalledWith(
			expect.objectContaining({ itemId: "story-2", externalId: "43" }),
		);
		expect(act("executeMcpTool")).toHaveBeenCalledTimes(1);
		expect(act("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "update_card",
				args: expect.objectContaining({ card_id: "43" }),
			}),
		);
		expect(
			act("checkStoryPmLink").mock.invocationCallOrder[1],
		).toBeLessThan(
			act("detectAndStampPmPushConflict").mock.invocationCallOrder[0],
		);
		expect(result).toMatchObject({ failedCount: 1, syncedCount: 1 });
	});

	it("keeps an ok linked story on the update path even when the old URL heuristic disagrees", async () => {
		act("getStoriesToSync").mockResolvedValue([
			{
				...link,
				externalUrl: "https://linear.app/example-org/issue/42",
				externalMcpServerId: "server-active",
			},
		]);
		const result = await storySyncWorkflow(input);
		expect(act("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({
				toolName: "update_card",
				args: expect.objectContaining({ card_id: "42" }),
			}),
		);
		expect(act("createStoryInPmWithClaim")).not.toHaveBeenCalled();
		expect(result).toMatchObject({ success: true, syncedCount: 1 });
	});

	it("leaves an unlinked story's create behavior intact", async () => {
		act("getStoriesToSync").mockResolvedValue([
			{ ...link, externalId: null },
		]);
		await storySyncWorkflow(input);
		expect(act("checkStoryPmLink")).not.toHaveBeenCalled();
		expect(act("createStoryInPmWithClaim")).toHaveBeenCalledWith(
			expect.objectContaining({ action: "create" }),
		);
	});

	it("reports a thrown check error without calling PM for the story", async () => {
		act("checkStoryPmLink").mockRejectedValue(
			new Error("PM configuration is no longer available"),
		);
		expect(await storySyncWorkflow(input)).toMatchObject({
			failedCount: 1,
			syncedCount: 0,
		});
		expect(act("detectAndStampPmPushConflict")).not.toHaveBeenCalled();
		expect(act("executeMcpTool")).not.toHaveBeenCalled();
	});

	it("preserves the previous update commands without the patch", async () => {
		h.patched.mockImplementation((id) => id !== PATCH);
		expect(await storySyncWorkflow(input)).toMatchObject({
			syncedCount: 1,
		});
		expect(act("checkStoryPmLink")).not.toHaveBeenCalled();
		expect(act("executeMcpTool")).toHaveBeenCalledWith(
			expect.objectContaining({ toolName: "update_card" }),
		);
	});
});

it("redacts database errors in per-story results while preserving PM errors and raw logs", async () => {
	for (const [name, expected] of [
		["DriverAdapterError", "database error"],
		["Error", "404: item not found\nCheck board access"],
	]) {
		const raw = "404: item not found\nCheck board access";
		act("executeMcpTool").mockRejectedValueOnce(
			Object.assign(new Error(raw), { name }),
		);
		const result = await storySyncWorkflow(input);
		expect(result.results[0]?.error).toBe(expected);
		expect(log.error).toHaveBeenCalledWith(
			"Failed to sync story",
			expect.objectContaining({ error: raw }),
		);
	}
});

it("redacts the outer story failure in the durable job message and thrown failure", async () => {
	const raw = "database query at /app/packages/example/file.ts:123:45";
	act("getStoriesToSync").mockRejectedValueOnce(
		new ActivityFailure(
			"Activity task failed",
			"getStoriesToSync",
			"1",
			undefined,
			undefined,
			ApplicationFailure.create({
				message: raw,
				type: "PrismaClientInitializationError",
			}),
		),
	);
	await expect(storySyncWorkflow(input)).rejects.toThrow("database error");
	expect(act("closeStorySyncJob")).toHaveBeenLastCalledWith(
		expect.objectContaining({
			message: "database error",
			outcome: "FAILED",
		}),
	);
	expect(log.error).toHaveBeenCalledWith("Story sync workflow failed", {
		error: raw,
	});
});
