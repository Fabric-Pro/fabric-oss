import { resolveAzureOpenAiResource, resolveOpenAiApiKey } from "@repo/ai";
import { db, getBoundPromptForAgent, hasProjectAccess } from "@repo/database";
import { PARLUME_REALTIME_MODEL } from "@repo/temporal/parlume-realtime-usage";
import {
	PARLUME_REALTIME_VOICE_FALLBACK_BODY,
	PARLUME_REALTIME_VOICE_PROMPT_AGENT_KEY,
} from "@repo/utils/parlume-realtime-voice-prompt";
import { fenceUntrusted } from "@repo/utils/untrusted-fence";
import { z } from "zod";
import { parlumeLog } from "./parlume-log";
import { resolveParlumeRealtimeDeployment } from "./parlume-provider-settings";

const OPENAI_REALTIME_URL = "https://api.openai.com/v1/realtime";
/** How long the bridge has to open the session with the secret. */
const CLIENT_SECRET_TTL_SECONDS = 600;
const REALTIME_VOICE = "marin";
const MAX_PARTICIPANTS = 20;

/**
 * The session's own audio contract. The bridge asserts the same settings when
 * it opens the socket: voice activity is detected, but the session never
 * answers or interrupts on its own; the bridge decides when it speaks.
 */
const REALTIME_AUDIO = {
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
		voice: REALTIME_VOICE,
	},
} as const;

/**
 * Deliberately few: anything that reads Fabric or changes it goes through one
 * ordinary meeting turn, with its audit, read-only policy and receipts.
 */
const REALTIME_TOOLS = [
	{
		type: "function",
		name: "ask_fabric",
		description:
			"Hands a request to Fabric: questions about the project, its work items, documents, roadmap and decisions, and any change in Fabric. Returns at once with a job number; the result follows later.",
		parameters: {
			type: "object",
			properties: {
				request: {
					type: "string",
					description:
						"The request in the participant's words, with every name, identifier and detail they gave.",
				},
			},
			required: ["request"],
		},
	},
	{
		type: "function",
		name: "post_to_chat",
		description:
			"Posts a message to the meeting chat, for links, lists and anything people will want to copy.",
		parameters: {
			type: "object",
			properties: {
				text: {
					type: "string",
					description: "The message, as plain text.",
				},
			},
			required: ["text"],
		},
	},
	{
		type: "function",
		name: "read_chat",
		description: "Returns the latest messages in the meeting chat.",
		parameters: { type: "object", properties: {} },
	},
] as const;

const clientSecretResponse = z.object({
	value: z.string().min(1),
	expires_at: z.number(),
});

const openAiErrorResponse = z.object({
	error: z.object({
		code: z.string().nullish(),
		type: z.string().nullish(),
		message: z.string().nullish(),
	}),
});

/**
 * The host's own reason for refusing a mint (a restricted key without the
 * realtime permission, a model the project cannot use, no credit left), for
 * the log. Its message can quote part of the key, so the key and key-like
 * tokens are masked.
 */
async function mintRefusal(response: Response, key: string) {
	const parsed = openAiErrorResponse.safeParse(
		await response.json().catch(() => null),
	);
	if (!parsed.success) {
		return null;
	}
	const { code, type, message } = parsed.data.error;
	return {
		code: code ?? null,
		type: type ?? null,
		message:
			message
				?.replace(/\bsk-[\w*-]+/g, "sk-…")
				.split(key)
				.join("…")
				.slice(0, 300) ?? null,
	};
}

/** Where a realtime session is minted and opened, and with which key. */
interface RealtimeHost {
	provider: "OPENAI_DIRECT" | "AZURE_AI_FOUNDRY";
	/** The realtime API: `/client_secrets` mints, the bridge opens the socket here. */
	realtimeUrl: string;
	/**
	 * What the session names as its model: Azure's deployment name, or
	 * OpenAI's model id. Pricing and usage always use the model id.
	 */
	model: string;
	key: string;
	headers: Record<string, string>;
}

