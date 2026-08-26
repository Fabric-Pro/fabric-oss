"use client";

/**
 * Graph-grounded AI chat for the Atlas tab (always-on, AC#3).
 *
 * One assistant, one history: the chat is shared across both graph views.
 * Toggling Business | Technical never clears the active conversation or
 * aborts an in-flight stream — the graph `mode` is only an emphasis hint for
 * the model and the linkifier.
 *
 * Persistent conversations (AC#5):
 *   - Loads the project+repository conversation list via conversations.list
 *     (all conversations, regardless of the graph view they were started in).
 *   - Allows creating, selecting, renaming, toggling visibility, and deleting
 *     conversations (owner-only mutations).
 *   - The active conversation's messages are loaded via conversations.get on
 *     first load and new turns are persisted by passing `conversationId` to chat.
 *
 * Durability:
 *   - Assistant messages persisted as interrupted (mid-stream abort or
 *     disconnect) render a calm "Response interrupted" marker under the
 *     bubble; the live `atlas-chat-interrupted` sentinel and local aborts
 *     mirror the same marker immediately, without a reload.
 *   - The server appends a terminal `{ type: "atlas-chat-persist-failed" }`
 *     event when a finished turn could not be saved; the client surfaces it
 *     as a single non-blocking warning while keeping the rendered answer.
 *
 * Node-reference linkifier (AC#4):
 *   - Given the assistant text + the list of {key,label} for the active graph,
 *     exact label occurrences are wrapped in clickable <button> chips; clicking
 *     calls onFocusNode(key) to pan/focus that node in the graph.
 *   - Matching is longest-first, case-sensitive, whole-token (word boundary).
 *   - Regex-safe: special chars in labels are escaped.
 *
 * Streaming consumption:
 *   1. `orpcClient.atlas.chat(input)` returns an oRPC event iterator.
 *   2. The client `for await`s it directly: string events are text deltas
 *      concatenated into the in-progress assistant bubble as they arrive.
 *   3. After the deltas the server may yield ONE terminal object sentinel —
 *      `{ type: "atlas-chat-interrupted" }` (the turn was cut short and
 *      salvaged server-side) or `{ type: "atlas-chat-persist-failed" }` (the
 *      finished turn could not be saved) — mapped to the inline interrupted
 *      marker / warning toast respectively.
 */
