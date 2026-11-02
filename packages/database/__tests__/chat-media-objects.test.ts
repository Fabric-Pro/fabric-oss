import { beforeEach, describe, expect, it, vi } from "vitest";

type MediaRow = {
	storageKey: string;
	kind: "UPLOADED_IMAGE" | "GENERATED_IMAGE" | "TTS_AUDIO";
	userId: string;
	organizationId: string | null;
	conversationId: string | null;
	createdAt: Date;
};

const state = vi.hoisted(() => ({
	media: null as MediaRow | null,
	settingsCutoff: new Date("2026-11-02T00:00:00Z") as Date | null,
	settingsError: null as Error | null,
	memberRole: "viewer" as string | null,
	conversation: null as {
		id: string;
		userId: string;
		organizationId: string;
		visibility: "PRIVATE" | "ORGANIZATION";
	} | null,
	upsertArgs: null as Record<string, unknown> | null,
}));

vi.mock("../prisma/client", () => ({
	db: {
		chatMediaObject: {
			findMany: vi.fn(
				async ({
					where,
				}: {
					where: { storageKey: { in: string[] } };
				}) =>
					state.media &&
					where.storageKey.in.includes(state.media.storageKey)
						? [state.media]
						: [],
			),
			upsert: vi.fn(async (args: Record<string, unknown>) => {
				state.upsertArgs = args;
				const create = args.create as MediaRow;
				state.media ??= create;
				return state.media;
			}),
		},
		chatMediaSettings: {
			findUnique: vi.fn(async () => {
				if (state.settingsError) {
					throw state.settingsError;
				}
				return state.settingsCutoff
					? { legacyCutoffAt: state.settingsCutoff }
					: null;
			}),
		},
		member: {
			findFirst: vi.fn(async () =>
				state.memberRole ? { role: state.memberRole } : null,
			),
		},
		agentConversation: {
			findFirst: vi.fn(
				async ({ where }: { where: Record<string, unknown> }) => {
					const row = state.conversation;
					if (!row) {
						return null;
					}
					const alternatives = where.OR as
						| Array<Record<string, unknown>>
						| undefined;
					const viewerMatch = alternatives?.some(
						(filter) =>
							(filter.userId !== undefined &&
								filter.userId === row.userId) ||
							(filter.visibility !== undefined &&
								filter.visibility === row.visibility),
					);
					return where.id === row.id &&
						(where.userId === undefined ||
							where.userId === row.userId) &&
						where.organizationId === row.organizationId &&
						(alternatives === undefined || viewerMatch)
						? { id: row.id }
						: null;
				},
			),
			findMany: vi.fn(
				async ({
					where,
				}: {
					where: { OR: Record<string, unknown>[] };
				}) => {
					const row = state.conversation;
					if (!row) {
						return [];
					}
					return where.OR.some((filter) => {
						const alternatives = filter.OR as Record<
							string,
							unknown
						>[];
						return (
							filter.id === row.id &&
							filter.organizationId === row.organizationId &&
							alternatives.some(
								(alternative) =>
									alternative.userId === row.userId ||
									alternative.visibility === row.visibility,
							)
						);
					})
						? [{ id: row.id }]
						: [];
				},
			),
		},
	},
}));

import { db } from "../prisma/client";
import {
	buildChatMediaStorageKey,
	recordChatMediaObject,
	resolveChatMediaAccess,
	resolveChatMediaAccessBatch,
	resolveExecutionChatMediaAccess,
} from "../prisma/queries/chat-media-objects";

const OWNER = "example-owner";
const VIEWER = "example-viewer";
const ORG = "example-org";
const OTHER_ORG = "other-org";
const CONVERSATION = "example-conversation";
const BEFORE_CUTOFF = `${ORG}/generated-images/${Date.parse("2026-11-01T23:59:59Z")}-abc123xy.png`;
const AFTER_CUTOFF = `${ORG}/generated-images/${Date.parse("2026-11-02T00:00:00Z")}-abc123xy.png`;

function media(overrides: Partial<MediaRow> = {}): MediaRow {
	return {
		storageKey: AFTER_CUTOFF,
		kind: "GENERATED_IMAGE",
		userId: OWNER,
		organizationId: ORG,
		conversationId: CONVERSATION,
		createdAt: new Date("2026-11-01T12:05:00Z"),
		...overrides,
	};
}

beforeEach(() => {
	vi.clearAllMocks();
	state.media = null;
	state.settingsCutoff = new Date("2026-11-02T00:00:00Z");
	state.settingsError = null;
	state.memberRole = "viewer";
	state.conversation = {
		id: CONVERSATION,
		userId: OWNER,
		organizationId: ORG,
		visibility: "ORGANIZATION",
	};
	state.upsertArgs = null;
});