/**
 * The organization's hosts for the realtime model, in the order they are
 * tried: its Azure AI Foundry resource, which serves the model from the
 * organization's realtime deployment (named after {@link PARLUME_REALTIME_MODEL}
 * unless the organization set another name), then its OpenAI key. Azure goes
 * first because it refuses the mint when that deployment is missing, so a
 * resource without one falls through. OpenAI mints on a key with no credit
 * left and only closes the session once it is opened.
 */
async function realtimeHosts(tenant: {
	userId: string;
	organizationId: string | null;
}): Promise<RealtimeHost[]> {
	const [azure, openAiKey, { deployment }] = await Promise.all([
		resolveAzureOpenAiResource(tenant),
		resolveOpenAiApiKey(tenant),
		resolveParlumeRealtimeDeployment(tenant.organizationId),
	]);
	return [
		...(azure
			? [
					{
						provider: "AZURE_AI_FOUNDRY" as const,
						realtimeUrl: `${azure.origin}/openai/v1/realtime`,
						model: deployment,
						key: azure.apiKey,
						headers: { "api-key": azure.apiKey },
					},
				]
			: []),
		...(openAiKey
			? [
					{
						provider: "OPENAI_DIRECT" as const,
						realtimeUrl: OPENAI_REALTIME_URL,
						model: PARLUME_REALTIME_MODEL,
						key: openAiKey,
						headers: { Authorization: `Bearer ${openAiKey}` },
					},
				]
			: []),
	];
}

function clientSecretRequest(
	model: string,
	session: Record<string, unknown> = {},
): string {
	return JSON.stringify({
		expires_after: {
			anchor: "created_at",
			seconds: CLIENT_SECRET_TTL_SECONDS,
		},
		session: { type: "realtime", model, ...session },
	});
}

export type ParlumeRealtimeSession =
	| {
			engine: "realtime";
			clientSecret: string;
			expiresAt: number;
			model: string;
			realtimeUrl: string;
	  }
	| { engine: "classic"; reason: "no_session" | "no_key" | "mint_failed" };

/** The project, the meeting's mode and who has spoken, as fenced meeting data. */
function parlumeRealtimeMeetingData(input: {
	projectName: string;
	toolsReadOnly: boolean;
	participants: string[];
}): string {
	return fenceUntrusted(
		"meeting_data",
		{ source: "session" },
		[
			`Project: ${input.projectName}`,
			`Changes in Fabric: ${input.toolsReadOnly ? "not allowed; this meeting is read-only" : "allowed, through ask_fabric"}`,
			`Participants heard so far: ${input.participants.length ? input.participants.join(", ") : "none yet"}`,
		].join("\n"),
	);
}

/**
 * Mints the client secret Parlume's bridge opens a realtime voice session
 * with, on the organization's own OpenAI key or Azure AI Foundry resource,
 * whichever accepts first. The key never leaves this module: the bridge only
 * ever holds the short-lived secret and the host it opens. Answers `classic`
 * whenever there is no live meeting, no key, or every host refuses, so the
 * meeting keeps the classic voice. Records nothing billable: the session
 * reports its usage per response.
 */
