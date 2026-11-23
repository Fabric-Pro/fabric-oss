import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	segments: vi.fn(),
	hasAccess: vi.fn(),
	boundPrompt: vi.fn(),
	key: vi.fn(),
	azure: vi.fn(),
	log: vi.fn(),
	fetch: vi.fn(),
	deployment: vi.fn(),
}));

vi.mock("@repo/database", () => ({
	db: {
		parlumeMeetingSession: { findFirst: mocks.session },
		parlumeMeetingSegment: { findMany: mocks.segments },
	},
	getBoundPromptForAgent: mocks.boundPrompt,
	hasProjectAccess: mocks.hasAccess,
	logAiUsageAsync: vi.fn(),
}));
vi.mock("@repo/ai", () => ({
	resolveOpenAiApiKey: mocks.key,
	resolveAzureOpenAiResource: mocks.azure,
}));
vi.mock("../parlume-log", () => ({ parlumeLog: mocks.log }));
vi.mock("../parlume-provider-settings", () => ({
	resolveParlumeRealtimeDeployment: mocks.deployment,
}));

import { PARLUME_REALTIME_VOICE_FALLBACK_BODY } from "@repo/utils/parlume-realtime-voice-prompt";
import {
	checkParlumeRealtimeHosts,
	createParlumeRealtimeSession,
} from "../parlume-realtime-session";

const ORG_KEY = "sk-org-secret-key";
const AZURE_KEY = "0123456789abcdef0123456789abcdef";
const AZURE_ORIGIN = "https://example-resource.openai.azure.com";
const input = { sessionId: "session-1", botId: "bot-1" };

function liveSession(overrides: Record<string, unknown> = {}) {
	return {
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		toolsReadOnly: true,
		externalInvitees: false,
		guestJoinedAt: null,
		project: { name: "Example Project" },
		...overrides,
	};
}

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	mocks.session.mockResolvedValue(liveSession());
	mocks.hasAccess.mockResolvedValue(true);
	// An OpenAI key is there to show it is never used for meeting audio.
	mocks.key.mockResolvedValue(ORG_KEY);
	mocks.azure.mockResolvedValue({ origin: AZURE_ORIGIN, apiKey: AZURE_KEY });
	mocks.deployment.mockResolvedValue("example-realtime");
	mocks.boundPrompt.mockResolvedValue(null);
	mocks.segments.mockResolvedValue([
		{ speakerName: "Dev One" },
		{ speakerName: "Dev Two" },
	]);
	mocks.fetch.mockResolvedValue(
		Response.json({
			value: "ek_minted",
			expires_at: 1_900_000_000,
			session: { id: "sess_1" },
		}),
	);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

function mintRequest(call = 0) {
	const [url, init] = mocks.fetch.mock.calls[call] as [string, RequestInit];
	return {
		url,
		headers: init.headers as Record<string, string>,
		body: JSON.parse(String(init.body)),
	};
}