describe("resolveChatMediaAccess", () => {
	it("allows the creator in the media object's exact organization", async () => {
		state.media = media();

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: OWNER,
				organizationId: ORG,
			}),
		).toBe("allow");
	});

	it("allows a current AGENT_READ member while the bound conversation is shared", async () => {
		state.media = media();

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
			}),
		).toBe("allow");
	});

	it("refuses the same member immediately after the conversation becomes private", async () => {
		state.media = media();
		state.conversation = {
			id: CONVERSATION,
			userId: OWNER,
			organizationId: ORG,
			visibility: "PRIVATE",
		};

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
			}),
		).toBe("deny");
	});

	it("refuses a member whose current role does not hold AGENT_READ", async () => {
		state.media = media();
		state.memberRole = "unknown";

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
			}),
		).toBe("deny");
	});

	it("refuses an otherwise shared record across organizations", async () => {
		state.media = media();

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: OTHER_ORG,
			}),
		).toBe("deny");
	});

	it("keeps a record without a conversation creator-only", async () => {
		state.media = media({ conversationId: null });

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
			}),
		).toBe("deny");
		expect(db.member.findFirst).not.toHaveBeenCalled();
	});

	it("allows the creator when safe conversation evidence is absent", async () => {
		state.media = media({ conversationId: null });

		expect(
			await resolveChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: OWNER,
				organizationId: ORG,
			}),
		).toBe("allow");
	});

	it("refuses a recorded key whose shape contradicts its kind", async () => {
		state.media = media({
			storageKey: `${ORG}/chat-images/1794200000000-abc123xy.png`,
			kind: "GENERATED_IMAGE",
		});

		expect(
			await resolveChatMediaAccess({
				storageKey: state.media.storageKey,
				userId: OWNER,
				organizationId: ORG,
			}),
		).toBe("deny");
	});

	it("recognizes an unrecorded, owner-prefixed object before the rollout cutoff as legacy", async () => {
		expect(
			await resolveChatMediaAccess({
				storageKey: BEFORE_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
			}),
		).toBe("legacy");
	});

	it.each([
		["after the cutoff", AFTER_CUTOFF],
		[
			"under another owner prefix",
			"other-org/generated-images/1794000000000-abc123xy.png",
		],
		["with an unrecognized shape", `${ORG}/private/1794000000000-x.png`],
	])("refuses an unrecorded object %s", async (_case, storageKey) => {
		expect(
			await resolveChatMediaAccess({
				storageKey,
				userId: VIEWER,
				organizationId: ORG,
			}),
		).toBe("deny");
	});

	it.each([
		["is missing", null, null],
		["is invalid", new Date(Number.NaN), null],
		[
			"cannot be read",
			new Date("2026-11-02T00:00:00Z"),
			new Error("unavailable"),
		],
	] as const)(
		"refuses legacy access and logs when rollout settings $case",
		async (_case, settingsCutoff, settingsError) => {
			state.settingsCutoff = settingsCutoff;
			state.settingsError = settingsError;
			const log = vi.spyOn(console, "error").mockImplementation(() => {});

			expect(
				await resolveChatMediaAccess({
					storageKey: BEFORE_CUTOFF,
					userId: VIEWER,
					organizationId: ORG,
				}),
			).toBe("deny");
			expect(log).toHaveBeenCalledWith(
				expect.stringContaining("legacy cutoff"),
				expect.anything(),
			);
			log.mockRestore();
		},
	);
});

describe("resolveChatMediaAccessBatch", () => {
	it("loads all keys in one query and makes one current permission and conversation decision", async () => {
		const keys = Array.from(
			{ length: 6 },
			(_, index) =>
				`${ORG}/generated-images/${Date.parse("2026-11-02T00:00:00Z") + index}-image${index}.png`,
		);
		const rows = keys.map((storageKey) => media({ storageKey }));
		vi.mocked(db.chatMediaObject.findMany).mockResolvedValueOnce(
			rows as never,
		);

		const decisions = await resolveChatMediaAccessBatch({
			storageKeys: keys,
			userId: VIEWER,
			organizationId: ORG,
		});

		expect([...decisions.values()]).toEqual(Array(6).fill("allow"));
		expect(db.chatMediaObject.findMany).toHaveBeenCalledTimes(1);
		expect(db.member.findFirst).toHaveBeenCalledTimes(1);
		expect(db.agentConversation.findMany).toHaveBeenCalledTimes(1);
	});
});

