import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const mocks = {
		realtimeDeployment: vi.fn(),
		projectFindFirst: vi.fn(),
		agentFindMany: vi.fn(),
		agentFindFirst: vi.fn(),
		sessionFindMany: vi.fn(),
		transaction: vi.fn(),
		executeRaw: vi.fn(),
		sessionCount: vi.fn(),
		sessionFindFirst: vi.fn(),
		sessionFindUniqueOrThrow: vi.fn(),
		sessionCreate: vi.fn(),
		sessionUpdate: vi.fn(),
		sessionUpdateMany: vi.fn(),
		linkedFindFirst: vi.fn(),
		linkedFindMany: vi.fn(),
		integration: vi.fn(),
		graph: vi.fn(),
		isFeatureEnabled: vi.fn(),
		resolveVoiceKey: vi.fn(),
		speechModel: vi.fn(),
		getSettings: vi.fn(),
		armBridge: vi.fn(),
		chatTagStart: vi.fn(),
		isTeamsMeetingUrl: vi.fn(),
		startBot: vi.fn(),
		leaveBot: vi.fn(),
		noteLeaving: vi.fn(),
		finalize: vi.fn(),
		recordAudit: vi.fn(),
		contextFindMany: vi.fn(),
		azure: vi.fn(),
		attendee: vi.fn(),
		membership: vi.fn(),
		managesTranscripts: vi.fn(),
		readerEmail: vi.fn(),
		mayPropose: vi.fn(),
		notifyJoinFailure: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		$transaction: (...args: unknown[]) => mocks.transaction(...args),
		$executeRaw: (...args: unknown[]) => mocks.executeRaw(...args),
		project: {
			findFirst: (...args: unknown[]) => mocks.projectFindFirst(...args),
		},
		agentTemplateInstance: {
			findMany: (...args: unknown[]) => mocks.agentFindMany(...args),
			findFirst: (...args: unknown[]) => mocks.agentFindFirst(...args),
		},
		parlumeMeetingSession: {
			findMany: (...args: unknown[]) => mocks.sessionFindMany(...args),
			count: (...args: unknown[]) => mocks.sessionCount(...args),
			findFirst: (...args: unknown[]) => mocks.sessionFindFirst(...args),
			findUniqueOrThrow: (...args: unknown[]) =>
				mocks.sessionFindUniqueOrThrow(...args),
			create: (...args: unknown[]) => mocks.sessionCreate(...args),
			update: (...args: unknown[]) => mocks.sessionUpdate(...args),
			updateMany: (...args: unknown[]) =>
				mocks.sessionUpdateMany(...args),
		},
		projectContext: {
			findMany: (...args: unknown[]) => mocks.contextFindMany(...args),
		},
		projectLinkedMeeting: {
			findFirst: (...args: unknown[]) => mocks.linkedFindFirst(...args),
			findMany: (...args: unknown[]) => mocks.linkedFindMany(...args),
		},
	},
	isFeatureEnabled: (...args: unknown[]) => mocks.isFeatureEnabled(...args),
	getOrganizationMembership: (...args: unknown[]) =>
		mocks.membership(...args),
	getBuiltInToolConfig: (connections: Record<string, unknown>, key: string) =>
		connections[key] ?? null,
	resolveWorkflowIntegrationForProvider: (...args: unknown[]) =>
		mocks.integration(...args),
}));

vi.mock("@repo/integrations/microsoft", async (original) => ({
	...(await original<typeof import("@repo/integrations/microsoft")>()),
	executeMicrosoftTeamsTool: mocks.graph,
}));

vi.mock("@repo/ai", () => ({
	getAISpeechModel: (...args: unknown[]) => mocks.speechModel(...args),
	resolveAzureOpenAiResource: (...args: unknown[]) => mocks.azure(...args),
	resolveOpenAiApiKey: (...args: unknown[]) => mocks.resolveVoiceKey(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.recordAudit(...args),
}));

vi.mock("../../../lib/parlume-attendee", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../../lib/parlume-attendee")>()),
	armParlumeMeetingBridge: (...args: unknown[]) => mocks.armBridge(...args),
	getParlumeBridgeSettings: () => mocks.getSettings(),
	isTeamsMeetingUrl: (...args: unknown[]) => mocks.isTeamsMeetingUrl(...args),
	startParlumeMeetingBot: (...args: unknown[]) => mocks.startBot(...args),
	leaveParlumeMeetingBot: (...args: unknown[]) => mocks.leaveBot(...args),
	noteParlumeLeaving: (...args: unknown[]) => mocks.noteLeaving(...args),
}));

vi.mock("../../../lib/parlume-chat-tags", () => ({
	parlumeChatTagStart: (...args: unknown[]) => mocks.chatTagStart(...args),
}));

vi.mock("../../../lib/parlume-provider-settings", () => ({
	resolveParlumeAttendeeSettings: (...args: unknown[]) =>
		mocks.attendee(...args),
	attendeeSourceToStored: (source: string) => source.toUpperCase(),
	resolveParlumeRealtimeDeployment: (...args: unknown[]) =>
		mocks.realtimeDeployment(...args),
}));

vi.mock("../../../lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
}));

vi.mock("../../../lib/parlume-notices", () => ({
	notifyParlumeJoinFailure: (...args: unknown[]) =>
		mocks.notifyJoinFailure(...args),
}));

vi.mock("../../../lib/parlume-transcript-access", async (importOriginal) => ({
	...(await importOriginal<
		typeof import("../../../lib/parlume-transcript-access")
	>()),
	managesParlumeTranscripts: (...args: unknown[]) =>
		mocks.managesTranscripts(...args),
	parlumeReaderEmail: (...args: unknown[]) => mocks.readerEmail(...args),
}));

vi.mock("../../../lib/parlume-note-proposals", () => ({
	mayProposeParlumeActionItems: (...args: unknown[]) =>
		mocks.mayPropose(...args),
}));

vi.mock("../../../../../orpc/procedures", () => {
	const keys = ["listAgents", "listSessions", "start", "stop"];
	let index = 0;
	const chainable: Record<string, unknown> = {};
	Object.assign(chainable, {
		use: () => chainable,
		route: () => chainable,
		input: () => chainable,
		handler: (handler: (...args: never[]) => Promise<unknown>) => {
			handlers[keys[index++]] = handler;
			return { _handler: handler };
		},
	});
	return {
		tenantProtectedProcedure: chainable,
		Permissions: {
			PROJECT_READ: "read",
			PROJECT_MEMBERS_MANAGE: "members:manage",
		},
		requireProjectPermission: () => chainable,
	};
});

await import("../sessions");
const { PARLUME_VOICE_REQUIRED } = await import(
	"../../../lib/parlume-readiness"
);
const { ParlumeProviderError } = await import("../../../lib/parlume-attendee");
const { startParlumeMeetingSession } = await import(
	"../../../lib/parlume-start"
);
const { db } = await import("@repo/database");

