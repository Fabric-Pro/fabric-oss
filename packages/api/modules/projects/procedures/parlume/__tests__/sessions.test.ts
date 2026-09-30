import { beforeEach, describe, expect, it, vi } from "vitest";

const { handlers, mocks } = vi.hoisted(() => {
	const handlers: Record<string, (...args: never[]) => Promise<unknown>> = {};
	const mocks = {
		projectFindFirst: vi.fn(),
		agentFindMany: vi.fn(),
		agentFindFirst: vi.fn(),
		sessionFindMany: vi.fn(),
		sessionFindFirst: vi.fn(),
		sessionFindUniqueOrThrow: vi.fn(),
		sessionCreate: vi.fn(),
		sessionUpdate: vi.fn(),
		sessionUpdateMany: vi.fn(),
		isFeatureEnabled: vi.fn(),
		resolveVoiceKey: vi.fn(),
		getSettings: vi.fn(),
		armBridge: vi.fn(),
		isTeamsMeetingUrl: vi.fn(),
		startBot: vi.fn(),
		leaveBot: vi.fn(),
		finalize: vi.fn(),
		recordAudit: vi.fn(),
		contextFindMany: vi.fn(),
	};
	return { handlers, mocks };
});

vi.mock("@repo/database", () => ({
	db: {
		project: {
			findFirst: (...args: unknown[]) => mocks.projectFindFirst(...args),
		},
		agentTemplateInstance: {
			findMany: (...args: unknown[]) => mocks.agentFindMany(...args),
			findFirst: (...args: unknown[]) => mocks.agentFindFirst(...args),
		},
		parlumeMeetingSession: {
			findMany: (...args: unknown[]) => mocks.sessionFindMany(...args),
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
	},
	isFeatureEnabled: (...args: unknown[]) => mocks.isFeatureEnabled(...args),
	getBuiltInToolConfig: (connections: Record<string, unknown>, key: string) =>
		connections[key] ?? null,
}));

vi.mock("@repo/ai", () => ({
	resolveOpenAiApiKey: (...args: unknown[]) => mocks.resolveVoiceKey(...args),
}));

vi.mock("../../../../../lib/audit", () => ({
	recordAuditFromRequest: (...args: unknown[]) => mocks.recordAudit(...args),
}));

vi.mock("../../../lib/parlume-meeting-baas", () => ({
	armParlumeMeetingBridge: (...args: unknown[]) => mocks.armBridge(...args),
	getParlumeBridgeSettings: () => mocks.getSettings(),
	isTeamsMeetingUrl: (...args: unknown[]) => mocks.isTeamsMeetingUrl(...args),
	startParlumeMeetingBot: (...args: unknown[]) => mocks.startBot(...args),
	leaveParlumeMeetingBot: (...args: unknown[]) => mocks.leaveBot(...args),
}));

vi.mock("../../../lib/parlume-finalization", () => ({
	finalizeParlumeSession: (...args: unknown[]) => mocks.finalize(...args),
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

beforeEach(() => {
	vi.resetAllMocks();
	mocks.contextFindMany.mockResolvedValue([]);
	mocks.projectFindFirst.mockResolvedValue(project);
	mocks.isFeatureEnabled.mockResolvedValue(true);
	mocks.resolveVoiceKey.mockResolvedValue("test-voice-key");
	mocks.getSettings.mockReturnValue({
		apiKey: "test-key",
		bridgeUrl: "wss://bridge.example.com/live",
		callbackUrl: "https://fabric.example.com/api/internal/parlume/callback",
		serviceSecret: "service-secret",
	});
	mocks.armBridge.mockResolvedValue(undefined);
	mocks.isTeamsMeetingUrl.mockReturnValue(true);
	mocks.agentFindFirst.mockResolvedValue(agent);
	mocks.agentFindMany.mockResolvedValue([agent]);
	mocks.sessionCreate.mockResolvedValue({ id: "session-1" });
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

	it("uses the project-admin permission, which excludes editors", async () => {
		const source = await import("node:fs/promises").then((fs) =>
			fs.readFile(new URL("../sessions.ts", import.meta.url), "utf8"),
		);
		expect(source).toContain(
			"requireProjectPermission(Permissions.PROJECT_MEMBERS_MANAGE)",
		);
	});

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
					hardStopAt: { lt: expect.any(Date) },
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
		).resolves.toEqual({ sessions: [] });
		expect(mocks.finalize).toHaveBeenCalledWith("stale-1", {
			expectedStreamGeneration: 1,
			preserveFailure: true,
		});
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
		mocks.resolveVoiceKey.mockResolvedValue(null);
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
		).rejects.toMatchObject({ code: "CONFLICT" });
		expect(mocks.sessionCreate).not.toHaveBeenCalled();
		expect(mocks.startBot).not.toHaveBeenCalled();
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
					hardStopAt: expect.any(Date),
				}),
			}),
		);
		expect(mocks.armBridge).toHaveBeenCalledWith(
			expect.objectContaining({
				sessionId: "session-1",
				hardStopAt: expect.any(Date),
			}),
		);
		expect(mocks.startBot).toHaveBeenCalledWith(
			expect.objectContaining({
				streamToken: expect.stringMatching(/^[A-Za-z0-9_-]+$/),
				callbackSecret: expect.any(String),
			}),
		);
		expect(mocks.sessionUpdateMany).toHaveBeenCalledWith(
			expect.objectContaining({
				where: { id: "session-1", status: "PENDING" },
				data: { providerBotId: "provider-bot-1", status: "JOINING" },
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
