import { Permissions } from "@repo/permissions";
import { beforeEach, describe, expect, it, vi } from "vitest";

type Handler = (args: {
	input: Record<string, unknown>;
	context: Record<string, unknown>;
}) => Promise<unknown>;
type Middleware = (
	options: { context: Record<string, unknown>; next: () => Promise<unknown> },
	input: unknown,
) => Promise<unknown>;
type Captured = { handler: Handler; middleware: Middleware };

const mocks = vi.hoisted(() => ({
	findCandidates: vi.fn(),
	findProject: vi.fn(),
	findQueueEntry: vi.fn(),
	createQueueEntry: vi.fn(),
	getOrganizationMembership: vi.fn(),
	hasProjectAccess: vi.fn(),
	loadStoryReadiness: vi.fn(),
	procedures: {} as Record<string, Captured>,
	resolveEffectiveProjectPermissions: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		kanbanQueue: {
			count: vi.fn(),
			create: mocks.createQueueEntry,
			findFirst: mocks.findQueueEntry,
			findMany: vi.fn(),
			update: vi.fn(),
		},
		member: { findFirst: vi.fn(), findUnique: vi.fn() },
		project: { findUnique: mocks.findProject },
		projectMember: { findUnique: vi.fn() },
		userStory: { findMany: mocks.findCandidates },
	},
	getOrganizationMembership: mocks.getOrganizationMembership,
	getTenantContext: () => ({ effectiveWriteOrgId: undefined }),
	grantProjectAccess: vi.fn(),
	hasProjectAccess: mocks.hasProjectAccess,
}));
vi.mock("../../../../lib/effective-project-permissions", () => ({
	resolveEffectiveProjectPermissions:
		mocks.resolveEffectiveProjectPermissions,
}));
vi.mock("../../../projects/lib/run-readiness", async () => {
	const { z } = await import("zod");
	return {
		isStoryRunnable: () => true,
		loadStoryReadiness: mocks.loadStoryReadiness,
		readinessGapSchema: z.object({ code: z.string() }),
	};
});
vi.mock("../../../../orpc/procedures", async () => {
	const permission = await import(
		"../../../../orpc/middleware/require-permission"
	);
	const { Permissions: permissionValues } = await import("@repo/permissions");
	const root = {
		use: (middleware: Middleware) => {
			let route = { method: "", path: "" };
			const chain: Record<string, unknown> = {
				use: () => chain,
				route: (value: { method: string; path: string }) => {
					route = value;
					return chain;
				},
				input: () => chain,
				output: () => chain,
				handler: (handler: Handler) => {
					mocks.procedures[`${route.method} ${route.path}`] = {
						handler,
						middleware,
					};
					return chain;
				},
			};
			return chain;
		},
	};
	return {
		Permissions: permissionValues,
		requirePermission: permission.requirePermission,
		requireProjectPermission: permission.requireProjectPermission,
		resolveOrganizationId: (
			input: string | null | undefined,
			session: { activeOrganizationId?: string | null },
		) =>
			(input === undefined ? session.activeOrganizationId : input) ??
			undefined,
		tenantProtectedProcedure: root,
	};
});

await import("../sync");

const USER_ID = "example-user";
const PROJECT_ID = "example-project";
const ORG_A = "example-org-a";
const ORG_B = "example-org-b";
const context = {
	user: { id: USER_ID },
	session: { activeOrganizationId: ORG_A },
	activeOrganizationRole: "owner",
	allowedProjectIds: [],
	tenantContext: {
		userId: USER_ID,
		type: "organization",
		organizationId: ORG_A,
	},
};

async function invoke(input: Record<string, unknown>) {
	const procedure = mocks.procedures["POST /kanban/sync/push"];
	if (!procedure) {
		throw new Error("pushToKanban procedure was not captured");
	}
	const result = await procedure.middleware(
		{
			context,
			next: async () => ({
				output: await procedure.handler({ input, context }),
			}),
		},
		input,
	);
	return (result as { output: unknown }).output;
}

function grant(source: "org" | "project-member" = "org") {
	mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
		source,
		organizationId: ORG_B,
		organizationDeleted: false,
		permissions: [Permissions.STORY_UPDATE],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	context.allowedProjectIds = [];
	grant();
	mocks.hasProjectAccess.mockResolvedValue(true);
	mocks.findProject.mockResolvedValue({ organizationId: ORG_B });
	mocks.findCandidates.mockResolvedValue([
		{
			id: "example-story",
			title: "Example story",
			description: "Example description",
			acceptanceCriteria: "Example acceptance criteria",
			priority: "MEDIUM",
		},
	]);
	mocks.loadStoryReadiness.mockResolvedValue({ missing: [] });
	mocks.findQueueEntry.mockResolvedValue(null);
	mocks.createQueueEntry.mockImplementation(async ({ data }) => ({
		id: "example-queue-entry",
		...data,
	}));
});

describe("kanban.sync.push project organization authorization", () => {
	it("refuses a caller with no tie to the project before reading or writing queue data", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "none",
			organizationId: ORG_B,
			organizationDeleted: false,
			permissions: [],
		});

		await expect(
			invoke({ projectId: PROJECT_ID, organizationId: ORG_B }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.findCandidates).not.toHaveBeenCalled();
		expect(mocks.createQueueEntry).not.toHaveBeenCalled();
	});

	it("refuses a tied caller whose project role lacks STORY_UPDATE before queue access", async () => {
		mocks.resolveEffectiveProjectPermissions.mockResolvedValue({
			source: "project-member",
			organizationId: ORG_B,
			organizationDeleted: false,
			permissions: [Permissions.STORY_READ],
		});

		await expect(
			invoke({ projectId: PROJECT_ID, organizationId: null }),
		).rejects.toMatchObject({ code: "FORBIDDEN" });
		expect(mocks.findCandidates).not.toHaveBeenCalled();
		expect(mocks.createQueueEntry).not.toHaveBeenCalled();
	});

	it("refuses a mismatching input organization before queue access", async () => {
		await expect(
			invoke({ projectId: PROJECT_ID, organizationId: ORG_A }),
		).rejects.toMatchObject({
			code: "BAD_REQUEST",
			message: "organizationId does not match the project",
		});
		expect(mocks.findCandidates).not.toHaveBeenCalled();
		expect(mocks.createQueueEntry).not.toHaveBeenCalled();
	});

	it("queues in the project's organization for an authorized organization member", async () => {
		await expect(
			invoke({ projectId: PROJECT_ID, organizationId: ORG_B }),
		).resolves.toMatchObject({ success: true, pushedCount: 1 });
		expect(mocks.createQueueEntry).toHaveBeenCalledWith({
			data: expect.objectContaining({
				projectId: PROJECT_ID,
				organizationId: ORG_B,
			}),
		});
	});

	it("preserves an accepted project guest and stamps the queue row with the project's organization", async () => {
		grant("project-member");

		await expect(
			invoke({ projectId: PROJECT_ID, organizationId: null }),
		).resolves.toMatchObject({ success: true, pushedCount: 1 });
		expect(mocks.createQueueEntry).toHaveBeenCalledWith({
			data: expect.objectContaining({ organizationId: ORG_B }),
		});
	});
});
