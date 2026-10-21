import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	execution: vi.fn(),
	version: vi.fn(),
	permission: vi.fn(),
	access: vi.fn(),
	resolve: vi.fn(),
	members: vi.fn(),
	counts: vi.fn(),
	types: vi.fn(),
	assigned: vi.fn(),
	snapshots: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	db: {
		workflowExecution: { findFirst: mocks.execution },
		workflowVersion: { findFirst: mocks.version },
	},
	canRunOrganizationWorkflows: mocks.permission,
	hasProjectAccess: mocks.access,
}));
vi.mock("@repo/mcp/lib/project-pm-read", () => ({
	resolveProjectPmRead: mocks.resolve,
}));
vi.mock("@repo/connectors", () => ({
	listAzureDevOpsProjectMembers: mocks.members,
	getAzureDevOpsProjectWorkItemCounts: mocks.counts,
	listAzureDevOpsWorkItemTypes: mocks.types,
	listAzureDevOpsAssignedStories: mocks.assigned,
	getAzureDevOpsStorySnapshots: mocks.snapshots,
	AzureDevOpsProjectReadError: class extends Error {},
}));

import { NATIVE_PLATFORM_READ_TOOL_NAMES } from "../../../../lib/native-platform-read-config";
import {
	executeNativePlatformRead,
	NATIVE_PLATFORM_READ_DEFINITIONS,
} from "../../../shared/native-platform-read-registry";
import { executeNativePlatformReadStep } from "../native-platform-read";

const config = { toolName: "fabric_list_project_pm_members", arguments: "{}" };
const params = {
	userId: "owner",
	organizationId: "example-org",
	workflowId: "workflow",
	executionId: "execution",
	nodeId: "native",
	projectId: "project",
	nodeConfig: config,
	inputs: {},
};
const connection = {
	status: "ready",
	provider: "azure-devops",
	target: {
		organization: "example-org",
		projectId: "connected-project",
		projectName: "Example",
	},
	pat: "example-private-credential",
};
const asOf = "2026-01-01T12:00:00.0001234Z";

