import { beforeEach, describe, expect, it, vi } from "vitest";
import type { z } from "zod";

const mocks = vi.hoisted(() => ({ count: vi.fn(), list: vi.fn() }));
vi.mock("@repo/database", async () => {
	const { REVIEW_INBOX_PROPOSAL_STATUSES } = await import(
		"../../../../../../database/prisma/queries/projects/pending-backlog-proposals"
	);
	return {
		REVIEW_INBOX_PROPOSAL_STATUSES,
		countPendingBacklogProposals: mocks.count,
		listPendingBacklogProposals: mocks.list,
	};
});
vi.mock("../../../../../../database/prisma/client", () => ({ db: {} }));
vi.mock("../../../../../orpc/procedures", () => {
	const chain = {
		use: () => chain,
		route: () => chain,
		input: (schema: z.ZodType) => ({
			handler:
				(fn: (args: { input: unknown }) => unknown) =>
				(input: unknown) =>
					fn({ input: schema.parse(input) }),
		}),
	};
	return {
		tenantProtectedProcedure: chain,
		Permissions: { PROJECT_READ: "project:read" },
		requireProjectPermission: () => undefined,
	};
});

import { countPendingProposalsProcedure as slackCount } from "../../slack-channel-monitor/count-pending-proposals";
import { listPendingProposalsProcedure as slackList } from "../../slack-channel-monitor/list-pending-proposals";
import { countPendingProposalsProcedure as chatCount } from "../../teams-chat-monitor/count-pending-proposals";
import { listPendingProposalsProcedure as chatList } from "../../teams-chat-monitor/list-pending-proposals";
import { countPendingProposalsProcedure as channelCount } from "../count-pending-proposals";
import { listPendingProposalsProcedure as channelList } from "../list-pending-proposals";

beforeEach(() => {
	vi.clearAllMocks();
	mocks.count.mockResolvedValue(2);
	mocks.list.mockResolvedValue([]);
});
describe.each([
	["Teams channel", channelCount, channelList],
	["Teams chat", chatCount, chatList],
	["Slack", slackCount, slackList],
])("%s review inbox", (_name, count, list) => {
	it("counts and lists the shared review set by default", async () => {
		await (count as unknown as (input: unknown) => unknown)({
			projectId: "example-project",
		});
		await (list as unknown as (input: unknown) => unknown)({
			projectId: "example-project",
		});
		const statuses = ["PENDING", "APPROVED", "APPLYING", "FAILED"];
		expect(mocks.count).toHaveBeenCalledWith("example-project", statuses);
		expect(mocks.list).toHaveBeenCalledWith({
			projectId: "example-project",
			status: statuses,
		});
		expect(mocks.count.mock.calls[0][1]).toBe(
			mocks.list.mock.calls[0][0].status,
		);
	});
	it("accepts an explicit APPLYING filter", async () => {
		await (list as unknown as (input: unknown) => unknown)({
			projectId: "example-project",
			status: ["APPLYING"],
		});
		expect(mocks.list).toHaveBeenCalledWith({
			projectId: "example-project",
			status: ["APPLYING"],
		});
	});
});