const context = {
	user: { id: "user-1", email: "dev@example.com", name: "Dev" },
	session: {},
};
const project = { id: "project-1", organizationId: "org-1" };
const agent = {
	id: "agent-version-2",
	sId: "agent-stable-1",
	name: "Release assistant",
	version: 2,
	toolConnections: { "project-context": { projectId: "project-1" } },
};
const session = {
	id: "session-1",
	agentKind: "TEMPLATE_INSTANCE",
	agentLabel: "Release assistant",
	agentInstanceSId: "agent-stable-1",
	status: "JOINING",
	wakePhrase: "Hey Fabric",
	toolsReadOnly: true,
	lastError: null,
	joinedAt: null,
	leaveRequestedAt: null,
	endedAt: null,
	createdAt: new Date(),
	updatedAt: new Date(),
};

const attendee = {
	apiKey: "org-key",
	baseUrl: "https://attendee.example.com",
	teamsLoginMode: null,
	webhookSecret: "org-webhook-secret",
	source: "organization",
};

beforeEach(() => {
	vi.resetAllMocks();
	mocks.mayPropose.mockResolvedValue(false);
	mocks.contextFindMany.mockResolvedValue([]);
	mocks.linkedFindFirst.mockResolvedValue(null);
	mocks.linkedFindMany.mockResolvedValue([]);
	mocks.integration.mockResolvedValue({ id: "example-integration" });
	mocks.sessionCount.mockResolvedValue(0);
	mocks.projectFindFirst.mockResolvedValue(project);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.resolveVoiceKey.mockResolvedValue("test-voice-key");
	mocks.speechModel.mockResolvedValue(null);
	mocks.azure.mockResolvedValue(null);
	mocks.attendee.mockResolvedValue(attendee);
	mocks.membership.mockResolvedValue({ role: "owner" });
	mocks.getSettings.mockReturnValue({
		bridgeUrl: "wss://bridge.example.com/live",
		callbackUrl: "https://fabric.example.com/api/internal/parlume/callback",
		serviceSecret: "service-secret",
	});
	mocks.armBridge.mockResolvedValue(undefined);
	mocks.chatTagStart.mockResolvedValue(4);
	mocks.isTeamsMeetingUrl.mockReturnValue(true);
	mocks.agentFindFirst.mockResolvedValue(agent);
	mocks.agentFindMany.mockResolvedValue([agent]);
	mocks.sessionCreate.mockResolvedValue({ id: "session-1" });
	mocks.sessionFindMany.mockResolvedValue([]);
	mocks.executeRaw.mockResolvedValue(1);
	mocks.transaction.mockImplementation(
		(run: (tx: unknown) => Promise<unknown>) => run(db),
	);
	mocks.sessionUpdateMany.mockResolvedValue({ count: 1 });
	mocks.sessionFindUniqueOrThrow.mockResolvedValue(session);
	mocks.sessionFindFirst.mockResolvedValue({
		id: "session-1",
		providerBotId: "provider-bot-1",
		status: "ACTIVE",
		streamClosedAt: null,
		streamGeneration: 1,
	});
	mocks.sessionUpdate.mockResolvedValue(session);
	mocks.startBot.mockResolvedValue("provider-bot-1");
	mocks.leaveBot.mockResolvedValue({ kind: "LEAVE_REQUESTED" });
	mocks.noteLeaving.mockResolvedValue(undefined);
	mocks.managesTranscripts.mockResolvedValue(false);
	mocks.readerEmail.mockResolvedValue(null);
	mocks.notifyJoinFailure.mockResolvedValue(undefined);
});

