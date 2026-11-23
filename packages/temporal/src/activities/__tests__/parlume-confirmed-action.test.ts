import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { parlumeToolFingerprint } from "../parlume-action-policy";

const mocks = vi.hoisted(() => ({
	action: null as Record<string, unknown> | null,
	session: { id: "session" } as Record<string, unknown> | null,
	canEdit: true,
	execute: vi.fn(),
	callAuthorized: vi.fn(),
	closePlatform: vi.fn(),
	loadPlatform: vi.fn(),
	createFabricTool: vi.fn(),
	post: vi.fn(),
	updateMany: vi.fn(),
	recordAudit: vi.fn(),
	approved: [] as unknown[],
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeAction: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) =>
					mocks.action && mocks.action.status === where.status
						? structuredClone(mocks.action)
						: null,
			),
			updateMany: mocks.updateMany,
		},
		parlumeMeetingSession: {
			findFirst: vi.fn(async () => mocks.session),
		},
		user: {
			findUnique: vi.fn(async () => ({
				name: "Maya",
				email: "maya@example.com",
			})),
		},
		project: {
			findUnique: vi.fn(async () => ({ name: "Example project" })),
		},
	},
	buildParlumeActionUrl: vi.fn(
		async ({ actionId }: { actionId: string }) =>
			`https://app.example.com/app/example-org/projects/project/parlume/actions/${actionId}`,
	),
	canEditProject: vi.fn(async () => mocks.canEdit),
	recordAudit: mocks.recordAudit,
}));
vi.mock("../direct-chat/built-in-tools", () => ({
	createFabricTool: mocks.createFabricTool,
}));
vi.mock("../shared/fabric-platform-mcp", () => ({
	loadFabricPlatformTools: mocks.loadPlatform,
}));
vi.mock("../parlume-voice", () => ({
	postParlumeMeetingChat: mocks.post,
}));

import {
	executeConfirmedParlumeAction,
	failConfirmedParlumeAction,
} from "../parlume-confirmed-action";
import { hasExactAgentToolApproval } from "../shared/agent-tool-runtime";

const builtInTool = {
	description: "Create a feature",
	inputSchema: z.object({ title: z.string() }),
	execute: mocks.execute,
};
const platformTool = {
	description: "Update a feature's status",
	inputSchema: { type: "object", properties: {} },
	execute: vi.fn(),
};

function confirmedAction(overrides: Record<string, unknown> = {}) {
	const source = {
		configId: "builtin",
		originalName: "fabric_create_story",
	};
	return {
		id: "action-1",
		sessionId: "session",
		projectId: "project",
		organizationId: "org",
		userId: "inviter",
		decidedByUserId: "member",
		toolName: "fabric_create_story",
		toolConfigId: source.configId,
		toolOriginalName: source.originalName,
		toolFingerprint: parlumeToolFingerprint({
			name: "fabric_create_story",
			...builtInTool,
			source,
		}),
		arguments: { title: "Export to CSV" },
		summary: "Create feature “Export to CSV”",
		chatTag: "P8",
		status: "EXECUTING",
		startedAt: null,
		...overrides,
	};
}

function posted(): string[] {
	return mocks.post.mock.calls.map(([input]) => String(input.message));
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.action = confirmedAction();
	mocks.session = { id: "session" };
	mocks.canEdit = true;
	mocks.approved = [];
	mocks.createFabricTool.mockResolvedValue({
		fabric_create_story: builtInTool,
	});
	mocks.execute.mockImplementation(async () => {
		mocks.approved.push(
			hasExactAgentToolApproval({
				configId: "builtin",
				originalName: "fabric_create_story",
				userId: "member",
				organizationId: "org",
				args: { title: "Export to CSV" },
			}),
		);
		return {
			storyId: "story-1",
			identifier: "F-231",
			url: "https://app.example.com/app/example-org/projects/project/stories/story-1",
		};
	});
	mocks.post.mockResolvedValue({ sent: true, tag: "P9" });
	mocks.updateMany.mockImplementation(
		async ({
			where,
			data,
		}: {
			where: Record<string, unknown>;
			data: Record<string, unknown>;
		}) => {
			const action = mocks.action;
			if (
				!action ||
				Object.entries(where).some(
					([key, value]) => action[key] !== value,
				)
			) {
				return { count: 0 };
			}
			Object.assign(action, data);
			return { count: 1 };
		},
	);
});

