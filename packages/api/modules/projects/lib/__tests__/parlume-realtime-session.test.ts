import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	session: vi.fn(),
	segments: vi.fn(),
	hasAccess: vi.fn(),
	boundPrompt: vi.fn(),
	key: vi.fn(),
	log: vi.fn(),
	fetch: vi.fn(),
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
vi.mock("@repo/ai", () => ({ resolveOpenAiApiKey: mocks.key }));
vi.mock("../parlume-log", () => ({ parlumeLog: mocks.log }));

import { PARLUME_REALTIME_VOICE_FALLBACK_BODY } from "@repo/utils/parlume-realtime-voice-prompt";
import { createParlumeRealtimeSession } from "../parlume-realtime-session";

const ORG_KEY = "sk-org-secret-key";
const input = { sessionId: "session-1", botId: "bot-1" };

beforeEach(() => {
	vi.resetAllMocks();
	vi.stubGlobal("fetch", mocks.fetch);
	mocks.session.mockResolvedValue({
		id: "session-1",
		projectId: "project-1",
		organizationId: "org-1",
		userId: "user-1",
		toolsReadOnly: true,
		project: { name: "Example Project" },
	});
	mocks.hasAccess.mockResolvedValue(true);
	mocks.key.mockResolvedValue(ORG_KEY);
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

function mintRequest() {
	const [url, init] = mocks.fetch.mock.calls[0] as [string, RequestInit];
	return {
		url,
		headers: init.headers as Record<string, string>,
		body: JSON.parse(String(init.body)),
	};
}

describe("createParlumeRealtimeSession", () => {
	it("mints a client secret on the organization's key with the whole session", async () => {
		const result = await createParlumeRealtimeSession(input);

		expect(result).toEqual({
			engine: "realtime",
			clientSecret: "ek_minted",
			expiresAt: 1_900_000_000,
			model: "gpt-realtime-2.1",
		});
		expect(mocks.key).toHaveBeenCalledWith({
			userId: "user-1",
			organizationId: "org-1",
		});
		const { url, headers, body } = mintRequest();
		expect(url).toBe("https://api.openai.com/v1/realtime/client_secrets");
		expect(headers.Authorization).toBe(`Bearer ${ORG_KEY}`);
		expect(body.expires_after).toEqual({
			anchor: "created_at",
			seconds: 600,
		});
		expect(body.session).toEqual(
			expect.objectContaining({
				type: "realtime",
				model: "gpt-realtime-2.1",
				tool_choice: "auto",
			}),
		);
		expect(body.session.audio).toEqual({
			input: {
				format: { type: "audio/pcm", rate: 24_000 },
				turn_detection: {
					type: "semantic_vad",
					eagerness: "auto",
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
	});

	it("speaks with the bound prompt, the default when none is bound, and the meeting as fenced data", async () => {
		await createParlumeRealtimeSession(input);
		const fallback = mintRequest().body.session.instructions as string;
		expect(fallback.startsWith(PARLUME_REALTIME_VOICE_FALLBACK_BODY)).toBe(
			true,
		);
		expect(fallback).toContain(
			'<meeting_data source="session" trust="untrusted">',
		);
		expect(fallback).toContain("Project: Example Project");
		expect(fallback).toContain("not allowed; this meeting is read-only");
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

	it("stays classic without an OpenAI key, and never calls OpenAI", async () => {
		mocks.key.mockResolvedValue("");
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "no_key",
		});
		expect(mocks.fetch).not.toHaveBeenCalled();
	});

	it("stays classic for a meeting that is not live or whose inviter lost access", async () => {
		mocks.session.mockResolvedValue(null);
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "no_session",
		});
		mocks.session.mockResolvedValue({
			id: "session-1",
			projectId: "project-1",
			organizationId: "org-1",
			userId: "user-1",
			toolsReadOnly: false,
			project: { name: "Example Project" },
		});
		mocks.hasAccess.mockResolvedValue(false);
		await expect(createParlumeRealtimeSession(input)).resolves.toEqual({
			engine: "classic",
			reason: "no_session",
		});
		expect(mocks.key).not.toHaveBeenCalled();
	});

	it("stays classic when OpenAI refuses, and never logs or returns the key", async () => {
		mocks.fetch.mockResolvedValue(
			Response.json(
				{
					error: {
						code: "invalid_api_key",
						type: "invalid_request_error",
						message: `bad key ${ORG_KEY}`,
					},
				},
				{ status: 401 },
			),
		);
		const result = await createParlumeRealtimeSession(input);
		expect(result).toEqual({ engine: "classic", reason: "mint_failed" });
		expect(mocks.log).toHaveBeenCalledWith("warn", "realtime.mint_failed", {
			sessionId: "session-1",
			botId: "bot-1",
			status: 401,
			refusal: {
				code: "invalid_api_key",
				type: "invalid_request_error",
				message: "bad key sk-…",
			},
		});
		mocks.fetch.mockRejectedValue(new Error(`network ${ORG_KEY}`));
		await createParlumeRealtimeSession(input);
		mocks.fetch.mockResolvedValue(
			Response.json({ value: "ek_minted", expires_at: 1 }),
		);
		const minted = await createParlumeRealtimeSession(input);
		expect(
			JSON.stringify([result, minted, mocks.log.mock.calls]),
		).not.toContain(ORG_KEY);
	});
});
