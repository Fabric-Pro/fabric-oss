/**
 * Tests for the PM auto-sync gate on the kanban CLI webhook handler.
 *
 * The kanban CLI is an upstream developer integration: developers pull
 * tasks from Fabric, edit them locally, and the kanban CLI echoes those
 * edits back via this webhook. When the user has opted into PM auto-sync
 * on the story, the rename / description rewrite must propagate onward
 * to the linked PM ticket so kanban, Fabric, and the PM tool stay in
 * sync.
 *
 * Mocks `@repo/database`, `enqueuePmSync`, and the oRPC procedure base
 * so the handler can be invoked directly with synthetic webhook payloads.
 * Signature verification is bypassed by stubbing the secret to a known
 * value and signing the test payload with it.
 */

import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => ({
	handlers: {} as Record<string, (...args: unknown[]) => unknown>,
	mocks: {
		userStoryFindUnique: vi.fn(),
		updateStory: vi.fn(),
		enqueuePmSync: vi.fn(),
		loggerWarn: vi.fn(),
	},
}));

vi.mock("@repo/database", () => ({
	db: {
		userStory: {
			findUnique: mocks.userStoryFindUnique,
		},
		kanbanQueue: {
			updateMany: vi.fn(async () => ({ count: 0 })),
		},
		projectStoryStatus: {
			findFirst: vi.fn(async () => null),
		},
	},
	updateStory: mocks.updateStory,
}));

vi.mock("@repo/logs", () => ({
	logger: {
		warn: mocks.loggerWarn,
		info: vi.fn(),
		error: vi.fn(),
		debug: vi.fn(),
	},
}));

vi.mock("../../../projects/lib/enqueue-pm-sync", () => ({
	enqueuePmSync: mocks.enqueuePmSync,
}));

vi.mock("../../../../orpc/procedures", () => {
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		output: () => chainable,
		handler: (fn: (...args: unknown[]) => unknown) => {
			handlers.webhook = fn;
			return { _handler: fn };
		},
	});
	const Permissions = new Proxy({}, { get: (_t, p) => String(p) }) as Record<
		string,
		string
	>;
	return {
		publicProcedure: chainable,
		Permissions,
		requirePermission: () => (c: unknown) => c,
	};
});

// Pin the webhook secret BEFORE importing the module so the constant
// captures the test value. Otherwise it falls back to "dev-secret" and
// the signed payloads diverge from what the verifier recomputes.
process.env.KANBAN_WEBHOOK_SECRET = "test-webhook-secret";

await import("../webhook");

function signedInput(event: string, payload: Record<string, unknown>) {
	const timestamp = Date.now();
	const payloadString = JSON.stringify({ event, payload, timestamp });
	const signature = createHmac("sha256", "test-webhook-secret")
		.update(payloadString)
		.digest("hex");
	return { event, payload, signature, timestamp };
}

beforeEach(() => {
	for (const m of Object.values(mocks)) {
		(m as ReturnType<typeof vi.fn>).mockReset();
	}
	mocks.enqueuePmSync.mockResolvedValue({
		enqueued: true,
		workflowId: "wf_test",
	});
	mocks.userStoryFindUnique.mockResolvedValue({ projectId: "project-1" });
});

describe("kanban webhook task.updated PM sync gate", () => {
	it("pmAutoSyncEnabled=true + title rename → enqueuePmSync called with createdById attribution", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			projectId: "project-1",
			createdById: "user-creator",
			pmAutoSyncEnabled: true,
		});

		await handlers.webhook({
			input: signedInput("task.updated", {
				storyId: "story-1",
				title: "Renamed in kanban",
			}),
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
		expect(mocks.enqueuePmSync).toHaveBeenCalledWith({
			itemId: "story-1",
			itemType: "story",
			projectId: "project-1",
			userId: "user-creator",
			triggerSource: "manual-edit",
		});
	});

	it("pmAutoSyncEnabled=true + description rewrite → enqueuePmSync called", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			projectId: "project-1",
			createdById: "user-creator",
			pmAutoSyncEnabled: true,
		});

		await handlers.webhook({
			input: signedInput("task.updated", {
				storyId: "story-1",
				description: "Edited description in kanban",
			}),
		});

		expect(mocks.enqueuePmSync).toHaveBeenCalledTimes(1);
	});

	it("pmAutoSyncEnabled=false → enqueuePmSync NOT called even on title rename", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			projectId: "project-1",
			createdById: "user-creator",
			pmAutoSyncEnabled: false,
		});

		await handlers.webhook({
			input: signedInput("task.updated", {
				storyId: "story-1",
				title: "Renamed",
			}),
		});

		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("payload without title or description → no DB write and no enqueuePmSync", async () => {
		await handlers.webhook({
			input: signedInput("task.updated", {
				storyId: "story-1",
			}),
		});

		expect(mocks.updateStory).not.toHaveBeenCalled();
		expect(mocks.enqueuePmSync).not.toHaveBeenCalled();
	});

	it("pmAutoSyncEnabled=true + enqueuePmSync rejects → handler still resolves", async () => {
		mocks.updateStory.mockResolvedValue({
			id: "story-1",
			projectId: "project-1",
			createdById: "user-creator",
			pmAutoSyncEnabled: true,
		});
		mocks.enqueuePmSync.mockRejectedValueOnce(new Error("temporal down"));

		const result = await handlers.webhook({
			input: signedInput("task.updated", {
				storyId: "story-1",
				title: "x",
			}),
		});

		expect((result as { success: boolean }).success).toBe(true);
		await new Promise((r) => setImmediate(r));
		expect(mocks.loggerWarn).toHaveBeenCalledWith(
			"enqueuePmSync failed",
			expect.objectContaining({ storyId: "story-1" }),
		);
	});
});
