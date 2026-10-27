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
	mocks.azure.mockResolvedValue(null);
	mocks.deployment.mockResolvedValue({
		deployment: "gpt-realtime-2.1",
		source: "default",
	});
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
	it("mints a client secret on the organization's key with the whole session", async () => {
		const result = await createParlumeRealtimeSession(input);

		expect(result).toEqual({
			engine: "realtime",
			clientSecret: "ek_minted",
			expiresAt: 1_900_000_000,
			model: "gpt-realtime-2.1",
			realtimeUrl: "https://api.openai.com/v1/realtime",
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

	it("mints on the organization's Azure resource first, from the deployment named after the model, even with an OpenAI key", async () => {
		mocks.azure.mockResolvedValue({
			origin: AZURE_ORIGIN,
			apiKey: AZURE_KEY,
		});

		const result = await createParlumeRealtimeSession(input);

		expect(result).toEqual(
			expect.objectContaining({
				engine: "realtime",
				clientSecret: "ek_minted",
				realtimeUrl: `${AZURE_ORIGIN}/openai/v1/realtime`,
			}),
		);
		const { url, headers, body } = mintRequest();
		expect(url).toBe(`${AZURE_ORIGIN}/openai/v1/realtime/client_secrets`);
		expect(headers["api-key"]).toBe(AZURE_KEY);
		expect(headers.Authorization).toBeUndefined();
		expect(body.session.model).toBe("gpt-realtime-2.1");
		expect(mocks.fetch).toHaveBeenCalledTimes(1);
	});

	it("names the organization's own Azure deployment, and keeps the model id on OpenAI", async () => {
		mocks.azure.mockResolvedValue({
			origin: AZURE_ORIGIN,
			apiKey: AZURE_KEY,
		});
		mocks.deployment.mockResolvedValue({
			deployment: "example-realtime",
			source: "organization",
		});

		const result = await createParlumeRealtimeSession(input);

		expect(mocks.deployment).toHaveBeenCalledWith("org-1");
		expect(result).toEqual(
			expect.objectContaining({ model: "example-realtime" }),
		);
		expect(mintRequest().body.session.model).toBe("example-realtime");

		mocks.fetch.mockReset();
		mocks.fetch
			.mockResolvedValueOnce(
				Response.json(
					{
						error: {
							code: "DeploymentNotFound",
							message: "missing",
						},
					},
					{ status: 404 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({
					value: "ek_openai",
					expires_at: 1_900_000_000,
				}),
			);

		const fallback = await createParlumeRealtimeSession(input);

		expect(fallback).toEqual(
			expect.objectContaining({ model: "gpt-realtime-2.1" }),
		);
		expect(mintRequest(1).body.session.model).toBe("gpt-realtime-2.1");
	});

	it("falls back to the OpenAI key when the Azure resource has no realtime deployment, and masks the Azure key in the log", async () => {
		mocks.azure.mockResolvedValue({
			origin: AZURE_ORIGIN,
			apiKey: AZURE_KEY,
		});
		mocks.fetch
			.mockResolvedValueOnce(
				Response.json(
					{
						error: {
							code: "OpperationNotSupported",
							message:
								"The realtime operation does not work with the specified model.",
						},
					},
					{ status: 400 },
				),
			)
			.mockResolvedValueOnce(
				Response.json({
					value: "ek_openai",
					expires_at: 1_900_000_000,
				}),
			);

		const result = await createParlumeRealtimeSession(input);

		expect(result).toEqual(
			expect.objectContaining({
				clientSecret: "ek_openai",
				realtimeUrl: "https://api.openai.com/v1/realtime",
			}),
		);
		expect(mintRequest(0).url).toBe(
			`${AZURE_ORIGIN}/openai/v1/realtime/client_secrets`,
		);
		expect(mintRequest(1).url).toBe(
			"https://api.openai.com/v1/realtime/client_secrets",
		);
		expect(mocks.log).toHaveBeenCalledWith(
			"warn",
			"realtime.mint_failed",
			expect.objectContaining({
				provider: "AZURE_AI_FOUNDRY",
				status: 400,
			}),
		);

		mocks.fetch.mockReset();
		mocks.log.mockReset();
		mocks.key.mockResolvedValue("");
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
		expect(JSON.stringify(mocks.log.mock.calls)).not.toContain(AZURE_KEY);
	});

	it("stays classic without an OpenAI key or an Azure resource, and calls no host", async () => {
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
			provider: "OPENAI_DIRECT",
			status: 401,
			refusal: {
				code: "invalid_api_key",
				type: "invalid_request_error",
				message: "bad key sk-…",
			},
			error: null,
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

describe("checkParlumeRealtimeHosts", () => {
	const tenant = { userId: "user-1", organizationId: "org-1" };

	it("mints a bare client secret on every host and reports each one, opening no session", async () => {
		mocks.azure.mockResolvedValue({
			origin: AZURE_ORIGIN,
			apiKey: AZURE_KEY,
		});
		mocks.deployment.mockResolvedValue({
			deployment: "example-realtime",
			source: "organization",
		});
		mocks.fetch.mockImplementation(async (url: string) =>
			url.startsWith(AZURE_ORIGIN)
				? Response.json(
						{
							error: {
								code: "DeploymentNotFound",
								message: `No deployment for ${AZURE_KEY}`,
							},
						},
						{ status: 404 },
					)
				: Response.json({ value: "ek_check", expires_at: 1 }),
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
			{
				provider: "OPENAI_DIRECT",
				model: "gpt-realtime-2.1",
				ok: true,
				status: null,
				message: null,
			},
		]);
		expect(JSON.stringify(hosts)).not.toContain(AZURE_KEY);
		expect(JSON.stringify(hosts)).not.toContain("ek_check");
		for (const call of [0, 1]) {
			const { body } = mintRequest(call);
			expect(Object.keys(body.session).sort()).toEqual(["model", "type"]);
		}
	});

	it("reports a host it could not reach by the error's name", async () => {
		mocks.fetch.mockRejectedValue(new TypeError(`fetch failed ${ORG_KEY}`));

		const [host] = await checkParlumeRealtimeHosts(tenant);

		expect(host).toEqual({
			provider: "OPENAI_DIRECT",
			model: "gpt-realtime-2.1",
			ok: false,
			status: null,
			message: "TypeError",
		});
	});

	it("returns no hosts when the organization has no realtime provider", async () => {
		mocks.key.mockResolvedValue("");

		await expect(checkParlumeRealtimeHosts(tenant)).resolves.toEqual([]);
		expect(mocks.fetch).not.toHaveBeenCalled();
	});
});
