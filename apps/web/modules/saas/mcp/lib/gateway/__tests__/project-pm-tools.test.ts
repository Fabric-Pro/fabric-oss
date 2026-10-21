import { AzureDevOpsProjectReadError } from "@repo/connectors";
import { readProjectPmTool } from "@repo/temporal/project-pm-service";
import {
	ASKS_ONCE,
	TAINTING_TOOLS,
} from "@repo/temporal/fabric-page-tool-definitions";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	resolve: vi.fn(),
	members: vi.fn(),
	counts: vi.fn(),
	types: vi.fn(),
	assigned: vi.fn(),
	snapshots: vi.fn(),
	access: vi.fn(),
	deleted: vi.fn(),
}));
vi.mock("@repo/mcp/lib/project-pm-read", () => ({
	resolveProjectPmRead: mocks.resolve,
}));
vi.mock("@repo/api/modules/v1/instruction-direct-repository", () => ({
	getDirectRepositoryState: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	getProjectAccessContext: mocks.access,
	isProjectSoftDeleted: mocks.deleted,
}));
vi.mock("@repo/connectors", () => ({
	listAzureDevOpsProjectMembers: mocks.members,
	getAzureDevOpsProjectWorkItemCounts: mocks.counts,
	listAzureDevOpsWorkItemTypes: mocks.types,
	listAzureDevOpsAssignedStories: mocks.assigned,
	getAzureDevOpsStorySnapshots: mocks.snapshots,
	AzureDevOpsProjectReadError: class extends Error {},
}));

import {
	executePlatformTool,
	PLATFORM_TOOL_DEFINITIONS,
} from "../platform-tools";
import type { GatewaySession, ToolCallResult } from "../types";

const session: GatewaySession = {
	sessionId: "session-1",
	userId: "user-1",
	organizationId: "org-1",
	userName: "Example User",
	email: "user@example.com",
	role: "user",
	credential: "session",
	scopes: ["*"],
	createdAt: new Date("2026-01-01"),
	expiresAt: new Date("2026-01-02"),
};
const connection = {
	status: "ready",
	provider: "azure-devops",
	target: {
		organization: "example-org",
		projectId: "ado-project",
		projectName: "Example Project",
	},
	pat: "example-private-pat",
};
const names = [
	"fabric_get_project_pm_connection",
	"fabric_list_project_pm_members",
	"fabric_get_project_work_item_counts",
	"fabric_list_project_pm_work_item_types",
	"fabric_list_project_pm_assigned_items",
	"fabric_get_project_pm_item_snapshots",
];
const payload = (result: ToolCallResult) => JSON.parse(result.content[0].text);
const asOf = "2026-01-01T12:00:00.0001234Z";
const itemArguments = (name: string) =>
	name === "fabric_get_project_pm_item_snapshots"
		? { ids: [1], requirementsAsOf: asOf }
		: {};

beforeEach(() => {
	vi.clearAllMocks();
	mocks.access.mockResolvedValue({ organizationId: "org-1" });
	mocks.deleted.mockResolvedValue(false);
	mocks.resolve.mockResolvedValue(connection);
	mocks.members.mockResolvedValue({
		members: [],
		complete: true,
		membershipScope: "project_teams",
	});
	mocks.counts.mockResolvedValue({
		total: 0,
		matchingState: 0,
		complete: true,
	});
	mocks.types.mockResolvedValue({
		workItemTypes: [],
		complete: true,
		incompleteReason: null,
	});
	mocks.assigned.mockResolvedValue({
		ids: [1],
		requirementsAsOf: asOf,
		complete: true,
		incompleteReason: null,
		cursor: null,
	});
	mocks.snapshots.mockResolvedValue({
		snapshots: [],
		unreadIds: [1],
		requirementsAsOf: asOf,
		complete: false,
		incompleteReason: "unavailable",
	});
});