export async function createParlumeRealtimeSession(input: {
	sessionId: string;
	botId: string;
}): Promise<ParlumeRealtimeSession> {
	const session = await db.parlumeMeetingSession.findFirst({
		where: {
			id: input.sessionId,
			providerBotId: input.botId,
			status: "ACTIVE",
			captureStoppedAt: null,
		},
		select: {
			id: true,
			projectId: true,
			organizationId: true,
			userId: true,
			toolsReadOnly: true,
			project: { select: { name: true } },
		},
	});
	if (
		!session ||
		!(await hasProjectAccess(
			session.projectId,
			session.userId,
			session.organizationId,
		))
	) {
		return { engine: "classic", reason: "no_session" };
	}
	const hosts = await realtimeHosts({
		userId: session.userId,
		organizationId: session.organizationId,
	});
	if (!hosts.length) {
		return { engine: "classic", reason: "no_key" };
	}
	const [boundPrompt, speakers] = await Promise.all([
		getBoundPromptForAgent({
			agentName: PARLUME_REALTIME_VOICE_PROMPT_AGENT_KEY,
			documentType: "GENERAL",
			storyKind: null,
			userId: session.userId,
			organizationId: session.organizationId,
			projectId: session.projectId,
		}),
		db.parlumeMeetingSegment.findMany({
			where: {
				sessionId: session.id,
				source: "SPEECH",
				speakerName: { not: null },
			},
			select: { speakerName: true },
			distinct: ["speakerName"],
			take: MAX_PARTICIPANTS,
		}),
	]);
	const instructions = [
		boundPrompt?.version?.content?.trim() ||
			PARLUME_REALTIME_VOICE_FALLBACK_BODY,
		parlumeRealtimeMeetingData({
			projectName: session.project.name,
			toolsReadOnly: session.toolsReadOnly,
			participants: speakers.flatMap(({ speakerName }) =>
				speakerName ? [speakerName] : [],
			),
		}),
	].join("\n\n");
	const logContext = { sessionId: session.id, botId: input.botId };
	for (const host of hosts) {
		const attempt = await mintClientSecret(
			host,
			clientSecretRequest(host.model, {
				instructions,
				audio: REALTIME_AUDIO,
				tools: REALTIME_TOOLS,
				tool_choice: "auto",
			}),
		);
		if (attempt.minted) {
			parlumeLog("info", "realtime.minted", {
				...logContext,
				provider: host.provider,
				model: host.model,
				promptVersionId: boundPrompt?.version?.id ?? null,
			});
			return {
				engine: "realtime",
				clientSecret: attempt.minted.value,
				expiresAt: attempt.minted.expires_at,
				model: host.model,
				realtimeUrl: host.realtimeUrl,
			};
		}
		parlumeLog("warn", "realtime.mint_failed", {
			...logContext,
			provider: host.provider,
			...attempt.failure,
		});
	}
	return { engine: "classic", reason: "mint_failed" };
}

export interface ParlumeRealtimeHostCheck {
	provider: RealtimeHost["provider"];
	model: string;
	ok: boolean;
	/** The host's HTTP status and own reason when it refused; key masked. */
	status: number | null;
	message: string | null;
}

/**
 * Mints a client secret on each of the organization's realtime hosts without
 * opening a session, so nothing is billed: proves the key, the resource and
 * the deployment before a meeting depends on them. The secret is discarded.
 */
export async function checkParlumeRealtimeHosts(tenant: {
	userId: string;
	organizationId: string;
}): Promise<ParlumeRealtimeHostCheck[]> {
	const hosts = await realtimeHosts(tenant);
	return Promise.all(
		hosts.map(async (host) => {
			const attempt = await mintClientSecret(
				host,
				clientSecretRequest(host.model),
			);
			const base = { provider: host.provider, model: host.model };
			return attempt.minted
				? { ...base, ok: true, status: null, message: null }
				: {
						...base,
						ok: false,
						status: attempt.failure.status,
						message:
							attempt.failure.refusal?.message ??
							attempt.failure.error ??
							null,
					};
		}),
	);
}

type MintAttempt =
	| { minted: z.infer<typeof clientSecretResponse> }
	| {
			minted: null;
			failure: {
				status: number | null;
				refusal: Awaited<ReturnType<typeof mintRefusal>>;
				error: string | null;
			};
	  };

/** One host's client secret, or the host's reason for refusing it. */
async function mintClientSecret(
	host: RealtimeHost,
	request: string,
): Promise<MintAttempt> {
	try {
		const response = await fetch(`${host.realtimeUrl}/client_secrets`, {
			method: "POST",
			headers: { ...host.headers, "content-type": "application/json" },
			body: request,
			signal: AbortSignal.timeout(10_000),
		});
		const minted = response.ok
			? clientSecretResponse.safeParse(await response.json())
			: null;
		if (minted?.success) {
			return { minted: minted.data };
		}
		return {
			minted: null,
			failure: {
				status: response.status,
				refusal: response.ok
					? null
					: await mintRefusal(response, host.key),
				error: null,
			},
		};
	} catch (error) {
		return {
			minted: null,
			failure: {
				status: null,
				refusal: null,
				error: error instanceof Error ? error.name : "Unknown error",
			},
		};
	}
}
