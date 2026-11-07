import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

const m = vi.hoisted(() => ({
	access: vi.fn(),
	first: vi.fn(),
	many: vi.fn(),
	start: vi.fn(),
	get: vi.fn(),
	messages: vi.fn(),
	servers: vi.fn(),
	visible: vi.fn(),
}));
vi.mock("@repo/database", () => ({
	hasProjectAccess: m.visible,
	db: {
		projectRemoteAgentServer: { findMany: m.servers },
		codingRun: { findFirst: m.first, findMany: m.many },
	},
}));
vi.mock("../commands-access", () => ({ requireCodingRunProject: m.access }));
vi.mock("../../procedures/start-coding-run", () => ({
	startCodingRunInput: z.object({
		projectId: z.string(),
		storyId: z.string(),
		requestId: z.uuid().optional(),
		organizationId: z.string().optional(),
		provider: z.string().optional(),
		executionChannel: z.string().optional(),
	}),
	startCodingRun: m.start,
}));
vi.mock("../../procedures/get-coding-run", () => ({
	getCodingRunCommand: m.get,
}));
vi.mock("../../procedures/session-messages", () => ({
	readCodingRunMessages: m.messages,
}));
vi.mock("../../procedures/cancel-coding-run", () => ({
	cancelCodingRun: vi.fn(),
}));
vi.mock("../../procedures/send-follow-up", () => ({
	codingRunFollowUpInput: z.object({
		id: z.string(),
		message: z.string(),
		promptId: z.string().optional(),
		organizationId: z.string().optional(),
	}),
	sendCodingRunFollowUp: vi.fn(),
}));

import {
	getImplementationMessages,
	getImplementationSession,
	implementationProjection,
	listImplementationSessions,
	startImplementationSession,
} from "../implementation-commands";

const actor = { userId: "example-user", organizationId: "example-org" };
const date = new Date("2026-11-01T00:00:00Z");
const row = {
	id: "example-run",
	projectId: "example-project",
	storyId: "example-story",
	storyTaskId: null,
	status: "COMPLETED",
	kind: "IMPLEMENT",
	createdAt: date,
	startedAt: date,
	mergedAt: date,
	pullRequestNumber: 7,
	providerMetadata: { apiKey: "never-returned" },
	events: ["private events"],
};
beforeEach(() => {
	vi.clearAllMocks();
	m.access.mockResolvedValue("example-org");
	m.visible.mockResolvedValue(true);
	m.servers.mockResolvedValue([]);
	m.first.mockResolvedValue({ id: "example-run" });
	m.many.mockResolvedValue([row]);
	m.get.mockResolvedValue(row);
});
describe("canonical implementation command projections", () => {
	it("never exposes provider metadata or infers deployed from merged", () => {
		const result = implementationProjection(row);
		expect(result).toMatchObject({
			deliveryEvidence: "PR_MERGED",
			deployment: "UNKNOWN",
			externalAgentCost: "NOT_REPORTED",
		});
		expect(JSON.stringify(result)).not.toMatch(
			/never-returned|private events|providerMetadata/,
		);
	});
	it("shares authorized project progress but never another private host or raw provider metadata", async () => {
		m.many.mockResolvedValue([
			{
				...row,
				providerMetadata: {
					executionRuntime: "fabric-agent-server",
					executionTarget: { connectionId: "example-private" },
					secret: "private-credential",
				},
				externalUrl: "https://private.example.com",
				providerSessionId: "private-session",
				events: ["private-log"],
			},
		]);
		const result = await listImplementationSessions(actor, {
			projectId: "example-project",
		});
		expect(result.sessions[0]).toMatchObject({
			id: "example-run",
			status: "COMPLETED",
			pullRequestNumber: 7,
		});
		expect(m.servers).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					OR: [{ userId: "example-user" }, { scope: "TEAM" }],
				}),
			}),
		);
		expect(JSON.stringify(result)).not.toMatch(
			/private-credential|private-session|private-log|private.example|providerMetadata/,
		);
	});
	it("binds object reads to the selected current project and tenant", async () => {
		await getImplementationSession(actor, {
			projectId: "example-project",
			id: "example-run",
		});
		expect(m.first).toHaveBeenCalledWith({
			where: {
				id: "example-run",
				projectId: "example-project",
				organizationId: "example-org",
			},
			select: { id: true },
		});
		m.first.mockResolvedValue(null);
		await expect(
			getImplementationSession(actor, {
				projectId: "other-project",
				id: "example-run",
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(m.get).toHaveBeenCalledOnce();
	});
	it("validates cursor authority before scanning a page", async () => {
		m.first.mockResolvedValue(null);
		await expect(
			listImplementationSessions(actor, {
				projectId: "example-project",
				cursor: "other-run",
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(m.many).not.toHaveBeenCalled();
	});
	it("returns a resumable bounded page without private columns", async () => {
		m.many.mockResolvedValue([row, { ...row, id: "next-run" }]);
		const result = await listImplementationSessions(actor, {
			projectId: "example-project",
			limit: 1,
		});
		expect(result).toMatchObject({
			hasMore: true,
			nextCursor: "example-run",
		});
		expect(result.sessions).toHaveLength(1);
		expect(m.many.mock.calls[0][0]).toMatchObject({
			take: 2,
			where: {
				projectId: "example-project",
				organizationId: "example-org",
			},
		});
		expect(JSON.stringify(result)).not.toContain("never-returned");
	});
	it("bounds conversation text and signals truncation, excluding private URLs", async () => {
		m.messages.mockResolvedValue({
			available: true,
			messages: Array.from({ length: 41 }, (_, i) => ({
				id: `message-${i}`,
				role: "assistant",
				content: "x".repeat(16001),
				privateUrl: "private-endpoint",
			})),
			webUrl: "private-endpoint",
		});
		const result = await getImplementationMessages(actor, {
			projectId: "example-project",
			id: "example-run",
		});
		expect(result.messages).toHaveLength(40);
		expect(result.messages[0].content).toHaveLength(16000);
		expect(result.truncated).toBe(true);
		expect(JSON.stringify(result)).not.toContain("private-endpoint");
	});
	it("requires external stable request UUID and audits IDs before canonical dispatch", async () => {
		const audit = vi.fn();
		await expect(
			startImplementationSession(
				actor,
				{ projectId: "example-project", storyId: "example-story" },
				audit,
			),
		).rejects.toBeInstanceOf(z.ZodError);
		expect(m.start).not.toHaveBeenCalled();
		await startImplementationSession(
			actor,
			{
				projectId: "example-project",
				storyId: "example-story",
				requestId: "00000000-0000-4000-8000-000000000001",
			},
			audit,
		);
		expect(audit).toHaveBeenCalledWith(
			expect.objectContaining({
				action: "project.coding_run.start_requested",
				category: "project",
				metadata: {
					requestId: "00000000-0000-4000-8000-000000000001",
					storyId: "example-story",
					taskId: null,
				},
			}),
		);
		expect(m.start).toHaveBeenCalledOnce();
	});
});
