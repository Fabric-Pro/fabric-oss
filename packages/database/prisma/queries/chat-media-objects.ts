import { db } from "../client";
import { agentConversationViewerWhere } from "./agent-conversation-sharing";
import { canReadOrganizationAgents } from "./organization-permissions";

const CHAT_MEDIA_SETTINGS_ID = "default";
export const EXECUTION_MEDIA_CLOCK_SKEW_MS = 5 * 60 * 1000;

const CHAT_MEDIA_KEY_PATTERN =
	/^([^/]+)\/(chat-images|generated-images|tts-audio)\/(\d+)-[a-z0-9]+\.[a-z0-9]+$/;
const STORAGE_KIND_BY_RECORD_KIND: Record<ChatMediaKind, string> = {
	UPLOADED_IMAGE: "chat-images",
	GENERATED_IMAGE: "generated-images",
	TTS_AUDIO: "tts-audio",
};

export type ChatMediaAccessDecision = "allow" | "deny" | "legacy";
export type ChatMediaKind = "UPLOADED_IMAGE" | "GENERATED_IMAGE" | "TTS_AUDIO";

type ChatMediaEvidence = {
	storageKey: string;
	kind: ChatMediaKind;
	userId: string;
	organizationId: string | null;
	conversationId: string | null;
	createdAt: Date;
};

type ExecutionMediaWindow = {
	userId: string;
	organizationId: string | null;
	startedAt: Date | null;
	completedAt: Date | null;
};

function parseChatMediaKey(storageKey: string) {
	const match = CHAT_MEDIA_KEY_PATTERN.exec(storageKey);
	return match
		? {
				owner: match[1],
				storageKind: match[2],
				timestamp: Number(match[3]),
			}
		: null;
}

export function buildChatMediaStorageKey({
	ownerPrefix,
	kind,
	extension,
	timestamp = Date.now(),
	hash = Math.random().toString(36).substring(2, 10),
}: {
	ownerPrefix: string;
	kind: "chat-images" | "generated-images" | "tts-audio";
	extension: string;
	timestamp?: number;
	hash?: string;
}): string {
	return `${ownerPrefix}/${kind}/${timestamp}-${hash}.${extension}`;
}

/**
 * Reads the environment-relative legacy drain deadline installed by the
 * migration. Missing or unreadable rollout evidence fails closed.
 */
export async function getChatMediaLegacyCutoff(): Promise<Date | null> {
	let settings: { legacyCutoffAt: Date } | null;
	try {
		settings = await db.chatMediaSettings.findUnique({
			where: { id: CHAT_MEDIA_SETTINGS_ID },
			select: { legacyCutoffAt: true },
		});
	} catch (error) {
		console.error(
			"[ChatMedia] Could not read the legacy cutoff; refusing legacy media",
			error,
		);
		return null;
	}
	if (!settings || !Number.isFinite(settings.legacyCutoffAt.getTime())) {
		console.error(
			"[ChatMedia] Could not read the legacy cutoff; refusing legacy media",
			settings ?? "settings row missing",
		);
		return null;
	}
	return settings.legacyCutoffAt;
}

export async function isBeforeChatMediaLegacyCutoff(
	createdAt: Date,
): Promise<boolean> {
	if (!Number.isFinite(createdAt.getTime())) {
		return false;
	}
	const cutoff = await getChatMediaLegacyCutoff();
	return cutoff !== null && isBeforeLegacyCutoff(createdAt, cutoff);
}

function isBeforeLegacyCutoff(createdAt: Date, cutoff: Date): boolean {
	return createdAt.getTime() < cutoff.getTime();
}

export async function recordChatMediaObject({
	storageKey,
	kind,
	userId,
	organizationId,
	conversationId,
}: {
	storageKey: string;
	kind: ChatMediaKind;
	userId: string;
	organizationId: string | null;
	conversationId?: string | null;
}): Promise<void> {
	const key = parseChatMediaKey(storageKey);
	const expectedOwner = organizationId ?? userId;
	if (
		key?.owner !== expectedOwner ||
		key.storageKind !== STORAGE_KIND_BY_RECORD_KIND[kind]
	) {
		throw new Error(
			"Chat media storage key does not match its ownership evidence",
		);
	}
	const ownedConversation = conversationId
		? await db.agentConversation.findFirst({
				where: { id: conversationId, userId, organizationId },
				select: { id: true },
			})
		: null;

	const evidence = {
		storageKey,
		kind,
		userId,
		organizationId,
		conversationId: ownedConversation?.id ?? null,
	};
	const row = await db.chatMediaObject.upsert({
		where: { storageKey },
		create: evidence,
		update: {},
	});

	if (
		row.kind !== evidence.kind ||
		row.userId !== evidence.userId ||
		row.organizationId !== evidence.organizationId ||
		row.conversationId !== evidence.conversationId
	) {
		throw new Error(
			"Chat media storage key is already bound to different evidence",
		);
	}
}

function mediaEvidenceMatchesStorageKey(media: ChatMediaEvidence): boolean {
	const key = parseChatMediaKey(media.storageKey);
	const recordedOwner = media.organizationId ?? media.userId;
	return (
		key?.owner === recordedOwner &&
		key.storageKind === STORAGE_KIND_BY_RECORD_KIND[media.kind]
	);
}

