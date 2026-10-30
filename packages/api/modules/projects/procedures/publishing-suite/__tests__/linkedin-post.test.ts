import { beforeEach, expect, it, vi } from "vitest";

/** Focused opt-in forwarding coverage for LinkedIn generation. */
const dbMocks = vi.hoisted(() => ({
	startTopicDraftAttempt: vi.fn(),
	failTopicDraft: vi.fn(),
	logDraftRefusal: vi.fn(),
	listTopicDrafts: vi.fn(),
	saveWorkingDraft: vi.fn(),
}));
const flagMocks = vi.hoisted(() => ({
	isFeatureEnabled: vi.fn(),
	resolveProjectTenant: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	...dbMocks,
	// The gate resolves the flag per organization and derives the tenant from
	// the Project row. `resolveProjectTenant` MUST point at flagMocks, not a
	// bare vi.fn(): the gate reads a null return as "project not resolvable"
	// and throws NOT_FOUND, so an unconfigured mock would fail every test in
	// this file for the wrong reason.
	isFeatureEnabled: flagMocks.isFeatureEnabled,
	resolveProjectTenant: flagMocks.resolveProjectTenant,
}));

const temporalMocks = vi.hoisted(() => ({
	isTemporalAvailable: vi.fn(async () => true),
	workflowStart: vi.fn(async () => undefined),
}));
vi.mock("@repo/temporal", () => ({
	isTemporalAvailable: temporalMocks.isTemporalAvailable,
	getTemporalClient: async () => ({
		workflow: { start: temporalMocks.workflowStart },
	}),
}));

const projectMocks = vi.hoisted(() => ({
	requireEligibleProjectForTopic: vi.fn(async () => ({
		id: "project-1",
		organizationId: "org-1",
	})),
}));
vi.mock("../../../lib/publishing-topic-project", () => projectMocks);

vi.mock("../../../../../orpc/procedures", () => {
	const chain: Record<string, unknown> = {};
	for (const m of ["use", "route", "input", "output"]) {
		chain[m] = () => chain;
	}
	chain.handler = (fn: unknown) => ({
		handler: fn,
		__permission: chain.__permission,
	});
	return {
		tenantProtectedProcedure: chain,
		requireProjectPermission: (p: string) => {
			chain.__permission = p;
			return () => chain;
		},
		Permissions: {
			PUBLISHING_TOPIC_READ: "publishing-topic:read",
			PUBLISHING_TOPIC_UPDATE: "publishing-topic:update",
		},
	};
});

import { generateLinkedInPostProcedure } from "../linkedin-post";

type Handled = {
	handler: (args: {
		input: {
			projectId: string;
			topicId: string;
			organizationId: string;
			seedWorkingDraft?: boolean;
		};
		context: { user: { id: string } };
	}) => Promise<unknown>;
};
const generate = generateLinkedInPostProcedure as unknown as Handled;

const CONTEXT = { user: { id: "user-1" } };
const INPUT = {
	projectId: "project-1",
	topicId: "topic-1",
	organizationId: "org-1",
};

beforeEach(() => {
	vi.clearAllMocks();
	// The rollback writer returns an outcome the handler reads. A bare
	// `vi.fn()` resolves to `undefined`, which is a shape the real writer
	// cannot produce — and a fixture that encodes an impossible shape is how
	// a handler change gets found by CI instead of by a test.
	dbMocks.failTopicDraft.mockResolvedValue({ persisted: true });
	flagMocks.isFeatureEnabled.mockResolvedValue(true);
	flagMocks.resolveProjectTenant.mockResolvedValue({
		organizationId: "org-1",
		userId: "user-1",
	});
	temporalMocks.isTemporalAvailable.mockResolvedValue(true);
	temporalMocks.workflowStart.mockResolvedValue(undefined);
	projectMocks.requireEligibleProjectForTopic.mockResolvedValue({
		id: "project-1",
		organizationId: "org-1",
	});
	dbMocks.startTopicDraftAttempt.mockResolvedValue({
		status: "started",
		draftId: "draft-1",
		version: 1,
	});
});

it.each([true, false, undefined])(
	"forwards opt-in seeding: %s",
	async (seedWorkingDraft) => {
		await generate.handler({
			input: { ...INPUT, seedWorkingDraft },
			context: CONTEXT,
		});
		expect(
			temporalMocks.workflowStart.mock.calls[0][1].args[0]
				.seedWorkingDraft,
		).toBe(seedWorkingDraft || undefined);
	},
);