describe("a change a member confirmed", () => {
	it("runs once as the confirming member, records it done and posts one done line", async () => {
		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.createFabricTool).toHaveBeenCalledWith(
			"fabric_create_story",
			expect.objectContaining({ userId: "member", projectId: "project" }),
		);
		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.approved).toEqual([true]);
		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "action-1", status: "EXECUTING" },
			data: expect.objectContaining({ status: "COMPLETED" }),
		});
		expect(posted()).toEqual([
			[
				"**Done** · Maya confirmed P8",
				"Create feature “Export to CSV”",
				// The request may have asked for more than this one change:
				// syncing and assigning are named as not done.
				"Only this change was made. Anything else the request asked for, such as syncing it to a PM tool or assigning it, is not done.",
				"[Open F-231](https://app.example.com/app/example-org/projects/project/stories/story-1)",
			].join("\n"),
		]);
	});

	it("names a plain-number item with its kind in the done line", async () => {
		mocks.execute.mockResolvedValue({
			storyId: "story-3",
			identifier: "3",
			kind: "FEATURE",
			title: "Export to CSV",
			url: "https://app.example.com/app/example-org/projects/project/stories/story-3",
		});

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(posted()[0]).toContain(
			"[Open feature 3](https://app.example.com/app/example-org/projects/project/stories/story-3)",
		);
	});

	it("posts one not-made line when the change fails", async () => {
		mocks.execute.mockResolvedValue({ error: "Titles must be unique." });

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
		expect(posted()).toEqual([
			[
				"**Change not made** · P8",
				"Create feature “Export to CSV” in Example project",
				"Titles must be unique.",
				"[Details](https://app.example.com/app/example-org/projects/project/parlume/actions/action-1)",
			].join("\n"),
		]);
	});

	it("does not run, and says so, when the member can no longer edit the project", async () => {
		mocks.canEdit = false;

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(posted()[0]).toContain("cannot edit this project");
	});

	it("does not run a tool that changed since it was proposed", async () => {
		mocks.createFabricTool.mockResolvedValue({
			fabric_create_story: {
				...builtInTool,
				description: "Create a feature, differently",
			},
		});

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.updateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "FAILED" }),
			}),
		);
	});

	it("runs nothing and posts nothing for a dismissed or expired proposal", async () => {
		for (const status of ["CANCELLED", "EXPIRED", "PROPOSED"]) {
			mocks.action = confirmedAction({ status });

			await executeConfirmedParlumeAction({ actionId: "action-1" });

			expect(mocks.action).toMatchObject({ status, startedAt: null });
		}

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
	});

	it("claims the change before it acts", async () => {
		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.updateMany).toHaveBeenNthCalledWith(1, {
			where: { id: "action-1", status: "EXECUTING", startedAt: null },
			data: { startedAt: expect.any(Date) },
		});
		expect(mocks.updateMany.mock.invocationCallOrder[0]).toBeLessThan(
			mocks.execute.mock.invocationCallOrder[0] ?? 0,
		);
		expect(mocks.action).toMatchObject({
			status: "COMPLETED",
			startedAt: expect.any(Date),
		});
	});

	it("does nothing when another run already claimed the change", async () => {
		const claimedAt = new Date("2026-11-19T10:00:00Z");
		mocks.action = confirmedAction({ startedAt: claimedAt });

		await executeConfirmedParlumeAction({ actionId: "action-1" });
		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.execute).not.toHaveBeenCalled();
		expect(mocks.post).not.toHaveBeenCalled();
		expect(mocks.action).toMatchObject({
			status: "EXECUTING",
			startedAt: claimedAt,
		});
	});

	it("records the outcome but posts nothing once the meeting has ended", async () => {
		mocks.session = null;

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.execute).toHaveBeenCalledTimes(1);
		expect(mocks.post).not.toHaveBeenCalled();
	});

	it("runs a Fabric MCP change through a gateway opened as the member with the member's grant", async () => {
		const source = {
			configId: "fabric-platform",
			originalName: "fabric_update_feature_status",
		};
		mocks.action = confirmedAction({
			toolName: source.originalName,
			toolConfigId: source.configId,
			toolOriginalName: source.originalName,
			toolFingerprint: parlumeToolFingerprint({
				name: source.originalName,
				...platformTool,
				source,
			}),
			arguments: { featureId: "feature-1", status: "IN_REVIEW" },
		});
		mocks.callAuthorized.mockResolvedValue({ success: true });
		mocks.loadPlatform.mockResolvedValue({
			tools: { fabric_update_feature_status: platformTool },
			callAuthorized: mocks.callAuthorized,
			close: mocks.closePlatform,
		});

		await executeConfirmedParlumeAction({
			actionId: "action-1",
			actingGrant: "member-grant",
		});

		expect(mocks.loadPlatform).toHaveBeenCalledWith(
			expect.objectContaining({
				userId: "member",
				actingGrant: "member-grant",
				projectId: "project",
				surface: "parlume",
			}),
			{ portal: { offer: true } },
		);
		expect(mocks.callAuthorized).toHaveBeenCalledWith(
			"fabric_update_feature_status",
			{ featureId: "feature-1", status: "IN_REVIEW" },
		);
		expect(mocks.closePlatform).toHaveBeenCalled();
		expect(posted()[0]).toContain("**Done** · Maya confirmed P8");
	});

	it("audits a made change as Fabric Parlume acting for the confirming member", async () => {
		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith({
			action: "project.parlume.action_executed",
			category: "project",
			outcome: "success",
			actor: {
				type: "agent",
				userId: "member",
				nameSnapshot: "Fabric Parlume",
				emailSnapshot: "maya@example.com",
			},
			organizationId: "org",
			projectId: "project",
			resource: {
				type: "parlume_action",
				id: "action-1",
				name: "Create feature “Export to CSV”",
			},
			metadata: {
				status: "COMPLETED",
				toolName: "fabric_create_story",
				sessionId: "session",
				chatTag: "P8",
				invitedBy: "inviter",
				itemId: "story-1",
				itemKind: null,
				itemNumber: "F-231",
			},
		});
	});

	it("audits a refused change as a failure, without its reason", async () => {
		mocks.canEdit = false;

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.recordAudit).toHaveBeenCalledTimes(1);
		expect(mocks.recordAudit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.parlume.action_executed",
				outcome: "failure",
				actor: {
					type: "agent",
					userId: "member",
					nameSnapshot: "Fabric Parlume",
					emailSnapshot: "maya@example.com",
				},
				resource: expect.objectContaining({
					type: "parlume_action",
					id: "action-1",
				}),
				metadata: {
					status: "FAILED",
					toolName: "fabric_create_story",
					sessionId: "session",
					chatTag: "P8",
					invitedBy: "inviter",
				},
			}),
		);
	});

	it("writes no audit row when the outcome was already recorded by another run", async () => {
		mocks.execute.mockImplementation(async () => {
			await failConfirmedParlumeAction({ actionId: "action-1" });
			return {
				storyId: "story-1",
				identifier: "F-231",
				url: "https://app.example.com/app/example-org/projects/project/stories/story-1",
			};
		});

		await executeConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.updateMany).toHaveLastResolvedWith({ count: 0 });
		expect(mocks.action).toMatchObject({ status: "OUTCOME_UNKNOWN" });
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	it("records a run that stopped as of unknown outcome", async () => {
		await failConfirmedParlumeAction({ actionId: "action-1" });

		expect(mocks.updateMany).toHaveBeenCalledWith({
			where: { id: "action-1", status: "EXECUTING" },
			data: expect.objectContaining({ status: "OUTCOME_UNKNOWN" }),
		});
	});
});
