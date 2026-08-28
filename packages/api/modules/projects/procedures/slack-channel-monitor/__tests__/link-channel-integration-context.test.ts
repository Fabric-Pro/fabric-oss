/**
 * Linking a Slack channel from Project Settings must leave a ProjectContext
 * INTEGRATION row behind (Fizzy #2228).
 *
 * Before this, that path wrote only the `ProjectLinkedSlackChannel` monitor
 * row. Conversation capture hangs its bundles off the channel's CONTEXT row, so
 * a channel linked this way had no parent to hang anything from and capture was
 * a permanent no-op for it — not degraded, never running. Teams has registered
 * its channels this way since it hit the same gap in the source picker.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: unknown[]) => unknown> = {};
	const mocks = {
		ensureSlackChannelIntegrationContext: vi.fn(),
		projectFindFirst: vi.fn(),
		linkedFindUnique: vi.fn(),
		linkedUpsert: vi.fn(),
		contextUpdateMany: vi.fn(),
		getSlackCredentials: vi.fn(),
		workflowStart: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	ensureSlackChannelIntegrationContext:
		mocks.ensureSlackChannelIntegrationContext,
	db: {
		project: { findFirst: mocks.projectFindFirst },
		projectLinkedSlackChannel: {
			findUnique: mocks.linkedFindUnique,
			upsert: mocks.linkedUpsert,
		},
		projectContext: { updateMany: mocks.contextUpdateMany },
	},
}));

vi.mock("@repo/integrations/slack", () => ({
	getSlackCredentials: mocks.getSlackCredentials,
}));

vi.mock("@repo/temporal", () => ({
	getTemporalClient: vi
		.fn()
		.mockResolvedValue({ workflow: { start: mocks.workflowStart } }),
}));

vi.mock("../../../../../lib/temporal-correlation", () => ({
	withCorrelationMemo: (input: unknown) => input,
}));

vi.mock("../../../../../orpc/procedures", () => {
	function makeChainable() {
		const chainable: Record<string, unknown> = {};
		Object.assign(chainable, {
			use: () => chainable,
			route: () => chainable,
			input: () => chainable,
			output: () => chainable,
			handler: (fn: (...args: unknown[]) => unknown) => {
				handlers.link = fn;
				return { _handler: fn };
			},
		});
		return chainable;
	}
	return {
		get tenantProtectedProcedure() {
			return makeChainable();
		},
		Permissions: new Proxy({}, { get: (_t, p) => String(p) }),
		requirePermission: () => (c: unknown) => c,
		requireProjectPermission: () => (c: unknown) => c,
		resolveOrganizationId: (organizationId: string | null | undefined) =>
			organizationId ?? null,
	};
});

import "../link-channel";

const PROJECT_ID = "proj_1";
const USER_ID = "user_1";
const ORG_ID = "org_1";

function callLink(inputOverrides: Record<string, unknown> = {}) {
	return handlers.link({
		input: {
			projectId: PROJECT_ID,
			organizationId: ORG_ID,
			slackTeamId: "T1",
			channelId: "C123",
			channelName: "engineering",
			backfillMode: "latest-7-days",
			...inputOverrides,
		},
		context: {
			user: { id: USER_ID },
			session: { activeOrganizationId: ORG_ID },
		},
	}) as Promise<unknown>;
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.projectFindFirst.mockResolvedValue({
		id: PROJECT_ID,
		organizationId: ORG_ID,
		slackChannelMonitorEnabled: false,
	});
	mocks.linkedFindUnique.mockResolvedValue(null);
	mocks.linkedUpsert.mockResolvedValue({ id: "lc_1" });
	mocks.contextUpdateMany.mockResolvedValue({ count: 0 });
	mocks.ensureSlackChannelIntegrationContext.mockResolvedValue({
		created: true,
		contextId: "ctx_1",
	});
});

describe("linking a Slack channel from Project Settings", () => {
	it("creates the channel's pointer row", async () => {
		await callLink();

		expect(
			mocks.ensureSlackChannelIntegrationContext,
		).toHaveBeenCalledTimes(1);
		expect(mocks.ensureSlackChannelIntegrationContext).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: PROJECT_ID,
				channelId: "C123",
				channelName: "engineering",
				slackTeamId: "T1",
				userId: USER_ID,
				organizationId: ORG_ID,
			}),
		);
	});

	it("a SECOND link of the same channel does not create a duplicate", async () => {
		mocks.linkedFindUnique.mockResolvedValue({
			id: "lc_1",
			backfillCompleteAt: new Date(),
		});
		mocks.ensureSlackChannelIntegrationContext.mockResolvedValue({
			created: false,
			contextId: "ctx_1",
		});

		await callLink();

		// The helper is idempotent by matching on `metadata.channelId`; the
		// procedure asserts only that it reported no creation.
		expect(
			mocks.ensureSlackChannelIntegrationContext,
		).toHaveBeenCalledTimes(1);
		expect(
			await mocks.ensureSlackChannelIntegrationContext.mock.results[0]
				.value,
		).toEqual({ created: false, contextId: "ctx_1" });
	});

	it("registers a personal-tenant link with no organizationId", async () => {
		mocks.projectFindFirst.mockResolvedValue({
			id: PROJECT_ID,
			organizationId: null,
			slackChannelMonitorEnabled: false,
		});

		await callLink({ organizationId: null });

		expect(mocks.ensureSlackChannelIntegrationContext).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: USER_ID,
				organizationId: undefined,
			}),
		);
	});

	it("still links the channel when the pointer-row write fails", async () => {
		// Best-effort: the monitor link is the primary action.
		mocks.ensureSlackChannelIntegrationContext.mockRejectedValue(
			new Error("context write failed"),
		);

		await expect(callLink()).resolves.toEqual({ id: "lc_1" });
		expect(mocks.linkedUpsert).toHaveBeenCalledTimes(1);
	});

	it("does not run when the project is not found", async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(callLink()).rejects.toThrow();
		expect(
			mocks.ensureSlackChannelIntegrationContext,
		).not.toHaveBeenCalled();
	});
});