describe("resolveExecutionChatMediaAccess", () => {
	const execution = {
		userId: OWNER,
		organizationId: ORG,
		startedAt: new Date("2026-11-01T12:00:00Z"),
		completedAt: new Date("2026-11-01T12:10:00Z"),
	};

	it.each([
		["generated image", "GENERATED_IMAGE", "generated-images", "png"],
		["TTS audio", "TTS_AUDIO", "tts-audio", "mp3"],
	] as const)(
		"allows another organization member's API key to read the execution's %s",
		async (_case, kind, storageKind, extension) => {
			state.media = media({
				storageKey: `${ORG}/${storageKind}/${Date.parse("2026-11-02T00:00:00Z")}-abc123xy.${extension}`,
				kind,
				conversationId: null,
			});

			expect(
				await resolveExecutionChatMediaAccess({
					storageKey: state.media.storageKey,
					userId: VIEWER,
					organizationId: ORG,
					execution,
				}),
			).toBe("allow");
		},
	);

	it("refuses a private upload of the run-as user even inside the execution window", async () => {
		state.media = media({ kind: "UPLOADED_IMAGE", conversationId: null });
		state.media.storageKey = state.media.storageKey.replace(
			"generated-images",
			"chat-images",
		);

		expect(
			await resolveExecutionChatMediaAccess({
				storageKey: state.media.storageKey,
				userId: VIEWER,
				organizationId: ORG,
				execution,
			}),
		).toBe("deny");
	});

	it.each([
		["at the skewed start boundary", new Date("2026-11-01T11:55:00Z")],
		["at the skewed completion boundary", new Date("2026-11-01T12:15:00Z")],
	])("allows run-as generated media created %s", async (_case, createdAt) => {
		state.media = media({ conversationId: null, createdAt });

		expect(
			await resolveExecutionChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
				execution,
			}),
		).toBe("allow");
	});

	it.each([
		["before the skewed start", new Date("2026-11-01T11:54:59.999Z")],
		["after the skewed completion", new Date("2026-11-01T12:15:00.001Z")],
	])(
		"refuses run-as generated media created %s",
		async (_case, createdAt) => {
			state.media = media({ conversationId: null, createdAt });

			expect(
				await resolveExecutionChatMediaAccess({
					storageKey: AFTER_CUTOFF,
					userId: VIEWER,
					organizationId: ORG,
					execution,
				}),
			).toBe("deny");
		},
	);

	it.each([
		["the run-as user differs", { userId: VIEWER }],
		["the organization differs", { organizationId: OTHER_ORG }],
		["the start time is absent", { startedAt: null }],
		["the completion time is absent", { completedAt: null }],
	])("refuses the special grant when $case", async (_case, override) => {
		state.media = media({ conversationId: null });

		expect(
			await resolveExecutionChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
				execution: { ...execution, ...override },
			}),
		).toBe("deny");
	});

	it("refuses an inverted execution window as ambiguous evidence", async () => {
		state.media = media({ conversationId: null });

		expect(
			await resolveExecutionChatMediaAccess({
				storageKey: AFTER_CUTOFF,
				userId: VIEWER,
				organizationId: ORG,
				execution: {
					...execution,
					startedAt: new Date("2026-11-01T12:06:00Z"),
					completedAt: new Date("2026-11-01T12:04:00Z"),
				},
			}),
		).toBe("deny");
	});
});

describe("recordChatMediaObject", () => {
	it("rejects a chat-document key before writing ownership evidence", async () => {
		await expect(
			recordChatMediaObject({
				storageKey: `${ORG}/conversation-example/document-example.png`,
				kind: "UPLOADED_IMAGE",
				userId: OWNER,
				organizationId: ORG,
			}),
		).rejects.toThrow("does not match its ownership evidence");
		expect(state.upsertArgs).toBeNull();
	});

	it("binds an exact owner-and-organization AgentConversation and upserts without mutating retries", async () => {
		await recordChatMediaObject({
			storageKey: AFTER_CUTOFF,
			kind: "GENERATED_IMAGE",
			userId: OWNER,
			organizationId: ORG,
			conversationId: CONVERSATION,
		});

		expect(state.upsertArgs).toMatchObject({
			where: { storageKey: AFTER_CUTOFF },
			create: {
				storageKey: AFTER_CUTOFF,
				kind: "GENERATED_IMAGE",
				userId: OWNER,
				organizationId: ORG,
				conversationId: CONVERSATION,
			},
			update: {},
		});
	});

	it("stores creator-only evidence when the supplied id is not an owned AgentConversation", async () => {
		state.conversation = {
			id: CONVERSATION,
			userId: VIEWER,
			organizationId: ORG,
			visibility: "ORGANIZATION",
		};

		await recordChatMediaObject({
			storageKey: AFTER_CUTOFF,
			kind: "GENERATED_IMAGE",
			userId: OWNER,
			organizationId: ORG,
			conversationId: CONVERSATION,
		});

		expect(state.upsertArgs).toMatchObject({
			create: { conversationId: null },
		});
	});

	it("refuses an idempotency collision whose existing evidence differs", async () => {
		state.media = media({ userId: VIEWER });

		await expect(
			recordChatMediaObject({
				storageKey: AFTER_CUTOFF,
				kind: "GENERATED_IMAGE",
				userId: OWNER,
				organizationId: ORG,
				conversationId: CONVERSATION,
			}),
		).rejects.toThrow("already bound to different evidence");
	});
});

describe("buildChatMediaStorageKey", () => {
	it("builds the owner/kind/timestamp/hash/extension shape used by the proxy", () => {
		expect(
			buildChatMediaStorageKey({
				ownerPrefix: ORG,
				kind: "tts-audio",
				extension: "mp3",
				timestamp: 1794000000000,
				hash: "abc123xy",
			}),
		).toBe(`${ORG}/tts-audio/1794000000000-abc123xy.mp3`);
	});
});