describe("createParlumeRealtimeSession", () => {
	it("mints a client secret on the organization's Azure deployment with the whole session", async () => {
		const result = await createParlumeRealtimeSession(input);

		expect(result).toEqual({
			engine: "realtime",
			clientSecret: "ek_minted",
			expiresAt: 1_900_000_000,
			model: "example-realtime",
			realtimeUrl: `${AZURE_ORIGIN}/openai/v1/realtime`,
		});
		expect(mocks.deployment).toHaveBeenCalledWith("org-1");
		expect(mocks.azure).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		const { url, headers, body } = mintRequest();
		expect(url).toBe(`${AZURE_ORIGIN}/openai/v1/realtime/client_secrets`);
		expect(headers["api-key"]).toBe(AZURE_KEY);
		expect(headers.Authorization).toBeUndefined();
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(body.expires_after).toEqual({
			anchor: "created_at",
			seconds: 600,
		});
		expect(body.session).toEqual(
			expect.objectContaining({
				type: "realtime",
				model: "example-realtime",
				tool_choice: "auto",
			}),
		);
		expect(body.session.audio).toEqual({
			input: {
				format: { type: "audio/pcm", rate: 24_000 },
				turn_detection: {
					type: "semantic_vad",
					eagerness: "low",
					create_response: false,
					interrupt_response: false,
				},
				noise_reduction: { type: "far_field" },
				transcription: null,
			},
			output: {
				format: { type: "audio/pcm", rate: 24_000 },
				voice: "marin",
			},
		});
		expect(
			body.session.tools.map((tool: { name: string }) => tool.name),
		).toEqual(["ask_fabric", "post_to_chat", "read_chat"]);
		// Links are looked up by Fabric in the meeting's project; the voice
		// never writes an address into the chat itself.
		const [askFabric, postToChat]: Array<{ description: string }> =
			body.session.tools;
		expect(askFabric?.description).toContain("any link to a project page");
		// Only long results and results with a link are posted by Fabric.
		expect(askFabric?.description).toContain(
			"Fabric posts a long result, and any result with a link, in the meeting chat itself",
		);
		expect(postToChat?.description).toContain(
			"refuses a web address that did not come from a Fabric result",
		);
	});

	it("speaks with the bound prompt, the default when none is bound, and the meeting as fenced data", async () => {
		await createParlumeRealtimeSession(input);
		const fallback = mintRequest().body.session.instructions as string;
		expect(fallback.startsWith(PARLUME_REALTIME_VOICE_FALLBACK_BODY)).toBe(
			true,
		);
		// The chat may not show a post (it can be turned off): the voice says
		// it is posting, never that it posted.
		expect(fallback).toContain("say briefly that you are posting it there");
		expect(fallback).not.toContain("that you posted it");
		expect(fallback).toContain(
			'<meeting_data source="session" trust="untrusted">',
		);
		expect(fallback).toContain("Project: Example Project");
		expect(fallback).toContain(
			"not allowed; this meeting is read-only for Fabric's data. Posting to the meeting chat with post_to_chat and asking Fabric questions are still allowed",
		);
		expect(fallback).toContain(
			"Participants heard so far: Dev One, Dev Two",
		);
		expect(mocks.boundPrompt).toHaveBeenCalledWith(
			expect.objectContaining({
				agentName: "parlume_realtime_voice",
				documentType: "GENERAL",
				storyKind: null,
			}),
		);

		mocks.fetch.mockClear();
		mocks.boundPrompt.mockResolvedValue({
			version: { id: "version-1", content: "Organization voice rules." },
		});
		await createParlumeRealtimeSession(input);
		const bound = mintRequest().body.session.instructions as string;
		expect(bound.startsWith("Organization voice rules.")).toBe(true);
	});

	it("stays classic by default: no deployment named on the Voice card, so no host is called, even with an OpenAI key", async () => {
		mocks.deployment.mockResolvedValue(null);

		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "not_configured",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.key).not.toHaveBeenCalled();
	});

	it("never falls back to a general OpenAI key for meeting audio", async () => {
		mocks.azure.mockResolvedValue(null);

		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "not_configured",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
		expect(mocks.key).not.toHaveBeenCalled();
	});

	it("stays classic in a meeting with an external guest, invited or seen", async () => {
		mocks.session.mockResolvedValue(
			liveSession({ externalInvitees: true }),
		);
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "guests",
		});
		mocks.session.mockResolvedValue(
			liveSession({ guestJoinedAt: new Date("2026-11-19T10:00:00Z") }),
		);
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "guests",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("stays classic when the Azure deployment refuses, and masks the Azure key in the log", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json(
				{
					error: {
						code: "401",
						message: `Access denied for ${AZURE_KEY}`,
					},
				},
				{ status: 401 },
			),
		);

		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "mint_failed",
		});
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"realtime.mint_failed",
			expect.objectContaining({
				provider: "AZURE_AI_FOUNDRY",
				status: 401,
			}),
		);
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(AZURE_KEY);
	});

	it("stays classic for a meeting that is not live or whose inviter lost access", async () => {
		mocks.session.mockResolvedValue(null);
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "no_session",
		});
		mocks.session.mockResolvedValue(liveSession({ toolsReadOnly: false }));
		mocks.hasAccess.mockResolvedValue(false);
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "no_session",
		});
		expect(mocks.azure).not.toHaveBeenCalled();
	});
});

describe("checkParlumeRealtimeHosts", () => {
	const tenant = { userId: "user-1", organizationId: "org-1" };

	it("mints a bare client secret on the named deployment and reports it, opening no session", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json(
				{
					error: {
						code: "DeploymentNotFound",
						message: `No deployment for ${AZURE_KEY}`,
					},
				},
				{ status: 404 },
			),
		);

		const hosts = await checkParlumeRealtimeHosts(tenant);

		expect(hosts).toEqual([
			{
				provider: "AZURE_AI_FOUNDRY",
				model: "example-realtime",
				ok: false,
				status: 404,
				message: expect.stringContaining("No deployment for"),
			},
		]);
		expect(JSON.stringify(hosts)).not.toContain(AZURE_KEY);
		expect(Object.keys(mintRequest().body.session).sort()).toEqual([
			"model",
			"type",
		]);
	});

	it("reports a host it could not reach by the error's name", async () => {
		mocks.fetch.mockRejectedValue(new TypeError("fetch failed"));

		const [host] = await checkParlumeRealtimeHosts(tenant);

		expect(host).toEqual({
			provider: "AZURE_AI_FOUNDRY",
			model: "example-realtime",
			ok: false,
			status: null,
			message: "TypeError",
		});
	});

	it("returns no hosts without a named deployment or an Azure resource", async () => {
		mocks.deployment.mockResolvedValue(null);
		await expect(checkParlumeRealtimeHosts(tenant)).resolves.toEqual([]);
		mocks.deployment.mockResolvedValue("example-realtime");
		mocks.azure.mockResolvedValue(null);
		await expect(checkParlumeRealtimeHosts(tenant)).resolves.toEqual([]);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
