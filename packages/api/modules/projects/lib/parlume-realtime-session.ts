import { resolveOpenAiApiKey } from "@repo/ai";
import { db, getBoundPromptForAgent, hasProjectAccess } from "@repo/database";
import { PARLUME_REALTIME_MODEL } from "@repo/temporal/parlume-realtime-usage";
import {
	PARLUME_REALTIME_VOICE_FALLBACK_BODY,
	PARLUME_REALTIME_VOICE_PROMPT_AGENT_KEY,
} from "@repo/utils/parlume-realtime-voice-prompt";
import { fenceUntrusted } from "@repo/utils/untrusted-fence";
import { z } from "zod";
import { parlumeLog } from "./parlume-log";

const CLIENT_SECRETS_URL = "https://api.openai.com/v1/realtime/client_secrets";
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
 * OpenAI's own reason for refusing a mint (a restricted key without the
 * realtime permission, a model the project cannot use), for the log. Its
 * message can quote part of the key, so key-like tokens are masked.
 */
async function openAiRefusal(response: Response) {
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
			message?.replace(/\bsk-[\w*-]+/g, "sk-…").slice(0, 300) ?? null,
	};
}

export type ParlumeRealtimeSession =
	| {
			engine: "realtime";
			clientSecret: string;
			expiresAt: number;
			model: string;
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
 * with, on the organization's own OpenAI key. The key never leaves this
 * function: the bridge only ever holds the short-lived secret. Answers
 * `classic` whenever there is no live meeting, no key, or OpenAI refuses, so
 * the meeting keeps the classic voice. Records nothing billable: the session
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
	const key = await resolveOpenAiApiKey({
		userId: session.userId,
		organizationId: session.organizationId,
	});
	if (!key) {
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
	try {
		const response = await fetch(CLIENT_SECRETS_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"content-type": "application/json",
			},
			body: JSON.stringify({
				expires_after: {
					anchor: "created_at",
					seconds: CLIENT_SECRET_TTL_SECONDS,
				},
				session: {
					type: "realtime",
					model: PARLUME_REALTIME_MODEL,
					instructions,
					audio: REALTIME_AUDIO,
					tools: REALTIME_TOOLS,
					tool_choice: "auto",
				},
			}),
			signal: AbortSignal.timeout(10_000),
		});
		const minted = response.ok
			? clientSecretResponse.safeParse(await response.json())
			: null;
		if (!minted?.success) {
			parlumeLog("warn", "realtime.mint_failed", {
				sessionId: session.id,
				botId: input.botId,
				status: response.status,
				refusal: response.ok ? null : await openAiRefusal(response),
			});
			return { engine: "classic", reason: "mint_failed" };
		}
		parlumeLog("info", "realtime.minted", {
			sessionId: session.id,
			botId: input.botId,
			model: PARLUME_REALTIME_MODEL,
			promptVersionId: boundPrompt?.version?.id ?? null,
		});
		return {
			engine: "realtime",
			clientSecret: minted.data.value,
			expiresAt: minted.data.expires_at,
			model: PARLUME_REALTIME_MODEL,
		};
	} catch (error) {
		parlumeLog("warn", "realtime.mint_failed", {
			sessionId: session.id,
			botId: input.botId,
			error: error instanceof Error ? error.name : "Unknown error",
		});
		return { engine: "classic", reason: "mint_failed" };
	}
}