describe("Parlume session procedures", () => {
	it("hides the agent list while the org-scoped flag is off", async () => {
		mocks.isFeatureEnabled.mockResolvedValue(false);

		await expect(
			handlers.listAgents({ input: { projectId: "project-1" }, context }),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.agentFindMany).not.toHaveBeenCalled();
	});

	it("reports operator setup as unavailable without exposing configuration", async () => {
		mocks.resolveVoiceKey.mockResolvedValue(null);

		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as { operatorReady: boolean };

		expect(result.operatorReady).toBe(false);
	});

	it("names each missing setup item and whether the viewer can fix it", async () => {
		mocks.resolveVoiceKey.mockResolvedValue(null);
		mocks.attendee.mockResolvedValue(null);
		mocks.getSettings.mockReturnValue(null);
		mocks.membership.mockResolvedValue({ role: "member" });

		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as { operatorReady: boolean; readiness: unknown };

		expect(result.operatorReady).toBe(false);
		expect(result.readiness).toEqual({
			meetingBot: { ready: false, source: null, webhookSigned: false },
			voice: { ready: false, engine: null },
			platform: { ready: false },
			canConfigure: false,
		});
		expect(JSON.stringify(result)).not.toContain("org-key");
	});

	it("reads an unreadable meeting bot setting as missing instead of failing the page", async () => {
		mocks.attendee.mockRejectedValue(
			new Error(
				"PARLUME_ATTENDEE_TEAMS_LOGIN must be always or only_if_required.",
			),
		);

		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as { readiness: { meetingBot: unknown } };

		expect(result.readiness.meetingBot).toEqual({
			ready: false,
			source: null,
			webhookSigned: false,
		});
	});

	it("stays ready, with an unsigned-webhook advisory, while the meeting bot's project has no webhook secret", async () => {
		mocks.attendee.mockResolvedValue({ ...attendee, webhookSecret: null });

		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as { operatorReady: boolean; readiness: { meetingBot: unknown } };

		expect(result.operatorReady).toBe(true);
		expect(result.readiness.meetingBot).toEqual({
			ready: true,
			source: "organization",
			webhookSigned: false,
		});
		expect(JSON.stringify(result)).not.toContain("org-webhook-secret");
	});

	it("is ready with an Azure AI Foundry resource as the only voice provider", async () => {
		mocks.resolveVoiceKey.mockResolvedValue(null);
		mocks.realtimeDeployment.mockResolvedValue("gpt-realtime");
		mocks.azure.mockResolvedValue({
			origin: "https://example-resource.openai.azure.com",
			apiKey: "azure-key",
		});

		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as { operatorReady: boolean; readiness: unknown };

		expect(result.operatorReady).toBe(true);
		expect(result.readiness).toEqual({
			meetingBot: {
				ready: true,
				source: "organization",
				webhookSigned: true,
			},
			voice: { ready: true, engine: "realtime" },
			platform: { ready: true },
			canConfigure: true,
		});
		expect(mocks.speechModel).not.toHaveBeenCalled();
	});

	it("is ready with gateway speech even without a direct OpenAI key", async () => {
		mocks.resolveVoiceKey.mockResolvedValue(null);
		mocks.speechModel.mockResolvedValue({ modelId: "openai/tts-1" });

		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as { operatorReady: boolean };

		expect(result.operatorReady).toBe(true);
		expect(mocks.speechModel).toHaveBeenCalledWith({
			userId: context.user.id,
			organizationId: "org-1",
		});
	});

	it("keeps the legacy custom-agent list shape for tabs without the built-in option", async () => {
		const result = (await handlers.listAgents({
			input: { projectId: "project-1" },
			context,
		})) as {
			agents: Array<{ sId: string; name: string; kind: string }>;
		};

		expect(result.agents).toEqual([
			expect.objectContaining({
				sId: "agent-stable-1",
				name: "Release assistant",
				kind: "TEMPLATE_INSTANCE",
			}),
		]);
	});

	it("finalizes a verified completed bot only after its stream has drained", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "provider-bot-1",
			status: "ACTIVE",
			streamClosedAt: new Date(),
			streamGeneration: 2,
		});
		mocks.leaveBot.mockResolvedValue({
			kind: "TERMINAL",
			status: "completed",
		});

		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});

		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ streamGeneration: 2 }),
				data: expect.objectContaining({
					status: "LEAVING",
					terminalCallbackAt: expect.any(Date),
				}),
			}),
		);
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 2,
		});
	});

	it("preserves a verified failed bot while finalizing its drained transcript", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "provider-bot-1",
			status: "ACTIVE",
			streamClosedAt: new Date(),
			streamGeneration: 2,
		});
		mocks.leaveBot.mockResolvedValue({
			kind: "TERMINAL",
			status: "failed",
		});

		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});

		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			preserveFailure: true,
			expectedStreamGeneration: 2,
		});
	});

	it("does not overwrite a callback finalization that wins during provider leave", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "provider-bot-1",
			status: "ACTIVE",
			streamClosedAt: new Date(),
			streamGeneration: 2,
		});
		mocks.leaveBot.mockResolvedValue({
			kind: "TERMINAL",
			status: "completed",
		});
		mocks.sessionUpdateMany
			.mockResolvedValueOnce({ count: 1 })
			.mockResolvedValueOnce({ count: 0 });
		mocks.sessionFindUniqueOrThrow.mockResolvedValue({
			...session,
			status: "ENDED",
		});

		const result = (await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		})) as { session: { status: string } };

		expect(mocks.finalize).not.toHaveBeenCalled();
		expect(result.session.status).toBe("ENDED");
	});

	it("does not mark a finalized session as stop-failed when post-finalization work throws", async () => {
		mocks.leaveBot.mockResolvedValue({
			kind: "TERMINAL",
			status: "completed",
		});
		mocks.finalize.mockRejectedValue(
			new Error("Provider cleanup failed after finalization"),
		);
		await expect(
			handlers.stop({
				input: { projectId: "project-1", sessionId: "session-1" },
				context,
			}),
		).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
		expect(mocks.sessionUpdateMany).toHaveBeenLastCalledWith(
			expect.objectContaining({
				where: {
					id: "session-1",
					streamGeneration: 1,
					status: {
						in: ["JOINING", "ACTIVE", "LEAVING", "STOP_FAILED"],
					},
					finalizedAt: null,
				},
			}),
		);
	});

	it("rechecks stream drain after the provider responds", async () => {
		mocks.sessionFindFirst
			.mockResolvedValueOnce({
				id: "session-1",
				providerBotId: "provider-bot-1",
				status: "ACTIVE",
				streamClosedAt: null,
				streamGeneration: 2,
			})
			.mockResolvedValueOnce({ id: "session-1" });
		mocks.leaveBot.mockResolvedValue({
			kind: "TERMINAL",
			status: "completed",
		});
		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});
		expect(mocks.sessionFindFirst).toHaveBeenLastCalledWith({
			where: {
				id: "session-1",
				streamGeneration: 2,
				streamClosedAt: { not: null },
				status: { in: ["LEAVING", "FAILED"] },
			},
			select: { id: true },
		});
		expect(mocks.finalize).toHaveBeenCalledWith("session-1", {
			expectedStreamGeneration: 2,
		});
	});

	it("waits for stream close when the verified terminal bot is still draining", async () => {
		mocks.sessionFindFirst
			.mockResolvedValueOnce({
				id: "session-1",
				providerBotId: "provider-bot-1",
				status: "ACTIVE",
				streamClosedAt: null,
				streamGeneration: 2,
			})
			.mockResolvedValueOnce(null);
		mocks.leaveBot.mockResolvedValue({
			kind: "TERMINAL",
			status: "completed",
		});
		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("tells the meeting chat its offers end before an active session's bot is asked to leave", async () => {
		const order: string[] = [];
		mocks.noteLeaving.mockImplementation(async () => {
			order.push("notice");
		});
		mocks.sessionUpdateMany.mockImplementation(async () => {
			order.push("claim");
			return { count: 1 };
		});
		mocks.leaveBot.mockImplementation(async () => {
			order.push("leave");
			return { kind: "LEAVE_REQUESTED" };
		});

		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});

		expect(mocks.noteLeaving).toHaveBeenCalledWith({
			settings: expect.objectContaining({
				serviceSecret: "service-secret",
			}),
			sessionId: "session-1",
		});
		expect(order.slice(0, 3)).toEqual(["notice", "claim", "leave"]);
	});

	it("still asks the bot to leave when the bridge cannot post the notice", async () => {
		mocks.noteLeaving.mockRejectedValue(new Error("bridge down"));

		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});

		expect(mocks.leaveBot).toHaveBeenCalled();
	});

	it("posts no notice for a bot that was never admitted", async () => {
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-1",
			providerBotId: "provider-bot-1",
			status: "JOINING",
			streamClosedAt: null,
			streamGeneration: 1,
		});

		await handlers.stop({
			input: { projectId: "project-1", sessionId: "session-1" },
			context,
		});

		expect(mocks.noteLeaving).not.toHaveBeenCalled();
		expect(mocks.leaveBot).toHaveBeenCalled();
	});

	it("uses the project-admin permission, which excludes editors", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../sessions.ts", import.meta.url), "utf8"),
		);
		expect(source).toContain(
			"requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE)",
		);
	});

	// Past its hard stop, or fifteen minutes after the provider reported the
	// bot gone: a stream close the bridge never reports no longer keeps the
	// session LEAVING until the hard stop.
	it("finalizes a stranded session past its hard stop when listing", async () => {
		mocks.sessionFindMany
			.mockResolvedValueOnce([
				{ id: "stale-1", status: "LEAVING", streamGeneration: 2 },
			])
			.mockResolvedValueOnce([]);
		mocks.finalize.mockResolvedValue(undefined);

		await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		});

		expect(mocks.sessionFindMany).toHaveBeenNthCalledWith(
			1,
			expect.objectContaining({
				where: expect.objectContaining({
					projectId: "project-1",
					terminalCallbackAt: { not: null },
					finalizedAt: null,
					OR: [
						{ hardStopAt: { lt: expect.any(Date) } },
						{ terminalCallbackAt: { lt: expect.any(Date) } },
					],
				}),
				take: 5,
			}),
		);
		expect(mocks.finalize).toHaveBeenCalledWith("stale-1", {
			expectedStreamGeneration: 2,
		});
	});

	it("still lists sessions when a sweep finalization fails", async () => {
		mocks.sessionFindMany
			.mockResolvedValueOnce([
				{ id: "stale-1", status: "FAILED", streamGeneration: 1 },
			])
			.mockResolvedValueOnce([]);
		mocks.finalize.mockRejectedValue(new Error("provider outage"));

		await expect(
			handlers.listSessions({
				input: { projectId: "project-1" },
				context,
			}),
		).resolves.toEqual({ sessions: [], total: 0, nextCursor: null });
		expect(mocks.finalize).toHaveBeenCalledWith("stale-1", {
			expectedStreamGeneration: 1,
			preserveFailure: true,
		});
	});

	it("lists five sessions a page, newest first, and hands back a cursor when more remain", async () => {
		const createdAt = new Date("2026-09-30T12:00:00Z");
		const rows = Array.from({ length: 6 }, (_, index) => ({
			id: `session-${index}`,
			createdAt,
			transcriptContextId: null,
			attendeeUserIds: [],
			_count: { turns: index, suggestions: index * 2 },
		}));
		mocks.sessionFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(rows);
		mocks.sessionCount.mockResolvedValue(12);

		const page = (await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		})) as {
			sessions: Array<{
				id: string;
				requestCount: number;
				suggestionCount: number;
			}>;
			nextCursor: unknown;
			total: number | null;
		};

		expect(page.sessions.map((entry) => entry.id)).toEqual(
			rows.slice(0, 5).map((row) => row.id),
		);
		expect(page.nextCursor).toEqual({ id: "session-4", createdAt });
		expect(page.total).toBe(12);
		expect(page.sessions.map((entry) => entry.requestCount)).toEqual([
			0, 1, 2, 3, 4,
		]);
		expect(page.sessions.map((entry) => entry.suggestionCount)).toEqual([
			0, 2, 4, 6, 8,
		]);
		expect(page.sessions[0]).not.toHaveProperty("_count");
		expect(mocks.sessionFindMany).toHaveBeenNthCalledWith(
			2,
			expect.objectContaining({
				where: { projectId: "project-1" },
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 6,
				select: expect.objectContaining({
					_count: { select: { turns: true, suggestions: true } },
				}),
			}),
		);
		expect(mocks.sessionCount).toHaveBeenCalledWith({
			where: { projectId: "project-1" },
		});
	});

	it("lists anchored notes, and offers their regeneration to the inviter once they are done", async () => {
		const items = [
			{ kind: "decision", text: "Ship the draft.", anchorLine: 2 },
		];
		const row = (id: string, contextId: string) => ({
			id,
			userId: "user-1",
			createdAt: new Date("2026-09-30T12:00:00Z"),
			transcriptContextId: contextId,
			transcriptDeletedAt: null,
			attendeeUserIds: [],
			_count: { turns: 0, suggestions: 0 },
		});
		mocks.sessionFindMany.mockResolvedValueOnce([]).mockResolvedValueOnce([
			row("done", "ctx-done"),
			row("writing", "ctx-writing"),
			{
				...row("deleted", "ctx-deleted"),
				transcriptDeletedAt: new Date(),
			},
		]);
		mocks.contextFindMany.mockResolvedValue([
			{
				id: "ctx-done",
				metadata: {
					parlumeNotes: "### Decisions\n- Ship the draft.",
					parlumeNotesItems: { version: 1, items },
					parlumeNotesStatus: "COMPLETED",
				},
			},
			{ id: "ctx-writing", metadata: { parlumeNotesStatus: "PENDING" } },
			{ id: "ctx-deleted", metadata: { parlumeNotesStatus: "FAILED" } },
		]);

		const page = (await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		})) as { sessions: Array<Record<string, unknown>> };

		expect(page.sessions).toMatchObject([
			{ id: "done", notesItems: items, canRegenerateNotes: true },
			{ id: "writing", notesItems: [], canRegenerateNotes: false },
			{ id: "deleted", canRegenerateNotes: false },
		]);
	});

	it("offers proposing action items to a transcript reader who may create work items, never for a confidential meeting", async () => {
		const row = (id: string, contextId: string | null) => ({
			id,
			userId: "user-1",
			createdAt: new Date("2026-09-30T12:00:00Z"),
			confidential: false,
			transcriptContextId: contextId,
			transcriptDeletedAt: null,
			attendeeUserIds: ["user-1"],
			_count: { turns: 0, suggestions: 0 },
		});
		const rows = [
			row("open", "ctx-open"),
			{ ...row("secret", "ctx-secret"), confidential: true },
			{
				...row("deleted", "ctx-deleted"),
				transcriptDeletedAt: new Date(),
			},
			row("no-transcript", null),
		];
		const list = async () => {
			mocks.sessionFindMany
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(rows);
			const page = (await handlers.listSessions({
				input: { projectId: "project-1" },
				context,
			})) as {
				sessions: Array<{ id: string; canProposeActionItems: boolean }>;
			};
			return page.sessions.map(({ id, canProposeActionItems }) => [
				id,
				canProposeActionItems,
			]);
		};

		mocks.mayPropose.mockResolvedValue(true);
		expect(await list()).toEqual([
			["open", true],
			["secret", false],
			["deleted", false],
			["no-transcript", false],
		]);
		expect(mocks.mayPropose).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});

		mocks.mayPropose.mockResolvedValue(false);
		expect((await list())[0]).toEqual(["open", false]);
	});

	it("lets the inviter and a project manager read a session's transcript, and no other reader", async () => {
		const rows = [
			{
				id: "invited-by-viewer",
				userId: "user-1",
				createdAt: new Date("2026-09-30T12:00:00Z"),
				transcriptContextId: "ctx-1",
				attendeeUserIds: [],
				_count: { turns: 0, suggestions: 0 },
			},
			{
				id: "invited-by-someone-else",
				userId: "user-2",
				createdAt: new Date("2026-09-30T11:00:00Z"),
				transcriptContextId: "ctx-2",
				attendeeUserIds: [],
				_count: { turns: 0, suggestions: 0 },
			},
		];
		const list = async () => {
			mocks.sessionFindMany
				.mockResolvedValueOnce([])
				.mockResolvedValueOnce(rows);
			return (await handlers.listSessions({
				input: { projectId: "project-1" },
				context,
			})) as {
				sessions: Array<{ id: string; canReadTranscript: boolean }>;
			};
		};

		const reader = await list();
		expect(
			reader.sessions.map(({ id, canReadTranscript }) => [
				id,
				canReadTranscript,
			]),
		).toEqual([
			["invited-by-viewer", true],
			["invited-by-someone-else", false],
		]);
		expect(reader.sessions[0]).not.toHaveProperty("userId");
		expect(mocks.managesTranscripts).toHaveBeenCalledWith({
			projectId: "project-1",
			userId: "user-1",
		});

		mocks.managesTranscripts.mockResolvedValue(true);
		const manager = await list();
		expect(manager.sessions.every((entry) => entry.canReadTranscript)).toBe(
			true,
		);
	});

	it("lets a member the meeting's invitation named read its transcript, but not delete it", async () => {
		mocks.readerEmail.mockResolvedValue("dev@example.com");
		const rows = [
			{
				id: "invited-to-meeting",
				userId: "user-2",
				inviteeEmails: ["dev@example.com"],
				createdAt: new Date("2026-09-30T12:00:00Z"),
				transcriptContextId: "ctx-1",
				attendeeUserIds: [],
				_count: { turns: 0, suggestions: 0 },
			},
			{
				id: "not-invited",
				userId: "user-2",
				inviteeEmails: ["dev.two@example.com"],
				createdAt: new Date("2026-09-30T11:00:00Z"),
				transcriptContextId: "ctx-2",
				attendeeUserIds: [],
				_count: { turns: 0, suggestions: 0 },
			},
		];
		mocks.sessionFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(rows);

		const page = (await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		})) as {
			sessions: Array<{
				id: string;
				canReadTranscript: boolean;
				canDeleteSession: boolean;
			}>;
		};

		expect(page.sessions).toMatchObject([
			{
				id: "invited-to-meeting",
				canReadTranscript: true,
				canDeleteSession: false,
			},
			{
				id: "not-invited",
				canReadTranscript: false,
				canDeleteSession: false,
			},
		]);
		expect(page.sessions[0]).not.toHaveProperty("inviteeEmails");
		expect(mocks.readerEmail).toHaveBeenCalledWith("user-1");
	});

	it("shows a confidential meeting the viewer was not in only as having taken place, even to its inviter", async () => {
		mocks.readerEmail.mockResolvedValue("dev@example.com");
		const rows = [
			{
				id: "confidential-not-attended",
				userId: "user-1",
				inviteeEmails: ["dev@example.com"],
				confidential: true,
				attendeeUserIds: ["user-2"],
				createdAt: new Date("2026-09-30T12:00:00Z"),
				transcriptContextId: null,
				_count: { turns: 3, suggestions: 2 },
			},
			{
				id: "confidential-attended",
				userId: "user-2",
				inviteeEmails: [],
				confidential: true,
				attendeeUserIds: ["user-1", "user-2"],
				createdAt: new Date("2026-09-30T11:00:00Z"),
				transcriptContextId: null,
				_count: { turns: 1, suggestions: 0 },
			},
		];
		mocks.sessionFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(rows);

		const page = (await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		})) as { sessions: Array<Record<string, unknown>> };

		expect(page.sessions).toMatchObject([
			{
				id: "confidential-not-attended",
				contentWithheld: true,
				requestCount: 0,
				suggestionCount: 0,
				notes: null,
				canReadTranscript: false,
				canDeleteSession: false,
				canMarkConfidential: false,
				canClearConfidential: false,
			},
			{
				id: "confidential-attended",
				contentWithheld: false,
				requestCount: 1,
				canDeleteSession: false,
				canMarkConfidential: true,
				canClearConfidential: false,
			},
		]);
		expect(page.sessions[0]).not.toHaveProperty("attendeeUserIds");

		mocks.managesTranscripts.mockResolvedValue(true);
		mocks.sessionFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(rows);
		const manager = (await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		})) as { sessions: Array<Record<string, unknown>> };
		expect(manager.sessions[0]).toMatchObject({
			contentWithheld: false,
			requestCount: 3,
			canClearConfidential: true,
		});
	});

	it("has no cursor on the last page", async () => {
		const rows = Array.from({ length: 5 }, (_, index) => ({
			id: `session-${index}`,
			createdAt: new Date("2026-09-30T12:00:00Z"),
			transcriptContextId: null,
			attendeeUserIds: [],
			_count: { turns: 0 },
		}));
		mocks.sessionFindMany
			.mockResolvedValueOnce([])
			.mockResolvedValueOnce(rows);

		const page = (await handlers.listSessions({
			input: { projectId: "project-1" },
			context,
		})) as { sessions: unknown[]; nextCursor: unknown };

		expect(page.sessions).toHaveLength(5);
		expect(page.nextCursor).toBeNull();
	});

	it("continues after a stable timestamp and id cursor without dropping equal-time sessions, and skips the sweep", async () => {
		const createdAt = new Date("2026-09-30T12:00:00Z");
		const rows = Array.from({ length: 6 }, (_, index) => ({
			id: `session-${index}`,
			createdAt,
			transcriptContextId: null,
			attendeeUserIds: [],
			_count: { turns: 0 },
		}));
		mocks.sessionFindMany.mockResolvedValueOnce(rows);

		const page = await handlers.listSessions({
			input: {
				projectId: "project-1",
				before: { id: "prior", createdAt },
			},
			context,
		});

		expect(page).toMatchObject({
			nextCursor: { id: "session-4", createdAt },
			total: null,
		});
		expect(mocks.sessionCount).not.toHaveBeenCalled();
		expect(mocks.sessionFindMany).toHaveBeenCalledTimes(1);
		expect(mocks.sessionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					projectId: "project-1",
					OR: [
						{ createdAt: { lt: createdAt } },
						{ createdAt, id: { lt: "prior" } },
					],
				},
				orderBy: [{ createdAt: "desc" }, { id: "desc" }],
				take: 6,
			}),
		);
		expect(mocks.finalize).not.toHaveBeenCalled();
	});

	it("does not expose a foreign project to a guest session", async () => {
		mocks.projectFindFirst.mockResolvedValue(null);

		await expect(
			handlers.listSessions({
				input: { projectId: "foreign-project" },
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.sessionFindMany).not.toHaveBeenCalled();
	});

	it("rejects a non-Teams meeting link before creating a session", async () => {
		mocks.isTeamsMeetingUrl.mockReturnValue(false);

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentInstanceSId: "agent-stable-1",
					meetingUrl: "https://example.com/meeting",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
	});

	it("rejects an agent that is not active in the project host organization", async () => {
		mocks.agentFindFirst.mockResolvedValue(null);

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentInstanceSId: "agent-from-other-org",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "NOT_FOUND" });
		expect(mocks.agentFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({ organizationId: "org-1" }),
			}),
		);
		expect(mocks.startBot).not.toHaveBeenCalled();
	});

	it("does not start a billable bot when voice is unconfigured", async () => {
		// No gateway and no organization OpenAI key: the platform key is
		// never a fallback, so the join is refused with the provider message.
		mocks.resolveVoiceKey.mockResolvedValue("");
		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentInstanceSId: "agent-stable-1",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: PARLUME_VOICE_REQUIRED,
		});
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
	});

	it("invites with only an Azure AI Foundry resource for voice", async () => {
		mocks.resolveVoiceKey.mockResolvedValue("");
		mocks.azure.mockResolvedValue({
			origin: "https://example-resource.openai.azure.com",
			apiKey: "azure-key",
		});

		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		expect(mocks.startBot).toHaveBeenCalled();
	});

	it("refuses an invitation when the organization has no meeting bot", async () => {
		mocks.attendee.mockResolvedValue(null);

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Settings → Meeting assistant"),
		});
		expect(mocks.attendee).toHaveBeenCalledWith("org-1");
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
	});

	// Parlume places the people in the meeting through this connection.
	it("refuses an invitation from someone without a Microsoft Teams connection", async () => {
		mocks.integration.mockResolvedValue(null);

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Microsoft Teams connection"),
		});
		expect(mocks.integration).toHaveBeenCalledWith(
			"MICROSOFT_GRAPH",
			"user-1",
			"org-1",
		);
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
	});

	it("asks the inviter to reconnect Microsoft Teams when the connection no longer works", async () => {
		mocks.graph.mockRejectedValue(new Error("token expired"));

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "CONFLICT",
			message: expect.stringContaining("Reconnect Microsoft Teams"),
		});
		expect(mocks.graph).toHaveBeenCalledWith(
			"parlume_channel",
			{ kind: "me" },
			"user-1",
			"org-1",
			"example-integration",
		);
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
	});

	it("refuses an invitation without leaking settings it could not read", async () => {
		mocks.attendee.mockRejectedValue(new Error("secret-bearing detail"));

		const failure = handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		await expect(failure).rejects.toMatchObject({ code: "CONFLICT" });
		await expect(failure).rejects.not.toMatchObject({
			message: expect.stringContaining("secret-bearing"),
		});
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
	});

	it("starts the bot with the organization's resolved Attendee settings", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({
				attendee,
				settings: expect.objectContaining({
					bridgeUrl: "wss://bridge.example.com/live",
				}),
			}),
		);
	});
	it("persists only the exact chat join path while handing the original invitation to the audio provider", async () => {
		const meetingUrl =
			"https://teams.microsoft.com/meet/1234567890123?p=example-passcode#example-fragment";
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
			},
			context,
		});
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					meetingUrl:
						"https://teams.microsoft.com/meet/1234567890123",
					channelChatStatus: "PENDING",
				}),
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({ meetingUrl }),
		);
	});
	// The web client's link keeps the meeting in its fragment: the session
	// was stored as the bare `/v2/` path, found none of the earlier sessions
	// in the same chat, and numbered its posts from P1 again.
	it("counts tags and stores the meeting by its join path when the link carries it in the fragment", async () => {
		const meetingUrl =
			"https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_example@thread.v2/0?context=%7b%7d&anon=true";
		const joinPath =
			"https://teams.microsoft.com/l/meetup-join/19:meeting_example@thread.v2/0";
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
			},
			context,
		});
		expect(mocks.chatTagStart).toHaveBeenCalledWith({
			organizationId: "org-1",
			meetingUrl: joinPath,
		});
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					meetingUrl: joinPath,
					channelChatStatus: "ATTENDEE",
				}),
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({ meetingUrl }),
		);
	});
	// The web client's short link was stored as the bare `/v2/`: meetings
	// invited that way continued one another's tags.
	it("stores and resolves a web client's short link as the short link it carries", async () => {
		const meetingUrl =
			"https://teams.microsoft.com/v2/#/meet/1234567890123?p=example-passcode";
		const shortUrl = "https://teams.microsoft.com/meet/1234567890123";
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
			},
			context,
		});
		expect(mocks.graph).toHaveBeenCalledWith(
			"parlume_channel",
			{ kind: "canonical", meetingUrl: shortUrl },
			"user-1",
			"org-1",
			"example-integration",
		);
		expect(mocks.chatTagStart).toHaveBeenCalledWith({
			organizationId: "org-1",
			meetingUrl: shortUrl,
		});
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					meetingUrl: shortUrl,
					channelChatStatus: "PENDING",
				}),
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({ meetingUrl }),
		);
	});
	it("stores no meeting and starts at P1 for a link that names none", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/v2/",
			},
			context,
		});
		expect(mocks.chatTagStart).not.toHaveBeenCalled();
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					meetingUrl: null,
					channelChatStatus: "ATTENDEE",
				}),
			}),
		);
		expect(mocks.armBridge).toHaveBeenCalledWith(
			expect.objectContaining({ chatTagStart: 1 }),
		);
	});
	it("associates a manually invited short link with its exact canonical project series before joining", async () => {
		const canonical =
			"https://teams.microsoft.com/l/meetup-join/19%3Aexample%40thread.tacv2/1700000000000?context=example";
		mocks.integration.mockResolvedValue({ id: "example-integration" });
		mocks.graph.mockResolvedValue({ joinUrl: canonical });
		mocks.linkedFindMany.mockResolvedValue([
			{
				id: "example-series",
				joinUrl: canonical.replace("context=example", "context=other"),
			},
		]);
		mocks.sessionFindFirst.mockResolvedValue(null);
		const meetingUrl =
			"https://teams.microsoft.com/meet/1234567890123?p=example";
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl,
			},
			context,
		});
		expect(mocks.linkedFindMany).toHaveBeenCalledWith({
			where: { projectId: "project-1", deactivatedAt: null },
			select: { id: true, joinUrl: true },
		});
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					linkedMeetingId: "example-series",
					channelIntegrationId: "example-integration",
					meetingUrl: canonical.split("?")[0],
					channelChatStatus: "PENDING",
				}),
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({ meetingUrl }),
		);
	});
	it("sends no second bot for a manual short link while an automatic session of its canonical series is live", async () => {
		const canonical =
			"https://teams.microsoft.com/l/meetup-join/19%3Aexample%40thread.tacv2/1700000000000";
		mocks.integration.mockResolvedValue({ id: "example-integration" });
		mocks.graph.mockResolvedValue({ joinUrl: canonical });
		mocks.linkedFindMany.mockResolvedValue([
			{ id: "example-series", joinUrl: canonical },
		]);
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-0",
			status: "ACTIVE",
			projectId: "project-1",
		});
		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/meet/1234567890123",
				},
				context,
			}),
		).resolves.toMatchObject({ alreadyInMeeting: true });
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith(
			expect.objectContaining({
				where: expect.objectContaining({
					linkedMeetingId: "example-series",
				}),
			}),
		);
		expect(mocks.startBot).not.toHaveBeenCalled();
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
	});

	it("tells the inviter Attendee's own reason for refusing the bot", async () => {
		mocks.startBot.mockRejectedValue(
			new ParlumeProviderError(400, "meeting_url is not a valid URL"),
		);

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message:
				"Attendee refused the invitation (HTTP 400): meeting_url is not a valid URL",
		});
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					status: "FAILED",
					endReason: "START_FAILED",
					lastError:
						"Attendee refused the invitation (HTTP 400): meeting_url is not a valid URL",
				}),
			}),
		);
	});

	it("points to the settings page when Attendee rejects the key", async () => {
		mocks.startBot.mockRejectedValue(new ParlumeProviderError(401, null));

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "BAD_GATEWAY",
			message:
				"Attendee rejected the meeting bot's API key. Check it in Settings → Meeting assistant.",
		});
	});

	it("keeps an unexpected start failure generic", async () => {
		mocks.startBot.mockRejectedValue(new Error("internal host detail"));

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({
			code: "INTERNAL_SERVER_ERROR",
			message: "Parlume could not join the meeting.",
		});
	});

	it("tells the enabler when an automatic join's bot could not start", async () => {
		mocks.sessionFindFirst.mockResolvedValue(null);
		mocks.startBot.mockRejectedValue(new ParlumeProviderError(400, null));

		await expect(
			startParlumeMeetingSession(
				{
					projectId: "project-1",
					organizationId: "org-1",
					userId: "user-1",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
					agentKind: "FABRIC_AGENT",
					toolsReadOnly: true,
					suggestionsEnabled: true,
					suggestionAudience: "TEAM",
					trigger: "AUTO",
					linkedMeetingId: "lm-1",
					occurrenceStart: new Date("2026-10-27T09:00:00.000Z"),
				},
				{},
			),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		expect(mocks.notifyJoinFailure).toHaveBeenCalledOnce();
		expect(mocks.notifyJoinFailure).toHaveBeenCalledWith("session-1");
	});

	it("leaves a manual invitation's failure to the page that shows it", async () => {
		mocks.startBot.mockRejectedValue(new ParlumeProviderError(400, null));

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_GATEWAY" });
		expect(mocks.notifyJoinFailure).not.toHaveBeenCalled();
	});

	it("lists the built-in project Fabric Agent before custom agents", async () => {
		const result = (await handlers.listAgents({
			input: { projectId: "project-1", includeBuiltIn: true },
			context,
		})) as {
			agents: Array<{
				kind: string;
				label: string;
				agentInstanceSId: string | null;
			}>;
		};

		expect(result.agents).toEqual([
			expect.objectContaining({
				kind: "FABRIC_AGENT",
				label: "Fabric Agent — this project",
				agentInstanceSId: null,
			}),
			expect.objectContaining({
				kind: "TEMPLATE_INSTANCE",
				label: "Release assistant",
				agentInstanceSId: "agent-stable-1",
			}),
		]);
	});

	it("starts the built-in project Fabric Agent without a custom agent lookup", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		expect(mocks.agentFindFirst).not.toHaveBeenCalled();
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					agentKind: "FABRIC_AGENT",
					agentLabel: "Fabric Agent — this project",
					agentInstanceSId: null,
					agentInstanceVersionId: null,
					agentInstanceVersion: null,
				}),
			}),
		);
	});

	it("records the linked series a manual invitation's meeting belongs to", async () => {
		mocks.linkedFindFirst.mockResolvedValue({ id: "lm-1" });
		mocks.sessionFindFirst.mockResolvedValue(null);

		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl:
					" https://teams.microsoft.com/l/meetup-join/example ",
			},
			context,
		});

		expect(mocks.linkedFindFirst).toHaveBeenCalledWith({
			where: {
				projectId: "project-1",
				deactivatedAt: null,
				joinUrl: {
					equals: "https://teams.microsoft.com/l/meetup-join/example",
					mode: "insensitive",
				},
			},
			select: { id: true },
		});
		expect(mocks.sessionFindFirst).toHaveBeenCalledWith({
			where: {
				linkedMeetingId: "lm-1",
				status: { in: ["PENDING", "JOINING", "ACTIVE", "LEAVING"] },
			},
			select: { id: true, status: true, projectId: true },
		});
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					trigger: "MANUAL",
					linkedMeetingId: "lm-1",
					occurrenceStart: null,
				}),
			}),
		);
	});

	it("hands a second invitation the series' session that is joining, without a second bot", async () => {
		mocks.linkedFindFirst.mockResolvedValue({ id: "lm-1" });
		mocks.sessionFindFirst.mockResolvedValue({
			id: "session-0",
			status: "JOINING",
			projectId: "project-1",
		});
		mocks.sessionFindUniqueOrThrow.mockResolvedValue({
			...session,
			id: "session-0",
		});

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).resolves.toEqual({
			session: { ...session, id: "session-0" },
			alreadyInMeeting: true,
		});
		expect(mocks.sessionFindUniqueOrThrow).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "session-0" } }),
		);
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.armBridge).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
		expect(mocks.recordAudit).not.toHaveBeenCalled();
	});

	// A second invitation sent another bot into a meeting where Parlume was
	// active. Each bot counted the other as a guest it could not confirm, and
	// both left.
	it("hands a second invitation the project's active session in the same meeting, however its link is spelled", async () => {
		mocks.sessionFindMany.mockResolvedValue([
			{
				id: "session-0",
				projectId: "project-1",
				status: "ACTIVE",
				lastChatTag: 3,
				meetingUrl:
					"https://teams.microsoft.com/l/meetup-join/19%3ameeting_example%40thread.v2/0",
			},
		]);

		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_example@thread.v2/0?context=%7b%7d",
				},
				context,
			}),
		).resolves.toMatchObject({ alreadyInMeeting: true });
		expect(mocks.sessionFindMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: {
					organizationId: "org-1",
					status: { in: ["PENDING", "JOINING", "ACTIVE", "LEAVING"] },
					meetingUrl: { contains: "meeting_example" },
				},
			}),
		);
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
	});

	it.each([
		[
			"leaving",
			{ status: "LEAVING", projectId: "project-1" },
			"Parlume is already in this meeting. Its session is leaving; invite Parlume again once it has left.",
		],
		[
			"another project's",
			{ status: "ACTIVE", projectId: "project-2" },
			"Parlume is already in this meeting. It was invited from another project.",
		],
	])(
		"refuses a second bot while a %s session is in the meeting",
		async (_label, live, message) => {
			mocks.sessionFindMany.mockResolvedValue([
				{
					id: "session-0",
					lastChatTag: null,
					meetingUrl:
						"https://teams.microsoft.com/meet/1234567890123",
					...live,
				},
			]);

			await expect(
				handlers.start({
					input: {
						projectId: "project-1",
						agentKind: "FABRIC_AGENT",
						meetingUrl:
							"https://teams.microsoft.com/meet/1234567890123?p=example",
					},
					context,
				}),
			).rejects.toMatchObject({ code: "CONFLICT", message });
			expect(mocks.sessionCreate).not.toHaveBeenCalled();
			expect(mocks.sessionFindUniqueOrThrow).not.toHaveBeenCalled();
			expect(mocks.startBot).not.toHaveBeenCalled();
		},
	);

	it("stores the meeting's key, the same for every spelling of its link", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl:
					"https://teams.microsoft.com/v2/?meetingjoin=true#/l/meetup-join/19:meeting_example@thread.v2/0?context=%7b%7d",
			},
			context,
		});
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl:
					"https://teams.microsoft.com/l/meetup-join/19%3ameeting_example%40thread.v2/0?context=%7b%7d",
			},
			context,
		});

		const keys = mocks.sessionCreate.mock.calls.map(
			([query]) => query.data.meetingKey,
		);
		expect(keys).toEqual([
			'["meeting","/l/meetup-join/19:meeting_example@thread.v2/0"]',
			'["meeting","/l/meetup-join/19:meeting_example@thread.v2/0"]',
		]);
	});

	it("stores a short link's key as its lower-cased join path", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl:
					"https://teams.microsoft.com/meet/1234567890123?p=example",
			},
			context,
		});

		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					meetingKey:
						"https://teams.microsoft.com/meet/1234567890123",
				}),
			}),
		);
	});

	it("checks for a live session and creates its own under the meeting's lock", async () => {
		const order: string[] = [];
		mocks.executeRaw.mockImplementation(async () => {
			order.push("lock");
			return 1;
		});
		mocks.sessionFindMany.mockImplementation(async () => {
			order.push("check");
			return [];
		});
		mocks.sessionCreate.mockImplementation(async () => {
			order.push("create");
			return { id: "session-1" };
		});

		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl:
					"https://teams.microsoft.com/meet/1234567890123?p=example",
			},
			context,
		});

		expect(order).toEqual(["lock", "check", "create"]);
		expect(mocks.transaction).toHaveBeenCalledTimes(1);
		const [strings, , key] = mocks.executeRaw.mock.calls[0] ?? [];
		expect(String(strings)).toContain("pg_advisory_xact_lock");
		expect(key).toBe(
			"meeting:org-1:https://teams.microsoft.com/meet/1234567890123",
		);
	});

	it("sends one bot for two invitations at once to one unlinked meeting, and hands both its session", async () => {
		const rows: Array<{
			id: string;
			projectId: string;
			status: string;
			meetingUrl: string;
		}> = [];
		let held = Promise.resolve();
		mocks.transaction.mockImplementation(
			async (run: (tx: unknown) => Promise<unknown>) => {
				// The advisory lock: one transaction at a time.
				const previous = held;
				let release = () => {};
				held = new Promise<void>((resolve) => {
					release = resolve;
				});
				await previous;
				try {
					return await run(db);
				} finally {
					release();
				}
			},
		);
		mocks.sessionFindMany.mockImplementation(async () => [...rows]);
		type Create = { data: { projectId: string; meetingUrl: string } };
		mocks.sessionCreate.mockImplementation(async (query: Create) => {
			await Promise.resolve();
			const id = `session-${rows.length + 1}`;
			rows.push({
				id,
				projectId: query.data.projectId,
				status: "PENDING",
				meetingUrl: query.data.meetingUrl,
			});
			return { id };
		});
		const start = () =>
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					meetingUrl:
						"https://teams.microsoft.com/meet/1234567890123?p=example",
				},
				context,
			});

		const results = await Promise.all([start(), start()]);

		expect(results).toHaveLength(2);
		expect(results).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ alreadyInMeeting: false }),
				expect.objectContaining({ alreadyInMeeting: true }),
			]),
		);
		expect(mocks.sessionCreate).toHaveBeenCalledTimes(1);
		expect(mocks.startBot).toHaveBeenCalledTimes(1);
		expect(mocks.sessionFindUniqueOrThrow).toHaveBeenCalledWith(
			expect.objectContaining({ where: { id: "session-1" } }),
		);
	});

	it("invites to a meeting that is no linked series without a series check", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		expect(mocks.sessionFindFirst).not.toHaveBeenCalled();
		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ linkedMeetingId: null }),
			}),
		);
	});

	it("records an invitation that turned chat suggestions off", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
				suggestionsEnabled: false,
			},
			context,
		});

		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ suggestionsEnabled: false }),
			}),
		);
	});

	it("records an invitation whose suggestions are for the team only", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentKind: "FABRIC_AGENT",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
				suggestionAudience: "TEAM",
			},
			context,
		});

		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ suggestionAudience: "TEAM" }),
			}),
		);
	});

	it("rejects a mixed built-in and custom selection before creating a session", async () => {
		await expect(
			handlers.start({
				input: {
					projectId: "project-1",
					agentKind: "FABRIC_AGENT",
					agentInstanceSId: "agent-stable-1",
					meetingUrl:
						"https://teams.microsoft.com/l/meetup-join/example",
				},
				context,
			}),
		).rejects.toMatchObject({ code: "BAD_REQUEST" });
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
	});

	it("persists the stable agent reference and current version before joining", async () => {
		await handlers.start({
			input: {
				projectId: "project-1",
				agentInstanceSId: "agent-stable-1",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					projectId: "project-1",
					organizationId: "org-1",
					agentKind: "TEMPLATE_INSTANCE",
					agentLabel: "Release assistant",
					agentInstanceSId: "agent-stable-1",
					agentInstanceVersionId: "agent-version-2",
					agentInstanceVersion: 2,
					streamTokenDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
					callbackTokenDigest:
						expect.stringMatching(/^[a-f0-9]{64}$/),
					attendeeSource: "ORGANIZATION",
					hardStopAt: expect.any(Date),
				}),
			}),
		);
		expect(mocks.chatTagStart).toHaveBeenCalledWith({
			organizationId: "org-1",
			meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
		});
		expect(mocks.armBridge).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				hardStopAt: expect.any(Date),
				chatTagStart: 4,
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({
				streamToken: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
				callbackToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
				hardStopAt: expect.any(Date),
			}),
		);
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", status: "PENDING" },
				data: { providerBotId: "provider-bot-1", status: "JOINING" },
			}),
		);
	});

	it("gives each bot its own random webhook token and stores only its digest", async () => {
		const input = {
			projectId: "project-1",
			agentInstanceSId: "agent-stable-1",
			meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
		};
		await handlers.start({ input, context });
		await handlers.start({ input, context });

		const tokens = mocks.startBot.mock.calls.map(
			([call]: [{ callbackToken: string }]) => call.callbackToken,
		);
		expect(tokens[0]).not.toBe(tokens[1]);
		const stored = mocks.sessionCreate.mock.calls.map(
			([call]: [{ data: { callbackTokenDigest: string } }]) =>
				call.data.callbackTokenDigest,
		);
		expect(stored[0]).toBe(
			createHash("sha256").update(tokens[0]).digest("hex"),
		);
		expect(JSON.stringify(mocks.sessionCreate.mock.calls)).not.toContain(
			tokens[0],
		);
	});

	it("still invites a bot whose Attendee project has no webhook secret", async () => {
		mocks.attendee.mockResolvedValue({ ...attendee, webhookSecret: null });

		await handlers.start({
			input: {
				projectId: "project-1",
				agentInstanceSId: "agent-stable-1",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		});

		expect(mocks.sessionCreate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({
					callbackTokenDigest:
						expect.stringMatching(/^[a-f0-9]{64}$/),
				}),
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({
				callbackToken: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
			}),
		);
	});

	it("leaves a bot created after a concurrent stop before awaiting its callback", async () => {
		mocks.sessionUpdateMany.mockResolvedValueOnce({ count: 0 });
		mocks.sessionFindUniqueOrThrow.mockResolvedValue({
			...session,
			status: "LEAVING",
		});

		const result = (await handlers.start({
			input: {
				projectId: "project-1",
				agentInstanceSId: "agent-stable-1",
				meetingUrl: "https://teams.microsoft.com/l/meetup-join/example",
			},
			context,
		})) as { session: { status: string } };

		expect(mocks.leaveBot).toHaveBeenCalledWith(
			expect.objectContaining({ providerBotId: "provider-bot-1" }),
		);
		expect(mocks.sessionUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				data: expect.objectContaining({ status: "LEAVING" }),
			}),
		);
		expect(result.session.status).toBe("LEAVING");
	});
});