describe("project PM gateway tools", () => {
	it("keeps the public adapter's raw data identical to the shared read service", async () => {
		const call = {
			name: "fabric_list_project_pm_members",
			input: { projectId: "project-1" },
		} as const;
		const shared = await readProjectPmTool(call, {
			userId: session.userId,
			organizationId: "org-1",
		});
		const publicResult = await executePlatformTool(
			call.name,
			call.input,
			session,
		);
		expect(shared.success).toBe(true);
		if (shared.success) {
			expect(payload(publicResult)).toEqual(shared.result);
		}
		expect(JSON.stringify(publicResult)).not.toContain(connection.pat);
	});
	it("offers the same read-only declaration schemas used by the runtime", () => {
		for (const name of names) {
			expect(
				PLATFORM_TOOL_DEFINITIONS.find((tool) => tool.name === name),
			).toMatchObject({
				annotations: { readOnlyHint: true },
				inputSchema: {
					required: expect.arrayContaining(["projectId"]),
				},
			});
		}
	});

	it("returns safe no-network connection status, without the PAT", async () => {
		const result = await executePlatformTool(
			names[0],
			{ projectId: "project-1" },
			session,
		);
		expect(payload(result)).toEqual({
			status: "ready",
			provider: "azure-devops",
			target: connection.target,
		});
		expect(JSON.stringify(result)).not.toContain("example-private-pat");
		expect(mocks.members).not.toHaveBeenCalled();
		expect(mocks.counts).not.toHaveBeenCalled();
	});

	it("rechecks an absent binding and activates the saved declaration later", async () => {
		mocks.resolve.mockResolvedValueOnce({ status: "not_configured" });
		expect(
			payload(
				await executePlatformTool(
					names[1],
					{ projectId: "project-1" },
					session,
				),
			),
		).toEqual({ status: "not_configured" });
		expect(mocks.members).not.toHaveBeenCalled();
		expect(
			payload(
				await executePlatformTool(
					names[1],
					{ projectId: "project-1" },
					session,
				),
			),
		).toMatchObject({ status: "ready", complete: true });
		expect(mocks.resolve).toHaveBeenCalledTimes(2);
	});

	it.each(names)(
		"refuses project denial or another tenant before PM lookup: %s",
		async (name) => {
			for (const access of [null, { organizationId: "other-org" }]) {
				mocks.access.mockResolvedValueOnce(access);
				const result = await executePlatformTool(
					name,
					{ projectId: "project-1", ...itemArguments(name) },
					{ ...session, credential: "organization-key" },
				);
				expect(result.isError).toBe(true);
				expect(mocks.resolve).not.toHaveBeenCalled();
				expect(mocks.members).not.toHaveBeenCalled();
				expect(mocks.counts).not.toHaveBeenCalled();
				expect(mocks.assigned).not.toHaveBeenCalled();
				expect(mocks.snapshots).not.toHaveBeenCalled();
			}
		},
	);

	it.each(names)(
		"refuses trashed projects before PM lookup: %s",
		async (name) => {
			mocks.deleted.mockResolvedValueOnce(true);
			expect(
				(
					await executePlatformTool(
						name,
						{ projectId: "project-1", ...itemArguments(name) },
						session,
					)
				).isError,
			).toBe(true);
			expect(mocks.resolve).not.toHaveBeenCalled();
			expect(mocks.members).not.toHaveBeenCalled();
			expect(mocks.counts).not.toHaveBeenCalled();
		},
	);

	it.each(names)(
		"requires connector scope independently of project access: %s",
		async (name) => {
			const result = await executePlatformTool(
				name,
				{ projectId: "project-1", ...itemArguments(name) },
				{
					...session,
					credential: "organization-key",
					scopes: ["projects:read"],
				},
			);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("mcp:read");
			expect(mocks.resolve).not.toHaveBeenCalled();
		},
	);

	it.each(names)(
		"keeps project-bound calls to their project: %s",
		async (name) => {
			const bound = { ...session, projectId: "project-1" };
			expect(
				(
					await executePlatformTool(
						name,
						{ projectId: "other-project", ...itemArguments(name) },
						bound,
					)
				).isError,
			).toBe(true);
			expect(mocks.resolve).not.toHaveBeenCalled();
			expect(
				(await executePlatformTool(name, itemArguments(name), bound))
					.isError,
			).not.toBe(true);
			expect(mocks.resolve).toHaveBeenCalledWith({
				projectId: "project-1",
				userId: "user-1",
				organizationId: "org-1",
			});
		},
	);

	it.each(names)(
		"does not widen a meeting's pinned service grant: %s",
		async (name) => {
			expect(
				(
					await executePlatformTool(
						name,
						{ projectId: "project-1", ...itemArguments(name) },
						{
							...session,
							credential: "service",
							pinnedProjectId: "project-1",
						},
					)
				).isError,
			).toBe(true);
			expect(mocks.resolve).not.toHaveBeenCalled();
		},
	);

	it("uses only resolved target data and validated count filters", async () => {
		await executePlatformTool(
			names[2],
			{
				projectId: "project-1",
				assignee: "dev@example.com",
			},
			session,
		);
		expect(mocks.counts).toHaveBeenCalledWith(
			connection.target,
			"example-private-pat",
			{
				projectId: "project-1",
				state: "In Development",
				assignee: "dev@example.com",
			},
		);
	});

	it("preserves incomplete counts without exposing the credential", async () => {
		mocks.counts.mockResolvedValueOnce({
			total: null,
			matchingState: 2,
			complete: false,
			observed: { total: 40_000, matchingState: 2 },
		});
		const result = await executePlatformTool(
			names[2],
			{ projectId: "project-1" },
			session,
		);
		expect(payload(result)).toMatchObject({
			status: "ready",
			total: null,
			complete: false,
		});
		expect(JSON.stringify(result)).not.toContain("example-private-pat");
	});

	it("sanitizes unexpected provider exceptions", async () => {
		mocks.members.mockRejectedValueOnce(new Error("example-private-pat"));
		const result = await executePlatformTool(
			names[1],
			{ projectId: "project-1" },
			session,
		);
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Try again");
		expect(JSON.stringify(result)).not.toContain("example-private-pat");
	});

	it("discovers types only from the resolved project and preserves incomplete status without credentials", async () => {
		mocks.types.mockResolvedValueOnce({
			workItemTypes: [],
			complete: false,
			incompleteReason: "response_limit",
		});
		const result = await executePlatformTool(
			"fabric_list_project_pm_work_item_types",
			{
				projectId: "project-1",
			},
			session,
		);
		expect(mocks.types).toHaveBeenCalledWith(
			connection.target,
			"example-private-pat",
		);
		expect(payload(result)).toMatchObject({
			status: "ready",
			workItemTypes: [],
			complete: false,
			incompleteReason: "response_limit",
		});
		expect(JSON.stringify(result)).not.toContain("example-private-pat");
	});

	it("external reads ask once and taint later shared-store writes", () => {
		expect(ASKS_ONCE.has(names[0])).toBe(false);
		expect(TAINTING_TOOLS.has(names[0])).toBe(false);
		for (const name of names.slice(1, 4)) {
			expect(ASKS_ONCE.has(name)).toBe(true);
			expect(TAINTING_TOOLS.has(name)).toBe(true);
		}
	});

	it.each(names)(
		"rejects undeclared arguments before authorization: %s",
		async (name) => {
			const result = await executePlatformTool(
				name,
				{
					projectId: "project-1",
					...itemArguments(name),
					url: "https://example.com",
				},
				session,
			);
			expect(result.isError).toBe(true);
			expect(mocks.access).not.toHaveBeenCalled();
			expect(mocks.resolve).not.toHaveBeenCalled();
		},
	);

	it("enumerates using the current connection by default and preserves a partial cursor", async () => {
		const partial = {
			ids: [1, 2],
			requirementsAsOf: asOf,
			complete: false,
			incompleteReason: "item_limit",
			cursor: { afterId: 2, requirementsAsOf: asOf },
		};
		mocks.assigned.mockResolvedValueOnce(partial);
		const result = await executePlatformTool(
			names[4],
			{ projectId: "project-1" },
			session,
		);
		expect(payload(result)).toMatchObject(partial);
		expect(mocks.assigned).toHaveBeenCalledWith(
			connection.target,
			connection.pat,
			{
				projectId: "project-1",
				assignee: { mode: "current" },
				workItemTypes: ["User Story"],
				limit: 50,
			},
		);
		expect(JSON.stringify(result)).not.toContain(connection.pat);
	});

	it("resumes exact selected-member and type filters with the supplied ASOF cursor", async () => {
		const filters = {
			assignee: { mode: "selected", uniqueName: "member@example.com" },
			workItemTypes: ["Task", "User Story"],
			cursor: { afterId: 50, requirementsAsOf: asOf },
		};
		await executePlatformTool(
			names[4],
			{ projectId: "project-1", ...filters },
			session,
		);
		expect(mocks.assigned).toHaveBeenCalledWith(
			connection.target,
			connection.pat,
			{ projectId: "project-1", ...filters, limit: 50 },
		);
	});

	it.each([
		{ assignee: { mode: "all" } },
		{ assignee: { mode: "current", uniqueName: "member@example.com" } },
		{
			assignee: {
				mode: "selected",
				uniqueName: "member@example.com",
				query: "WIQL",
			},
		},
		{ assignee: { mode: "selected", uniqueName: " " } },
		{ cursor: { afterId: 0, requirementsAsOf: asOf } },
		{ cursor: { afterId: 1, requirementsAsOf: "yesterday" } },
		{ cursor: { afterId: 1, requirementsAsOf: asOf, query: "WIQL" } },
		{ workItemTypes: [] },
		{ workItemTypes: Array.from({ length: 21 }, () => "Task") },
		{ limit: 1_000 },
	])(
		"refuses invalid enumeration arguments %j before connection lookup",
		async (input) => {
			expect(
				(
					await executePlatformTool(
						names[4],
						{ projectId: "project-1", ...input },
						session,
					)
				).isError,
			).toBe(true);
			expect(mocks.resolve).not.toHaveBeenCalled();
			expect(mocks.assigned).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ ids: [] },
		{ ids: [1, 1] },
		{ ids: [0] },
		{ ids: [1.5] },
		{ ids: [Number.MAX_SAFE_INTEGER + 1] },
		{ ids: Array.from({ length: 11 }, (_, index) => index + 1) },
		{ requirementsAsOf: "not-a-date" },
		{ requirementFields: [] },
		{ requirementFields: ["System.Title] FROM WorkItems"] },
		{ requirementFields: Array.from({ length: 21 }, () => "Custom.Field") },
		{ serverId: "other-server" },
	])(
		"refuses invalid snapshot arguments %j before connection lookup",
		async (input) => {
			expect(
				(
					await executePlatformTool(
						names[5],
						{
							projectId: "project-1",
							...itemArguments(names[5]),
							...input,
						},
						session,
					)
				).isError,
			).toBe(true);
			expect(mocks.resolve).not.toHaveBeenCalled();
			expect(mocks.snapshots).not.toHaveBeenCalled();
		},
	);

	it("uses canonical requirement fields and preserves unread capture provenance", async () => {
		const result = await executePlatformTool(
			names[5],
			{
				projectId: "project-1",
				ids: [1],
				requirementsAsOf: asOf,
				requirementFields: ["Custom.BusinessRules"],
			},
			session,
		);
		expect(mocks.snapshots).toHaveBeenCalledWith(
			connection.target,
			connection.pat,
			{
				projectId: "project-1",
				ids: [1],
				requirementsAsOf: asOf,
				requirementFields: ["Custom.BusinessRules"],
			},
		);
		expect(payload(result)).toMatchObject({
			complete: false,
			unreadIds: [1],
			incompleteReason: "unavailable",
			resultTruncated: false,
		});
		expect(JSON.stringify(result)).not.toContain(connection.pat);
	});

	it("refuses item snapshots rejected by the connector's project validation", async () => {
		mocks.snapshots.mockRejectedValueOnce(
			new AzureDevOpsProjectReadError("project_mismatch"),
		);
		const result = await executePlatformTool(
			names[5],
			{ projectId: "project-1", ...itemArguments(names[5]) },
			session,
		);
		expect(result.isError).toBe(true);
		expect(payload(result)).not.toHaveProperty("snapshots");
		expect(JSON.stringify(result)).not.toContain(connection.pat);
	});

	it.each([
		"not_connected",
		"not_configured",
		"unsupported",
		"forbidden",
		"not_found",
	])(
		"does not read items when the canonical resolver returns %s",
		async (status) => {
			mocks.resolve.mockResolvedValue({
				status,
				message: "Connection unavailable",
			});
			for (const name of names.slice(4)) {
				await executePlatformTool(
					name,
					{ projectId: "project-1", ...itemArguments(name) },
					session,
				);
			}
			expect(mocks.assigned).not.toHaveBeenCalled();
			expect(mocks.snapshots).not.toHaveBeenCalled();
		},
	);

	it.each(["connection", "enumeration", "snapshots"])(
		"redacts unexpected %s failures",
		async (source) => {
			const failure = new Error(`Credential: ${connection.pat}`);
			const name = source === "snapshots" ? names[5] : names[4];
			if (source === "connection") {
				mocks.resolve.mockRejectedValueOnce(failure);
			} else if (source === "enumeration") {
				mocks.assigned.mockRejectedValueOnce(failure);
			} else {
				mocks.snapshots.mockRejectedValueOnce(failure);
			}
			const result = await executePlatformTool(
				name,
				{ projectId: "project-1", ...itemArguments(name) },
				session,
			);
			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain("Try again");
			expect(JSON.stringify(result)).not.toContain(connection.pat);
		},
	);
});