function executionMayGrantMedia(
	media: ChatMediaEvidence,
	execution: ExecutionMediaWindow,
): boolean {
	if (
		!execution.startedAt ||
		!execution.completedAt ||
		media.organizationId !== execution.organizationId ||
		media.userId !== execution.userId ||
		(media.kind !== "GENERATED_IMAGE" && media.kind !== "TTS_AUDIO")
	) {
		return false;
	}

	const createdAt = media.createdAt.getTime();
	const startedAt = execution.startedAt.getTime();
	const completedAt = execution.completedAt.getTime();
	return (
		startedAt <= completedAt &&
		createdAt >= startedAt - EXECUTION_MEDIA_CLOCK_SKEW_MS &&
		createdAt <= completedAt + EXECUTION_MEDIA_CLOCK_SKEW_MS
	);
}

async function resolveChatMediaAccessBatchInternal({
	storageKeys,
	userId,
	organizationId,
	execution,
}: {
	storageKeys: string[];
	userId: string;
	organizationId: string | null;
	execution?: ExecutionMediaWindow;
}): Promise<Map<string, ChatMediaAccessDecision>> {
	const uniqueKeys = Array.from(new Set(storageKeys));
	const decisions = new Map<string, ChatMediaAccessDecision>();
	if (uniqueKeys.length === 0) {
		return decisions;
	}

	const rows = (await db.chatMediaObject.findMany({
		where: { storageKey: { in: uniqueKeys } },
	})) as ChatMediaEvidence[];
	const rowsByKey = new Map(rows.map((row) => [row.storageKey, row]));
	const expectedOwner = organizationId ?? userId;
	let legacyCutoff: Date | null | undefined;
	let legacyCutoffLoaded = false;
	const sharedCandidates: ChatMediaEvidence[] = [];

	for (const storageKey of uniqueKeys) {
		const media = rowsByKey.get(storageKey);
		if (!media) {
			const key = parseChatMediaKey(storageKey);
			if (
				key?.owner !== expectedOwner ||
				!Number.isSafeInteger(key.timestamp)
			) {
				decisions.set(storageKey, "deny");
				continue;
			}
			if (!legacyCutoffLoaded) {
				legacyCutoff = await getChatMediaLegacyCutoff();
				legacyCutoffLoaded = true;
			}
			decisions.set(
				storageKey,
				legacyCutoff &&
					isBeforeLegacyCutoff(new Date(key.timestamp), legacyCutoff)
					? "legacy"
					: "deny",
			);
			continue;
		}

		if (
			!mediaEvidenceMatchesStorageKey(media) ||
			media.organizationId !== organizationId ||
			(media.organizationId === null && media.userId !== userId)
		) {
			decisions.set(storageKey, "deny");
			continue;
		}
		if (execution && executionMayGrantMedia(media, execution)) {
			decisions.set(storageKey, "allow");
			continue;
		}
		if (media.userId === userId) {
			decisions.set(storageKey, "allow");
			continue;
		}
		if (!media.organizationId || !media.conversationId) {
			decisions.set(storageKey, "deny");
			continue;
		}
		sharedCandidates.push(media);
	}

	if (sharedCandidates.length === 0 || !organizationId) {
		return decisions;
	}
	if (!(await canReadOrganizationAgents(userId, organizationId))) {
		for (const media of sharedCandidates) {
			decisions.set(media.storageKey, "deny");
		}
		return decisions;
	}

	const conversationIds = Array.from(
		new Set(
			sharedCandidates.flatMap((media) => media.conversationId ?? []),
		),
	);
	const conversations = await db.agentConversation.findMany({
		where: {
			OR: conversationIds.map((id) =>
				agentConversationViewerWhere({ id, userId, organizationId }),
			),
		},
		select: { id: true },
	});
	const visibleConversationIds = new Set(
		conversations.map((conversation) => conversation.id),
	);
	for (const media of sharedCandidates) {
		decisions.set(
			media.storageKey,
			media.conversationId &&
				visibleConversationIds.has(media.conversationId)
				? "allow"
				: "deny",
		);
	}
	return decisions;
}

export async function resolveChatMediaAccessBatch({
	storageKeys,
	userId,
	organizationId,
}: {
	storageKeys: string[];
	userId: string;
	organizationId: string | null;
}): Promise<Map<string, ChatMediaAccessDecision>> {
	return resolveChatMediaAccessBatchInternal({
		storageKeys,
		userId,
		organizationId,
	});
}

export async function resolveChatMediaAccess({
	storageKey,
	userId,
	organizationId,
}: {
	storageKey: string;
	userId: string;
	organizationId: string | null;
}): Promise<ChatMediaAccessDecision> {
	const decisions = await resolveChatMediaAccessBatch({
		storageKeys: [storageKey],
		userId,
		organizationId,
	});
	return decisions.get(storageKey) ?? "deny";
}

/**
 * Applies the normal live media decision, with one narrow exception for media
 * created by an execution's run-as user during that execution's time window.
 */
export async function resolveExecutionChatMediaAccess({
	storageKey,
	userId,
	organizationId,
	execution,
}: {
	storageKey: string;
	userId: string;
	organizationId: string | null;
	execution: ExecutionMediaWindow;
}): Promise<ChatMediaAccessDecision> {
	const decisions = await resolveChatMediaAccessBatchInternal({
		storageKeys: [storageKey],
		userId,
		organizationId,
		execution,
	});
	return decisions.get(storageKey) ?? "deny";
}