function published(next = config) {
	mocks.version.mockResolvedValue({
		nodes: [
			{
				id: "native",
				type: "native-platform-read",
				data: { config: next },
			},
		],
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.permission.mockResolvedValue(true);
	mocks.access.mockResolvedValue(true);
	mocks.execution.mockResolvedValue({
		id: "execution",
		workflowId: "workflow",
		version: 3,
		triggerType: "SCHEDULE",
	});
	published();
	mocks.resolve.mockResolvedValue(connection);
	mocks.members.mockResolvedValue({
		members: [],
		complete: true,
		membershipScope: "project_teams",
	});
	mocks.counts.mockResolvedValue({
		total: null,
		matchingState: 2,
		complete: false,
		observed: { total: 10, matchingState: 2 },
	});
	mocks.types.mockResolvedValue({
		workItemTypes: [],
		complete: false,
		incompleteReason: "response_limit",
	});
	mocks.assigned.mockResolvedValue({
		ids: [1],
		requirementsAsOf: asOf,
		complete: false,
		cursor: { afterId: 1, requirementsAsOf: asOf },
		incompleteReason: "item_limit",
	});
	mocks.snapshots.mockResolvedValue({
		snapshots: [],
		unreadIds: [1],
		requirementsAsOf: asOf,
		complete: false,
		incompleteReason: "unavailable",
	});
});

describe("native platform read graph step", () => {
	it("uses the immutable configuration and server actor/project with the real shared reader", async () => {
		expect(
			await executeNativePlatformReadStep({
				...params,
				inputs: { userId: "forged", projectId: "forged" },
			}),
		).toEqual({
			success: true,
			output: {
				result: {
					status: "ready",
					provider: "azure-devops",
					target: connection.target,
					members: [],
					complete: true,
					membershipScope: "project_teams",
				},
			},
		});
		expect(mocks.resolve).toHaveBeenCalledWith({
			userId: "owner",
			organizationId: "example-org",
			projectId: "project",
		});
		expect(mocks.members).toHaveBeenCalledWith(
			connection.target,
			connection.pat,
		);
		expect(mocks.execution.mock.calls[0][0].where).toEqual({
			id: "execution",
			workflowId: "workflow",
			userId: "owner",
			organizationId: "example-org",
			workflow: {
				userId: "owner",
				organizationId: "example-org",
				projectId: "project",
			},
		});
		expect(mocks.version.mock.calls[0][0].where).toEqual({
			workflowId: "workflow",
			version: 3,
			isPublished: true,
			userId: "owner",
			organizationId: "example-org",
		});
	});

	it.each(["MANUAL", "SCHEDULE"])(
		"supports %s execution without an acting gateway grant",
		async (triggerType) => {
			mocks.execution.mockResolvedValue({
				id: "execution",
				workflowId: "workflow",
				version: 3,
				triggerType,
			});
			expect((await executeNativePlatformReadStep(params)).success).toBe(
				true,
			);
		},
	);

	it.each(["permission", "access"] as const)(
		"rechecks current %s before any credential lookup",
		async (permission) => {
			mocks[permission].mockResolvedValue(false);
			expect((await executeNativePlatformReadStep(params)).success).toBe(
				false,
			);
			expect(mocks.resolve).not.toHaveBeenCalled();
		},
	);

	it("refuses absent or foreign execution and absent published snapshots", async () => {
		mocks.execution.mockResolvedValue(null);
		expect((await executeNativePlatformReadStep(params)).success).toBe(
			false,
		);
		expect(mocks.resolve).not.toHaveBeenCalled();
		mocks.execution.mockResolvedValue({ version: 3 });
		mocks.version.mockResolvedValue(null);
		expect((await executeNativePlatformReadStep(params)).success).toBe(
			false,
		);
		expect(mocks.resolve).not.toHaveBeenCalled();
	});

	it("refuses missing authority and changed published arguments or tool", async () => {
		for (const override of [
			{ organizationId: undefined },
			{ projectId: undefined },
			{ executionId: undefined },
			{ workflowId: undefined },
			{ nodeId: undefined },
			{ nodeConfig: { ...config, arguments: '{"projectId":"other"}' } },
			{
				nodeConfig: {
					...config,
					toolName: "fabric_get_project_pm_connection",
				},
			},
			{ nodeConfig: { ...config, userId: "forged" } },
		]) {
			expect(
				(
					await executeNativePlatformReadStep({
						...params,
						...override,
					})
				).success,
			).toBe(false);
		}
		expect(mocks.resolve).not.toHaveBeenCalled();
	});

	it.each([
		'{"projectId":"other"}',
		'{"organizationId":"other"}',
		'{"userId":"other"}',
		'{"pat":"secret"}',
		'{"url":"https://example.com"}',
		"[]",
		"null",
		"not-json",
		"{{Missing.result}}",
	])(
		"refuses conflicting/undeclared authority, invalid JSON or unresolved args: %s",
		async (args) => {
			const next = { ...config, arguments: args };
			published(next);
			expect(
				(
					await executeNativePlatformReadStep({
						...params,
						nodeConfig: next,
					})
				).success,
			).toBe(false);
			expect(mocks.resolve).not.toHaveBeenCalled();
		},
	);

	it("accepts a complete JSON-object reference without interpolating any source", async () => {
		const next = {
			...config,
			toolName: "fabric_get_project_work_item_counts",
			arguments: "{{Prepare.result}}",
		};
		published(next);
		const result = await executeNativePlatformReadStep({
			...params,
			nodeConfig: next,
			inputs: {
				Prepare: {
					result: {
						state: "In Development",
						assignee: 'member"name@example.com',
						projectId: "project",
					},
				},
			},
		});
		expect(result).toMatchObject({
			success: true,
			output: {
				result: {
					complete: false,
					total: null,
					observed: { total: 10 },
				},
			},
		});
		expect(mocks.counts).toHaveBeenCalledWith(
			connection.target,
			connection.pat,
			{
				projectId: "project",
				state: "In Development",
				assignee: 'member"name@example.com',
			},
		);
	});

	it("bounds interpolated arguments before connection lookup", async () => {
		const next = { ...config, arguments: "{{Prepare.result}}" };
		published(next);
		expect(
			(
				await executeNativePlatformReadStep({
					...params,
					nodeConfig: next,
					inputs: {
						Prepare: { result: { text: "x".repeat(16384) } },
					},
				})
			).success,
		).toBe(false);
		expect(mocks.resolve).not.toHaveBeenCalled();
	});

	it("does not turn unavailable connection status or partial capture into complete data", async () => {
		mocks.resolve.mockResolvedValueOnce({
			status: "not_connected",
			message: "Reconnect your account.",
		});
		expect(await executeNativePlatformReadStep(params)).toEqual({
			success: true,
			output: {
				result: {
					status: "not_connected",
					message: "Reconnect your account.",
				},
			},
		});
		expect(mocks.members).not.toHaveBeenCalled();
	});

	it("does not disclose credentials or unexpected resolver/provider failures", async () => {
		for (const source of [mocks.resolve, mocks.members]) {
			source.mockRejectedValueOnce(new Error(connection.pat));
			const result = await executeNativePlatformReadStep(params);
			expect(result.success).toBe(false);
			expect(JSON.stringify(result)).not.toContain(connection.pat);
		}
	});

	it("fails rather than silently truncating an oversized non-snapshot result", async () => {
		mocks.members.mockResolvedValue({
			members: [{ name: "x".repeat(128 * 1024) }],
			complete: true,
		});
		expect(await executeNativePlatformReadStep(params)).toMatchObject({
			success: false,
			error: expect.stringContaining("128 KiB"),
		});
	});
	it("preserves whole-item snapshot truncation and unread IDs through the actual registry", async () => {
		const next = {
			toolName: "fabric_get_project_pm_item_snapshots",
			arguments: JSON.stringify({ ids: [1], requirementsAsOf: asOf }),
		};
		published(next);
		mocks.snapshots.mockResolvedValue({
			snapshots: [
				{
					id: 1,
					requirements: {
						"System.Description": "x".repeat(128 * 1024),
					},
				},
			],
			unreadIds: [],
			requirementsAsOf: asOf,
			complete: true,
			incompleteReason: null,
		});
		expect(
			await executeNativePlatformReadStep({
				...params,
				nodeConfig: next,
			}),
		).toMatchObject({
			success: true,
			output: {
				result: {
					snapshots: [],
					unreadIds: [1],
					complete: false,
					resultTruncated: true,
					incompleteReason: "response_limit",
				},
			},
		});
	});
});

describe("explicit read-only registry and shared service", () => {
	it("registers exactly the six declared read-only tools", () => {
		expect(
			NATIVE_PLATFORM_READ_DEFINITIONS.map((tool) => tool.name).sort(),
		).toEqual([...NATIVE_PLATFORM_READ_TOOL_NAMES].sort());
		expect(
			NATIVE_PLATFORM_READ_DEFINITIONS.every(
				(tool) => tool.annotations.readOnlyHint === true,
			),
		).toBe(true);
	});

	it.each([
		"fabric_delete_frame",
		"fabric_create_workflow",
		"connected:azure-devops/update",
		"unknown",
	])("refuses unregistered/write tool %s", async (name) => {
		expect(
			(
				await executeNativePlatformRead(
					name,
					{ projectId: "project" },
					{ userId: "owner", organizationId: "example-org" },
				)
			).success,
		).toBe(false);
		expect(mocks.resolve).not.toHaveBeenCalled();
	});

	it.each(NATIVE_PLATFORM_READ_TOOL_NAMES)(
		"uses the shared service for %s with raw completeness signals and no PAT",
		async (name) => {
			const input =
				name === "fabric_get_project_pm_item_snapshots"
					? { projectId: "project", ids: [1], requirementsAsOf: asOf }
					: { projectId: "project" };
			const result = await executeNativePlatformRead(name, input, {
				userId: "owner",
				organizationId: "example-org",
			});
			expect(result.success).toBe(true);
			expect(JSON.stringify(result)).not.toContain(connection.pat);
			if (
				result.success &&
				name === "fabric_list_project_pm_assigned_items"
			) {
				expect(result.result).toMatchObject({
					complete: false,
					cursor: { afterId: 1, requirementsAsOf: asOf },
				});
				expect(mocks.assigned).toHaveBeenCalledWith(
					connection.target,
					connection.pat,
					{
						projectId: "project",
						assignee: { mode: "current" },
						workItemTypes: ["User Story"],
						limit: 50,
					},
				);
			}
			if (
				result.success &&
				name === "fabric_get_project_pm_item_snapshots"
			) {
				expect(result.result).toMatchObject({
					complete: false,
					unreadIds: [1],
					resultTruncated: false,
					incompleteReason: "unavailable",
				});
			}
		},
	);

	it.each(["not_found", "forbidden"])(
		"preserves safe access refusal %s",
		async (status) => {
			mocks.resolve.mockResolvedValue({
				status,
				message: "Access denied",
			});
			expect((await executeNativePlatformReadStep(params)).success).toBe(
				false,
			);
			expect(mocks.members).not.toHaveBeenCalled();
		},
	);
});