import type { ConversationSummary, GraphMode } from "@repo/atlas/types";
import { useOrganizationContext } from "@saas/organizations/hooks/use-organization-context";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import {
	useInfiniteQuery,
	useMutation,
	useQuery,
	useQueryClient,
} from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@ui/components/dropdown-menu";
import { Input } from "@ui/components/input";
import { ScrollArea } from "@ui/components/scroll-area";
import { Textarea } from "@ui/components/textarea";
import {
	Tooltip,
	TooltipContent,
	TooltipTrigger,
} from "@ui/components/tooltip";
import { cn } from "@ui/lib";
import {
	ChevronDownIcon,
	GlobeIcon,
	Loader2Icon,
	LockIcon,
	MessageSquareMoreIcon,
	MessageSquarePlusIcon,
	MessageSquareTextIcon,
	MoreHorizontalIcon,
	PencilIcon,
	SendHorizonalIcon,
	SparklesIcon,
	Trash2Icon,
	XIcon,
} from "lucide-react";
import { useTranslations } from "next-intl";
import {
	createElement,
	Fragment,
	useCallback,
	useEffect,
	useId,
	useMemo,
	useRef,
	useState,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { bucketByRecency, formatRelativeTime } from "./atlas-utils";

/** Conversations loaded per page (initial load and each "Show more" click). */
const CONVERSATIONS_PAGE_SIZE = 10;

/** Recency buckets shown expanded in the history view (newest first). */
const RECENT_BUCKETS = ["today", "yesterday", "thisWeek"] as const;

/** i18n key for each recency bucket heading. */
const BUCKET_LABEL_KEY = {
	today: "conversationsBucketToday",
	yesterday: "conversationsBucketYesterday",
	thisWeek: "conversationsBucketThisWeek",
} as const;

interface ChatMessage {
	id: string;
	role: "user" | "assistant";
	content: string;
	/** The stored/streamed reply was cut short (abort, disconnect, error). */
	interrupted?: boolean;
}

/**
 * Terminal stream sentinels the server may append after the text deltas —
 * exactly one of them (or neither) ends a turn:
 *  - "atlas-chat-interrupted": the assistant turn was cut short (provider
 *    error / disconnect) and salvaged server-side as interrupted.
 *  - "atlas-chat-persist-failed": the turn finished but could not be saved
 *    to history.
 * Text deltas are plain strings, so any object event is already out-of-band;
 * the `type` check keeps it precise (unknown objects are ignored).
 */
type ChatStreamSentinel =
	| "atlas-chat-interrupted"
	| "atlas-chat-persist-failed";

function chatStreamSentinelOf(value: unknown): ChatStreamSentinel | null {
	if (typeof value !== "object" || value === null) {
		return null;
	}
	const type = (value as { type?: unknown }).type;
	return type === "atlas-chat-interrupted" ||
		type === "atlas-chat-persist-failed"
		? type
		: null;
}

interface AtlasChatPanelProps {
	projectId: string;
	mode: GraphMode;
	focusNodeKey: string | null;
	repositoryIntegrationId: string | null;
	/**
	 * When set, the panel runs in multi-repo "System map" mode: it grounds on the
	 * given repos via `systemChat` and persists project-wide (isSystemScope)
	 * conversations. When absent, it is the per-repo chat (unchanged).
	 */
	systemScope?: { repositoryIntegrationIds: string[] };
	/** A prompt pushed in from "Ask AI about this" on the node panel. */
	seededPrompt: { value: string; nonce: number } | null;
	onSeededPromptConsumed: () => void;
	/** Node list for the linkifier — {key, label}[]. */
	graphNodes: { key: string; label: string }[];
	/** Called when a node reference chip is clicked (pans the graph to that node). */
	onFocusNode: (key: string) => void;
	/**
	 * The most-connected node label on the active graph, used to seed a dynamic
	 * "What does {capability} depend on?" starter chip in the empty state.
	 */
	suggestedCapability?: string | null;
}

/** Escape a string for use in a RegExp literal. */
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Node reference linkifier (AC#4).
 *
 * Splits the assistant text on exact node label occurrences (longest-first so
 * "Authentication Service" is matched before "Authentication"). Returns a list
 * of {text} and {key, label} segments. Case-sensitive, word-boundary aware.
 */
function tokenizeWithNodeRefs(
	text: string,
	nodes: { key: string; label: string }[],
): Array<
	| { type: "text"; text: string }
	| { type: "node"; key: string; label: string }
> {
	if (!nodes.length || !text) {
		return [{ type: "text", text }];
	}

	// Sort longest label first to prefer greedier matches.
	const sorted = [...nodes].sort((a, b) => b.label.length - a.label.length);

	// Build a single regex alternating all labels with word-boundary anchors.
	const pattern = sorted
		.map((n) => `(?<![\\w])${escapeRegex(n.label)}(?![\\w])`)
		.join("|");

	let regex: RegExp;
	try {
		regex = new RegExp(pattern, "g");
	} catch {
		return [{ type: "text", text }];
	}

	const segments: Array<
		| { type: "text"; text: string }
		| { type: "node"; key: string; label: string }
	> = [];
	let lastIndex = 0;
	let match: RegExpExecArray | null;

	// biome-ignore lint/suspicious/noAssignInExpressions: intentional exec loop
	while ((match = regex.exec(text)) !== null) {
		if (match.index > lastIndex) {
			segments.push({
				type: "text",
				text: text.slice(lastIndex, match.index),
			});
		}
		const matched = match[0];
		const node = sorted.find((n) => n.label === matched);
		if (node) {
			segments.push({ type: "node", key: node.key, label: matched });
		} else {
			segments.push({ type: "text", text: matched });
		}
		lastIndex = match.index + matched.length;
	}
	if (lastIndex < text.length) {
		segments.push({ type: "text", text: text.slice(lastIndex) });
	}
	return segments;
}

/**
 * Render a ReactMarkdown `children` prop list, post-processing text nodes to
 * insert node-reference chips. This is used as the `components.text` override
 * in ReactMarkdown so it only replaces inline text nodes.
 */
function NodeLinkifiedText({
	children,
	graphNodes,
	onFocusNode,
}: {
	children: string;
	graphNodes: { key: string; label: string }[];
	onFocusNode: (key: string) => void;
}) {
	const segments = useMemo(
		() => tokenizeWithNodeRefs(children, graphNodes),
		[children, graphNodes],
	);

	return (
		<>
			{segments.map((seg, i) =>
				seg.type === "node" ? (
					<button
						key={i}
						type="button"
						onClick={() => onFocusNode(seg.key)}
						className="inline-flex items-center gap-0.5 rounded bg-primary/10 px-1 py-0.5 text-[0.8em] font-medium text-primary underline-offset-2 hover:bg-primary/20 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						aria-label={`Focus node: ${seg.label}`}
					>
						{seg.label}
					</button>
				) : (
					<Fragment key={i}>{seg.text}</Fragment>
				),
			)}
		</>
	);
}

/** Rename dialog embedded inline in the conversation list. */
function ConversationRenameForm({
	initial,
	onSave,
	onCancel,
}: {
	initial: string;
	onSave: (title: string) => void;
	onCancel: () => void;
}) {
	const t = useTranslations("projects.atlas.chat");
	const [value, setValue] = useState(initial);
	return (
		<form
			onSubmit={(e) => {
				e.preventDefault();
				const trimmed = value.trim();
				if (trimmed) {
					onSave(trimmed);
				}
			}}
			className="flex items-center gap-1.5 p-1.5"
		>
			<Input
				value={value}
				onChange={(e) => setValue(e.target.value)}
				placeholder={t("conversationRenamePlaceholder")}
				aria-label={t("conversationRenameLabel")}
				className="h-7 flex-1 text-sm"
				autoFocus
			/>
			<Button type="submit" size="sm" className="h-7 px-2 text-xs">
				{t("conversationRenameSave")}
			</Button>
			<Button
				type="button"
				variant="ghost"
				size="sm"
				onClick={onCancel}
				className="h-7 px-2 text-xs"
			>
				{t("conversationRenameCancel")}
			</Button>
		</form>
	);
}

export function AtlasChatPanel({
	projectId,
	mode,
	focusNodeKey,
	repositoryIntegrationId,
	systemScope,
	seededPrompt,
	onSeededPromptConsumed,
	graphNodes,
	onFocusNode,
	suggestedCapability,
}: AtlasChatPanelProps) {
	const t = useTranslations("projects.atlas.chat");
	const { organizationId } = useOrganizationContext();
	const queryClient = useQueryClient();
	const inputId = useId();

	// Active conversation id (null = "new, unsaved conversation").
	const [conversationId, setConversationId] = useState<string | null>(null);
	const [messages, setMessages] = useState<ChatMessage[]>([]);
	const [input, setInput] = useState("");
	const [streaming, setStreaming] = useState(false);
	const [showConversationList, setShowConversationList] = useState(false);
	const [renamingId, setRenamingId] = useState<string | null>(null);
	const abortRef = useRef<AbortController | null>(null);
	const scrollRef = useRef<HTMLDivElement>(null);
	const textareaRef = useRef<HTMLTextAreaElement>(null);
	// The conversation id whose messages are currently in local `messages` state.
	// Guards the server-hydration effect from clobbering optimistic/streamed
	// messages when a conversation is created mid-send (its fresh `get` is empty).
	const loadedConvIdRef = useRef<string | null>(null);
	// The server snapshot (updatedAt + message count) the local thread was last
	// hydrated from — a strictly NEWER snapshot for the SAME conversation may
	// re-hydrate (a turn persisted behind this view), an equal/older one never
	// clobbers local state. `null` = no snapshot (e.g. a conversation created
	// mid-send, where local optimistic state is authoritative). "pinned" = the
	// local thread is deliberately ahead of the server (a turn that could not
	// be saved) and must not be overwritten until the user switches away.
	const hydratedSnapshotRef = useRef<
		{ updatedAt: string | null; messageCount: number } | "pinned" | null
	>(null);

	// Whether the "Older" (>1 week) bucket is expanded in the history view. It
	// stays collapsed until the user clicks it, so a long backlog never floods
	// the panel — the recent buckets (Today / Yesterday / This week) read first.
	const [olderExpanded, setOlderExpanded] = useState(false);

	// --- Conversation list (shared across both graph views) -----------------
	// Offset-based pagination (newest first): a small first page, more on demand
	// via "Show more". The key is derived once and reused for every invalidation
	// so a created / renamed / deleted conversation refreshes the same cache.
	const isSystemScope = !!systemScope;
	const conversationsListKey = useMemo(
		() =>
			[
				"atlas",
				"conversations",
				"list",
				{
					projectId,
					repositoryIntegrationId: repositoryIntegrationId ?? null,
					organizationId: organizationId ?? null,
					isSystemScope,
				},
			] as const,
		[projectId, repositoryIntegrationId, organizationId, isSystemScope],
	);
	const conversationsQuery = useInfiniteQuery({
		queryKey: conversationsListKey,
		initialPageParam: 0,
		queryFn: ({ pageParam }) =>
			orpcClient.atlas.conversations.list({
				projectId,
				repositoryIntegrationId: repositoryIntegrationId ?? undefined,
				organizationId: organizationId ?? null,
				isSystemScope: isSystemScope ? true : undefined,
				limit: CONVERSATIONS_PAGE_SIZE,
				offset: pageParam,
			}),
		getNextPageParam: (lastPage, pages) => {
			const loaded = pages.reduce(
				(sum, page) => sum + page.conversations.length,
				0,
			);
			return loaded < lastPage.total ? loaded : undefined;
		},
	});
	const conversations =
		conversationsQuery.data?.pages.flatMap((page) => page.conversations) ??
		[];
	const conversationsTotal = conversationsQuery.data?.pages[0]?.total ?? 0;
	// Group the loaded conversations into recency buckets for the history view.
	const groupedConversations = bucketByRecency(
		conversations,
		(conversation) => conversation.updatedAt,
	);

	// Load active conversation messages on first load / id change.
	const conversationDetailQuery = useQuery({
		...orpc.atlas.conversations.get.queryOptions({
			input: {
				projectId,
				conversationId: conversationId ?? "",
				organizationId: organizationId ?? null,
			},
		}),
		enabled: !!conversationId,
	});

	// Hydrate local messages from the server when switching to a conversation
	// we don't already have loaded — never mid-stream, and never for the
	// conversation just created by `send()` (whose fresh `get` is empty until
	// the turn persists). For the conversation already on screen, re-hydrate
	// only when the server snapshot is strictly NEWER than the one last
	// hydrated (a turn was persisted behind this view); an equal or older
	// snapshot never clobbers local state.
	useEffect(() => {
		const detail = conversationDetailQuery.data;
		if (!detail || streaming) {
			return;
		}
		if (loadedConvIdRef.current === detail.id) {
			const hydrated = hydratedSnapshotRef.current;
			if (hydrated === "pinned" || hydrated === null) {
				return;
			}
			const incomingUpdatedAt =
				typeof detail.updatedAt === "string" ? detail.updatedAt : null;
			const isNewer =
				incomingUpdatedAt !== null && hydrated.updatedAt !== null
					? incomingUpdatedAt > hydrated.updatedAt
					: detail.messages.length > hydrated.messageCount;
			if (!isNewer) {
				return;
			}
		}
		loadedConvIdRef.current = detail.id;
		hydratedSnapshotRef.current = {
			updatedAt:
				typeof detail.updatedAt === "string" ? detail.updatedAt : null,
			messageCount: detail.messages.length,
		};
		setMessages(
			detail.messages.map((m, i) => ({
				id: `server-${i}`,
				role: m.role as "user" | "assistant",
				content: m.content,
				interrupted: m.interrupted === true || undefined,
			})),
		);
	}, [conversationDetailQuery.data, streaming]);

	// --- Conversation mutations -------------------------------------------
	const updateConversationMutation = useMutation(
		orpc.atlas.conversations.update.mutationOptions({
			onSuccess: () => {
				queryClient.invalidateQueries({
					queryKey: conversationsListKey,
				});
				toast.success(t("conversationUpdated"));
				setRenamingId(null);
			},
			onError: () => toast.error(t("conversationUpdateError")),
		}),
	);

	const deleteConversationMutation = useMutation(
		orpc.atlas.conversations.delete.mutationOptions({
			onSuccess: (_data, variables) => {
				queryClient.invalidateQueries({
					queryKey: conversationsListKey,
				});
				toast.success(t("conversationDeleted"));
				if (conversationId === variables.conversationId) {
					setConversationId(null);
					setMessages([]);
					loadedConvIdRef.current = null;
				}
			},
			onError: () => toast.error(t("conversationDeleteError")),
		}),
	);

	// --- Abort on unmount --------------------------------------------------
	useEffect(() => {
		return () => {
			abortRef.current?.abort();
		};
	}, []);

	// --- Send message -------------------------------------------------------
	const send = useCallback(
		async (text: string) => {
			const trimmed = text.trim();
			if (!trimmed || streaming) {
				return;
			}

			abortRef.current?.abort();
			const controller = new AbortController();
			abortRef.current = controller;

			const userMessage: ChatMessage = {
				id: `user-${Date.now()}`,
				role: "user",
				content: trimmed,
			};
			const assistantId = `assistant-${Date.now()}`;

			const history = [...messages, userMessage].map((m) => ({
				role: m.role,
				content: m.content,
			}));

			setMessages((prev) => [
				...prev,
				userMessage,
				{ id: assistantId, role: "assistant", content: "" },
			]);
			setInput("");
			setStreaming(true);

			// If no active conversation yet, we let the backend create one
			// on the first message by not passing conversationId; after the
			// stream finishes, we refresh the list so the new conversation
			// appears.
			let activeConvId = conversationId;

			// Mirror what the server persists for a cut-short reply: keep the
			// partial text, mark it interrupted, and never leave an empty
			// assistant bubble behind.
			const finalizeInterrupted = () => {
				setMessages((prev) =>
					prev
						.filter(
							(item) =>
								!(
									item.id === assistantId &&
									item.content === ""
								),
						)
						.map((item) =>
							item.id === assistantId
								? { ...item, interrupted: true }
								: item,
						),
				);
			};

			try {
				// If no conversation exists, create one first so the turn is persisted.
				if (!activeConvId) {
					try {
						const conv =
							await orpcClient.atlas.conversations.create({
								projectId,
								repositoryIntegrationId:
									repositoryIntegrationId ?? undefined,
								organizationId: organizationId ?? null,
								isSystemScope: isSystemScope ? true : undefined,
							});
						activeConvId = conv.id;
						// We already hold this conversation's messages locally
						// (the optimistic user + streaming assistant turns), so
						// mark it loaded — with no hydration snapshot — to stop
						// the hydration effect wiping them with the
						// freshly-created (empty) server conversation.
						loadedConvIdRef.current = conv.id;
						hydratedSnapshotRef.current = null;
						setConversationId(conv.id);
					} catch {
						// Non-fatal: proceed without persisting — the chat still works.
					}
				}

				const iterator = systemScope
					? await orpcClient.atlas.systemChat(
							{
								projectId,
								mode,
								focusNodeKey: focusNodeKey ?? undefined,
								repositoryIntegrationIds:
									systemScope.repositoryIntegrationIds,
								organizationId: organizationId ?? null,
								messages: history,
								conversationId: activeConvId ?? undefined,
							},
							{ signal: controller.signal },
						)
					: await orpcClient.atlas.chat(
							{
								projectId,
								mode,
								focusNodeKey: focusNodeKey ?? undefined,
								repositoryIntegrationId:
									repositoryIntegrationId ?? undefined,
								organizationId: organizationId ?? null,
								messages: history,
								conversationId: activeConvId ?? undefined,
							},
							{ signal: controller.signal },
						);

				// The server streams plain text deltas as oRPC events, then may
				// append ONE terminal object sentinel: "atlas-chat-interrupted"
				// (cut short, salvaged server-side) or
				// "atlas-chat-persist-failed" (finished but not saved).
				// Provider errors end the stream NORMALLY (no exception), so the
				// sentinels — plus the defensive empty-end below — are the only
				// signal the turn went wrong.
				let assistantText = "";
				let persistFailureNotified = false;
				let interruptedNotified = false;
				for await (const delta of iterator) {
					if (controller.signal.aborted) {
						break;
					}
					if (typeof delta === "string") {
						assistantText += delta;
						setMessages((prev) =>
							prev.map((m) =>
								m.id === assistantId
									? { ...m, content: assistantText }
									: m,
							),
						);
						continue;
					}
					const sentinel = chatStreamSentinelOf(delta);
					if (
						sentinel === "atlas-chat-persist-failed" &&
						!persistFailureNotified
					) {
						// Keep the rendered answer — only the history write
						// failed, and the warning fires at most once per send.
						// The local thread is now AHEAD of the server copy, so
						// pin it against re-hydration until the user switches.
						persistFailureNotified = true;
						hydratedSnapshotRef.current = "pinned";
						toast.warning(t("turnNotSaved"));
					} else if (
						sentinel === "atlas-chat-interrupted" &&
						!interruptedNotified
					) {
						// Mirror the server's salvage immediately: mark the
						// partial (or drop an empty bubble) without a reload.
						interruptedNotified = true;
						finalizeInterrupted();
						if (assistantText === "") {
							// Nothing was rendered — never leave the user with
							// silence (the empty bubble was just dropped).
							toast.error(t("error"), {
								description: t("interrupted"),
							});
						}
					}
				}

				if (controller.signal.aborted) {
					finalizeInterrupted();
				} else if (!interruptedNotified && assistantText === "") {
					// Defensive: the stream ended normally with no delta and no
					// sentinel — never strand a forever-spinning empty bubble.
					finalizeInterrupted();
					toast.error(t("error"), {
						description: t("interrupted"),
					});
				}

				// Refresh the conversation list after a turn completes.
				queryClient.invalidateQueries({
					queryKey: conversationsListKey,
				});
			} catch (error) {
				if (controller.signal.aborted) {
					finalizeInterrupted();
					return;
				}
				const message =
					error instanceof Error ? error.message : String(error);
				toast.error(t("error"), { description: message });
				// Drop an empty assistant bubble; keep (and mark) a partial one
				// — the server salvaged the same partial text on its side.
				finalizeInterrupted();
			} finally {
				if (abortRef.current === controller) {
					abortRef.current = null;
				}
				setStreaming(false);
				// The server persisted (at least) the user turn before
				// streaming, so the active conversation's cached detail is now
				// stale — drop it so the next hydration (e.g. switching away
				// and back) fetches the post-turn thread instead of replaying
				// a pre-turn snapshot.
				if (activeConvId) {
					queryClient.invalidateQueries({
						queryKey: orpc.atlas.conversations.get.queryKey({
							input: {
								projectId,
								conversationId: activeConvId,
								organizationId: organizationId ?? null,
							},
						}),
					});
				}
			}
		},
		[
			messages,
			streaming,
			projectId,
			mode,
			focusNodeKey,
			repositoryIntegrationId,
			organizationId,
			conversationId,
			conversationsListKey,
			t,
			queryClient,
		],
	);

	// Consume a seeded prompt from "Ask AI about this" on the node panel.
	useEffect(() => {
		if (!seededPrompt) {
			return;
		}
		onSeededPromptConsumed();
		void send(seededPrompt.value);
	}, [seededPrompt?.nonce]);

	// Auto-scroll to the latest message while streaming.
	useEffect(() => {
		const container = scrollRef.current;
		if (container) {
			container.scrollTop = container.scrollHeight;
		}
	}, [messages]);

	// Auto-grow the composer textarea with its content up to the max height
	// (`max-h-32` = 128px), then let it scroll internally. Keeps the single-line
	// resting height aligned with the send button so the row stays centred.
	useEffect(() => {
		const el = textareaRef.current;
		if (!el) {
			return;
		}
		el.style.height = "auto";
		el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
	}, [input]);

	const handleSubmit = (event: React.FormEvent) => {
		event.preventDefault();
		void send(input);
	};

	const handleSelectConversation = useCallback(
		(conv: ConversationSummary) => {
			// Force the hydration effect to reload this conversation from the
			// server (even if re-selecting the same id after clearing).
			loadedConvIdRef.current = null;
			setConversationId(conv.id);
			setMessages([]);
			setShowConversationList(false);
		},
		[],
	);

	const handleNewConversation = useCallback(() => {
		loadedConvIdRef.current = null;
		setConversationId(null);
		setMessages([]);
		setShowConversationList(false);
	}, []);

	// Determine the title shown in the chat header. One assistant for both
	// graph views — the fallback title never depends on the active mode.
	const activeConversation = conversations.find(
		(c) => c.id === conversationId,
	);
	const chatTitle = t("assistantTitle");

	// Empty-state starter chips: a dynamic capability question (when the graph
	// surfaces a most-connected node) followed by static i18n templates. Capped
	// at four and only shown while there are no messages.
	const suggestions = useMemo(() => {
		const items: string[] = [];
		if (suggestedCapability) {
			items.push(
				t("suggestions.capabilityDepends", {
					capability: suggestedCapability,
				}),
			);
		}
		items.push(t("suggestions.authentication"));
		items.push(t("suggestions.isolation"));
		items.push(t("suggestions.schema"));
		return items.slice(0, 4);
	}, [t, suggestedCapability]);

	// Components for the node-linkified ReactMarkdown renderer (AC#4). The
	// assistant frequently emphasises node names in **bold**, lists, and
	// headings, so the linkifier runs on the direct text of each of those
	// elements (never code blocks). Nested elements are handled by their own
	// override, so each text node is linkified exactly once.
	const markdownComponents = useMemo(() => {
		const linkify = (children: any) =>
			flatMapChildren(children, (child, i) =>
				typeof child === "string" ? (
					<NodeLinkifiedText
						key={i}
						graphNodes={graphNodes}
						onFocusNode={onFocusNode}
					>
						{child}
					</NodeLinkifiedText>
				) : (
					child
				),
			);
		const make =
			(tag: string) =>
			({ children, node, ...props }: { children?: any; node?: any }) =>
				createElement(tag, props, linkify(children));
		return {
			p: make("p"),
			li: make("li"),
			strong: make("strong"),
			em: make("em"),
			h1: make("h1"),
			h2: make("h2"),
			h3: make("h3"),
			h4: make("h4"),
			td: make("td"),
			th: make("th"),
			// The chat lives in a narrow side column, so wide tables and code
			// blocks must scroll horizontally inside the bubble instead of
			// overflowing and getting clipped at the right edge.
			table: ({
				children,
				node: _node,
				...props
			}: {
				children?: any;
				node?: any;
			}) => (
				<div className="my-2 max-w-full overflow-x-auto">
					{createElement("table", props, children)}
				</div>
			),
			pre: ({
				children,
				node: _node,
				...props
			}: {
				children?: any;
				node?: any;
			}) => (
				<div className="my-2 max-w-full overflow-x-auto">
					{createElement("pre", props, children)}
				</div>
			),
			// The assistant frequently wraps module / capability names in inline
			// code (`StateProviding`), so linkify those too — but leave fenced
			// code blocks (language-*) untouched as literal code.
			code: ({
				children,
				className,
				node: _node,
				...props
			}: {
				children?: any;
				className?: string;
				node?: any;
			}) => {
				const isBlock =
					typeof className === "string" &&
					className.includes("language-");
				return createElement(
					"code",
					{ className, ...props },
					isBlock ? children : linkify(children),
				);
			},
		};
	}, [graphNodes, onFocusNode]);

	// A single conversation row (rename form when editing, otherwise the
	// selectable row + owner actions). Shared across every recency bucket.
	const renderConversationRow = (conv: ConversationSummary) =>
		renamingId === conv.id ? (
			<ConversationRenameForm
				initial={conv.title}
				onSave={(title) =>
					updateConversationMutation.mutate({
						projectId,
						conversationId: conv.id,
						title,
						organizationId: organizationId ?? null,
					})
				}
				onCancel={() => setRenamingId(null)}
			/>
		) : (
			<div
				className={cn(
					"flex w-full min-w-0 items-center gap-1 rounded-lg px-2 py-1.5",
					conv.id === conversationId
						? "bg-accent"
						: "hover:bg-accent/60",
				)}
			>
				<Tooltip>
					<TooltipTrigger asChild>
						<button
							type="button"
							onClick={() => handleSelectConversation(conv)}
							className="flex min-w-0 flex-1 items-center gap-2 rounded text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
						>
							<span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
								{conv.title}
							</span>
							<span className="flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground">
								{conv.visibility === "SHARED" ? (
									<>
										<GlobeIcon
											aria-hidden="true"
											className="size-2.5 shrink-0"
										/>
										<span className="max-w-[9rem] truncate">
											{t("conversationSharedBy", {
												name: conv.ownerName ?? "",
											})}
										</span>
									</>
								) : (
									<>
										<LockIcon
											aria-hidden="true"
											className="size-2.5 shrink-0"
										/>
										{t("conversationPrivate")}
									</>
								)}
								<span
									aria-hidden="true"
									className="text-muted-foreground/40"
								>
									·
								</span>
								<span className="shrink-0">
									{formatRelativeTime(conv.updatedAt)}
								</span>
							</span>
						</button>
					</TooltipTrigger>
					<TooltipContent>{conv.title}</TooltipContent>
				</Tooltip>
				{conv.isOwner && (
					<DropdownMenu>
						<DropdownMenuTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("conversationMoreActions")}
								className="shrink-0"
							>
								<MoreHorizontalIcon
									aria-hidden="true"
									className="size-3.5"
								/>
							</Button>
						</DropdownMenuTrigger>
						<DropdownMenuContent align="end">
							<DropdownMenuItem
								onClick={() => setRenamingId(conv.id)}
							>
								<PencilIcon
									aria-hidden="true"
									className="mr-2 size-4"
								/>
								{t("conversationRename")}
							</DropdownMenuItem>
							<DropdownMenuItem
								onClick={() =>
									updateConversationMutation.mutate({
										projectId,
										conversationId: conv.id,
										visibility:
											conv.visibility === "SHARED"
												? "PRIVATE"
												: "SHARED",
										organizationId: organizationId ?? null,
									})
								}
							>
								{conv.visibility === "SHARED" ? (
									<>
										<LockIcon
											aria-hidden="true"
											className="mr-2 size-4"
										/>
										{t("conversationMakePrivate")}
									</>
								) : (
									<>
										<GlobeIcon
											aria-hidden="true"
											className="mr-2 size-4"
										/>
										{t("conversationMakeShared")}
									</>
								)}
							</DropdownMenuItem>
							<DropdownMenuSeparator />
							<DropdownMenuItem
								className="text-destructive focus:text-destructive"
								onClick={() =>
									deleteConversationMutation.mutate({
										projectId,
										conversationId: conv.id,
										organizationId: organizationId ?? null,
									})
								}
							>
								<Trash2Icon
									aria-hidden="true"
									className="mr-2 size-4"
								/>
								{t("conversationDelete")}
							</DropdownMenuItem>
						</DropdownMenuContent>
					</DropdownMenu>
				)}
			</div>
		);

	return (
		<section
			aria-label={t("regionLabel")}
			className="flex h-full flex-col rounded-xl border border-border/60 bg-card"
		>
			<header className="flex items-center gap-2 border-b border-border/60 px-4 py-3">
				<SparklesIcon
					aria-hidden="true"
					className="size-4 text-primary"
				/>
				<h3
					title={activeConversation?.title ?? chatTitle}
					className="min-w-0 flex-1 truncate font-medium text-sm text-foreground"
				>
					{activeConversation?.title ?? chatTitle}
				</h3>
				<div className="flex items-center gap-1">
					{/* Conversations drawer toggle */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("conversations")}
								onClick={() =>
									setShowConversationList((v) => !v)
								}
								aria-expanded={showConversationList}
							>
								<MessageSquareMoreIcon
									aria-hidden="true"
									className="size-4"
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("conversations")}</TooltipContent>
					</Tooltip>
					{/* New conversation */}
					<Tooltip>
						<TooltipTrigger asChild>
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("newConversation")}
								onClick={handleNewConversation}
							>
								<MessageSquarePlusIcon
									aria-hidden="true"
									className="size-4"
								/>
							</Button>
						</TooltipTrigger>
						<TooltipContent>{t("newConversation")}</TooltipContent>
					</Tooltip>
				</div>
			</header>

			{showConversationList ? (
				/* History view — replaces the chat body + composer within the
				   panel's fixed height (its own internal scroll), so opening
				   history never grows the panel. */
				<div className="flex min-h-0 flex-1 flex-col">
					<div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-2">
						<span className="text-[11px] uppercase tracking-[0.16em] text-muted-foreground">
							{t("conversations")}
						</span>
						<div className="flex items-center gap-1.5">
							{conversationsTotal > 0 && (
								<span
									role="img"
									aria-label={t("conversationsTotal", {
										count: conversationsTotal,
									})}
									className="rounded-full bg-muted/60 px-1.5 py-0.5 text-[10px] font-medium tabular-nums text-muted-foreground"
								>
									{conversationsTotal}
								</span>
							)}
							<Button
								type="button"
								variant="ghost"
								size="icon-sm"
								aria-label={t("conversationsClose")}
								onClick={() => setShowConversationList(false)}
								className="-mr-1"
							>
								<XIcon aria-hidden="true" className="size-4" />
							</Button>
						</div>
					</div>
					<div className="min-h-0 flex-1 overflow-y-auto overscroll-contain p-2">
						{conversationsQuery.isLoading ? (
							<div className="flex items-center justify-center py-6">
								<Loader2Icon className="size-4 text-muted-foreground motion-safe:animate-spin" />
							</div>
						) : conversations.length === 0 ? (
							<p className="px-2 py-6 text-center text-sm text-muted-foreground">
								{t("conversationsEmpty")}
							</p>
						) : (
							<div className="flex flex-col gap-3">
								{RECENT_BUCKETS.map((bucket) =>
									groupedConversations[bucket].length ===
									0 ? null : (
										<div
											key={bucket}
											className="flex flex-col gap-0.5"
										>
											<p className="px-2 pb-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
												{t(BUCKET_LABEL_KEY[bucket])}
											</p>
											<ul className="flex flex-col gap-0.5 overflow-x-hidden">
												{groupedConversations[
													bucket
												].map((conv) => (
													<li key={conv.id}>
														{renderConversationRow(
															conv,
														)}
													</li>
												))}
											</ul>
										</div>
									),
								)}
								{groupedConversations.older.length > 0 && (
									<div className="flex flex-col gap-0.5">
										<button
											type="button"
											onClick={() =>
												setOlderExpanded((v) => !v)
											}
											aria-expanded={olderExpanded}
											className="flex items-center gap-1 rounded px-2 py-1 text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70 transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
										>
											<ChevronDownIcon
												aria-hidden="true"
												className={cn(
													"size-3 transition-transform",
													olderExpanded
														? ""
														: "-rotate-90",
												)}
											/>
											{t("conversationsBucketOlder")}
											<span className="text-muted-foreground/50">
												{
													groupedConversations.older
														.length
												}
											</span>
										</button>
										{olderExpanded && (
											<ul className="flex flex-col gap-0.5 overflow-x-hidden">
												{groupedConversations.older.map(
													(conv) => (
														<li key={conv.id}>
															{renderConversationRow(
																conv,
															)}
														</li>
													),
												)}
											</ul>
										)}
									</div>
								)}
								{conversationsQuery.hasNextPage && (
									<Button
										type="button"
										variant="ghost"
										size="sm"
										onClick={() =>
											conversationsQuery.fetchNextPage()
										}
										disabled={
											conversationsQuery.isFetchingNextPage
										}
										className="w-full gap-1.5 text-muted-foreground hover:text-foreground"
									>
										{conversationsQuery.isFetchingNextPage && (
											<Loader2Icon
												aria-hidden="true"
												className="size-3.5 motion-safe:animate-spin"
											/>
										)}
										{t("conversationsShowMore")}
									</Button>
								)}
							</div>
						)}
					</div>
				</div>
			) : messages.length === 0 ? (
				// Empty state: a narrow block centered both vertically and
				// horizontally in the chat area. It sits outside the ScrollArea
				// (no messages → nothing to scroll) and centers against the
				// panel's fixed height. `m-auto` inside an `overflow-y-auto`
				// flex column keeps it centred yet scroll-safe when the panel is
				// short or zoomed in — the chips never get clipped.
				<div className="flex flex-1 flex-col overflow-y-auto p-4">
					<div className="m-auto flex w-full max-w-xs flex-col items-center gap-4 text-center">
						<MessageSquareTextIcon
							aria-hidden="true"
							className="size-6 text-muted-foreground"
						/>
						<p className="text-balance text-sm text-muted-foreground">
							{t("placeholder")}
						</p>
						{suggestions.length > 0 && (
							<ul
								aria-label={t("suggestionsLabel")}
								className="flex w-full flex-col gap-2"
							>
								{suggestions.map((suggestion) => (
									<li key={suggestion}>
										<button
											type="button"
											onClick={() =>
												void send(suggestion)
											}
											disabled={streaming}
											className="w-full rounded-lg border border-border/60 bg-card px-3 py-2 text-left text-[12.5px] text-muted-foreground transition-colors hover:border-primary/50 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
										>
											{suggestion}
										</button>
									</li>
								))}
							</ul>
						)}
					</div>
				</div>
			) : (
				<ScrollArea className="flex-1">
					<div
						ref={scrollRef}
						role="log"
						aria-live="polite"
						aria-atomic="false"
						className="space-y-4 p-4"
					>
						{messages.map((message) => (
							<div
								key={message.id}
								className={cn(
									"flex",
									message.role === "user"
										? "justify-end"
										: "justify-start",
								)}
							>
								<div
									className={cn(
										"flex min-w-0 max-w-[85%] flex-col",
										message.role === "user"
											? "items-end"
											: "items-start",
									)}
								>
									<div
										className={cn(
											"min-w-0 max-w-full overflow-hidden rounded-2xl px-3.5 py-2 text-sm",
											message.role === "user"
												? "bg-primary text-primary-foreground"
												: "bg-muted text-foreground",
										)}
									>
										{message.role === "assistant" ? (
											message.content ? (
												<div className="prose prose-sm dark:prose-invert max-w-full break-words [overflow-wrap:anywhere]">
													<ReactMarkdown
														remarkPlugins={[
															remarkGfm,
														]}
														components={
															markdownComponents
														}
													>
														{message.content}
													</ReactMarkdown>
												</div>
											) : (
												<Loader2Icon
													aria-hidden="true"
													className="size-4 motion-safe:animate-spin"
												/>
											)
										) : (
											<span className="whitespace-pre-wrap break-words">
												{message.content}
											</span>
										)}
									</div>
									{message.role === "assistant" &&
										message.interrupted && (
											<p className="mt-1 text-xs text-muted-foreground">
												{`— ${t("interrupted")}`}
											</p>
										)}
								</div>
							</div>
						))}
					</div>
				</ScrollArea>
			)}

			{!showConversationList && (
				<form
					onSubmit={handleSubmit}
					className="border-t border-border/60 p-3"
				>
					<label htmlFor={inputId} className="sr-only">
						{t("inputLabel")}
					</label>
					<div className="flex items-end gap-2 rounded-xl border border-input bg-background p-1.5 transition-colors focus-within:border-ring focus-within:ring-1 focus-within:ring-ring">
						<Textarea
							id={inputId}
							ref={textareaRef}
							value={input}
							onChange={(event) => setInput(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.shiftKey) {
									event.preventDefault();
									void send(input);
								}
							}}
							placeholder={t("inputPlaceholder")}
							rows={1}
							className="max-h-32 min-h-0 flex-1 resize-none border-0 bg-transparent px-1.5 py-1.5 text-sm leading-5 shadow-none focus-visible:ring-0"
						/>
						<Button
							type="submit"
							size="icon-sm"
							aria-label={t("send")}
							disabled={streaming || !input.trim()}
							className="rounded-lg"
						>
							{streaming ? (
								<Loader2Icon
									aria-hidden="true"
									className="size-4 motion-safe:animate-spin"
								/>
							) : (
								<SendHorizonalIcon
									aria-hidden="true"
									className="size-4"
								/>
							)}
						</Button>
					</div>
				</form>
			)}
		</section>
	);
}

/**
 * Helper: flat-map over React children, applying a transform to each leaf.
 * Used to post-process text nodes in ReactMarkdown paragraph components.
 */
function flatMapChildren(
	children: any,
	transform: (child: any, index: number) => any,
): any {
	if (Array.isArray(children)) {
		return children.map(transform);
	}
	return transform(children, 0);
}
