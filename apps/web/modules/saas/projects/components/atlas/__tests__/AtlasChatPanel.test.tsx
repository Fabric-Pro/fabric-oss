/**
 * Component tests for `<AtlasChatPanel />`.
 *
 * Coverage:
 *   - Generic assistant title in BOTH graph views (no mode-flavoured titles)
 *   - The active conversation survives a graph-mode toggle (no reset effect)
 *   - Conversations list query input / invalidation keys carry no `mode`
 *   - Terminal persist-failed sentinel ⇒ exactly one warning toast, rendered
 *     answer kept (and pinned against a newer answer-less refetch)
 *   - Terminal interrupted sentinel ⇒ partial kept with the live marker;
 *     empty turn ⇒ bubble dropped + one error toast (incl. the defensive
 *     no-sentinel empty stream — no stranded spinner)
 *   - Stored messages flagged `interrupted` render the calm inline marker
 *   - Post-send hydration: the active conversation's `get` cache is
 *     invalidated, a NEWER server snapshot re-hydrates, an equal/older one
 *     never clobbers the just-sent turns
 */

import type { AGUIEvent, RunAgentInput } from "@ag-ui/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ComponentProps } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	heldRuntimeAnswer,
	runtimeAnswer,
	runtimeRefusal,
	streamOf,
} from "./atlas-panel-streams";

// ----------------------------------------------------------------------------
// Mocks — defined BEFORE the component import per Vitest hoisting rules.
// ----------------------------------------------------------------------------

const chatFn = vi.fn();
const systemChatFn = vi.fn();
const createConversationFn = vi.fn();
const listFn = vi.fn();
const toastWarning = vi.fn();
const toastError = vi.fn();
const toastSuccess = vi.fn();

let conversationsData: Array<Record<string, unknown>> = [];
let conversationDetailById: Record<string, Record<string, unknown> | null> = {};

/**
 * Who is looking (the organization on screen, its role, a project guest),
 * whether `COPILOTKIT_ATLAS_CHAT` is on for them, and the agent runtime
 * requests the panel made, answered by `respond`.
 */
const access = vi.hoisted(() => ({
	flagOn: false,
	organizationId: null as string | null,
	userRole: null as string | null,
	isGuest: false,
	runs: [] as Array<{
		url: string;
		input: RunAgentInput;
		org?: string;
		signal: AbortSignal;
	}>,
	respond: null as
		| null
		| ((
				emit: (event: AGUIEvent) => void,
				signal: AbortSignal,
		  ) => Promise<void> | void),
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "COPILOTKIT_ATLAS_CHAT" && access.flagOn,
}));

vi.mock(
	"@saas/agents/lib/direct-runtime-transport",
	async (importOriginal) => ({
		...(await importOriginal<
			typeof import("@saas/agents/lib/direct-runtime-transport")
		>()),
		streamRuntime: async (args: {
			url: string;
			input: RunAgentInput;
			organizationId?: string;
			signal: AbortSignal;
			onEvent: (event: AGUIEvent) => void;
		}) => {
			access.runs.push({
				url: args.url,
				input: args.input,
				org: args.organizationId,
				signal: args.signal,
			});
			await access.respond?.(args.onEvent, args.signal);
		},
	}),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		atlas: {
			chat: (...args: unknown[]) => chatFn(...args),
			systemChat: (...args: unknown[]) => systemChatFn(...args),
			conversations: {
				create: (...args: unknown[]) => createConversationFn(...args),
				list: (...args: unknown[]) => listFn(...args),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		atlas: {
			conversations: {
				get: {
					queryOptions: (opts: {
						input: { conversationId?: string };
					}) => ({
						queryKey: ["conversations", "get", opts.input],
						// Read the map at fetch time so tests can stage
						// stale-then-fresh server responses.
						queryFn: async () =>
							conversationDetailById[
								opts.input.conversationId ?? ""
							] ?? null,
					}),
					queryKey: (opts: { input: unknown }) => [
						"conversations",
						"get",
						opts.input,
					],
				},
				update: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationFn: async () => ({}),
						...opts,
					}),
				},
				delete: {
					mutationOptions: (opts: Record<string, unknown>) => ({
						mutationFn: async () => ({}),
						...opts,
					}),
				},
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: access.organizationId,
		organizationSlug: null,
		basePath: "/app",
		loaded: true,
		userRole: access.userRole,
		isGuest: access.isGuest,
	}),
}));

vi.mock("sonner", () => ({
	toast: Object.assign(vi.fn(), {
		success: (...args: unknown[]) => toastSuccess(...args),
		error: (...args: unknown[]) => toastError(...args),
		warning: (...args: unknown[]) => toastWarning(...args),
	}),
}));

import type { GraphMode } from "@repo/atlas/types";
// Import AFTER mocks so the component picks up the stubs.
import { AtlasChatPanel } from "../AtlasChatPanel";

// ----------------------------------------------------------------------------
// Render helpers
// ----------------------------------------------------------------------------

type PanelOverrides = Partial<
	Pick<ComponentProps<typeof AtlasChatPanel>, "focusNodeKey" | "systemScope">
>;

function buildProps(mode: GraphMode = "BUSINESS", overrides?: PanelOverrides) {
	return {
		projectId: "proj-1",
		mode,
		focusNodeKey: null,
		repositoryIntegrationId: "integration-1",
		seededPrompt: null,
		onSeededPromptConsumed: vi.fn(),
		graphNodes: [],
		onFocusNode: vi.fn(),
		...overrides,
	};
}

function renderPanel(mode: GraphMode = "BUSINESS", overrides?: PanelOverrides) {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const props = buildProps(mode, overrides);
	const utils = render(
		<QueryClientProvider client={queryClient}>
			<AtlasChatPanel {...props} />
		</QueryClientProvider>,
	);
	const rerenderWithMode = (nextMode: GraphMode) =>
		utils.rerender(
			<QueryClientProvider client={queryClient}>
				<AtlasChatPanel {...buildProps(nextMode, overrides)} />
			</QueryClientProvider>,
		);
	return { ...utils, queryClient, props, rerenderWithMode };
}

async function ask(user: ReturnType<typeof userEvent.setup>, text: string) {
	await user.type(screen.getByLabelText("inputLabel"), text);
	await user.click(screen.getByRole("button", { name: "send" }));
}

/** Conversation summary fixture for the history list. */
function summaryOf(id: string, title: string): Record<string, unknown> {
	return {
		id,
		mode: "TECHNICAL",
		title,
		visibility: "PRIVATE",
		userId: "u1",
		ownerName: null,
		isOwner: true,
		updatedAt: new Date().toISOString(),
	};
}

/** Open the history list and select a conversation by its title. */
async function selectConversation(
	user: ReturnType<typeof userEvent.setup>,
	title: string,
) {
	await user.click(screen.getByRole("button", { name: "conversations" }));
	await user.click(await screen.findByText(title, { selector: "span" }));
}

beforeEach(() => {
	access.flagOn = false;
	access.organizationId = null;
	access.userRole = null;
	access.isGuest = false;
	access.runs.length = 0;
	access.respond = runtimeAnswer(["Hello ", "world"]);
	systemChatFn.mockReset();
	systemChatFn.mockImplementation(() => streamOf(["System answer"]));
	chatFn.mockReset();
	chatFn.mockImplementation(() => streamOf(["Hello ", "world"]));
	createConversationFn.mockReset();
	createConversationFn.mockResolvedValue({ id: "conv-new" });
	listFn.mockReset();
	// The infinite list query reads `conversationsData` at call time so tests can
	// stage fixtures before rendering; `total` matches so there's no next page.
	listFn.mockImplementation(async () => ({
		conversations: conversationsData,
		total: conversationsData.length,
	}));
	toastWarning.mockClear();
	toastError.mockClear();
	toastSuccess.mockClear();
	conversationsData = [];
	conversationDetailById = {};
});

// ----------------------------------------------------------------------------
// Generic assistant title
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — unified assistant title", () => {
	it.each(["BUSINESS", "TECHNICAL"] as const)(
		"shows the generic assistant title in %s view",
		(mode) => {
			renderPanel(mode);

			// Exactly one heading, and it is the mode-independent one — the
			// retired per-view titles can never come back through this header.
			const headings = screen.getAllByRole("heading");
			expect(headings).toHaveLength(1);
			expect(headings[0]).toHaveTextContent(/^assistantTitle$/);
		},
	);
});

// ----------------------------------------------------------------------------
// Conversation survives the graph toggle
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — mode toggle continuity", () => {
	it("restores an unchanged cached conversation when the current conversation is selected again", async () => {
		const user = userEvent.setup();
		conversationsData = [summaryOf("conv-1", "My conversation")];
		conversationDetailById["conv-1"] = {
			id: "conv-1",
			updatedAt: "2026-06-06T10:00:00.000Z",
			messages: [
				{ role: "user", content: "Example question" },
				{ role: "assistant", content: "Example cached answer" },
			],
		};
		renderPanel("BUSINESS");
		await selectConversation(user, "My conversation");
		await screen.findByText("Example cached answer");
		await selectConversation(user, "My conversation");
		expect(
			await screen.findByText("Example cached answer"),
		).toBeInTheDocument();
	});
	it("keeps the active conversation and its messages when the graph mode flips", async () => {
		const user = userEvent.setup();
		conversationsData = [summaryOf("conv-1", "My conversation")];
		conversationDetailById["conv-1"] = {
			id: "conv-1",
			updatedAt: "2026-06-06T10:00:00.000Z",
			messages: [
				{ role: "user", content: "What does the auth module do?" },
				{ role: "assistant", content: "It handles sign-in." },
			],
		};

		const { rerenderWithMode } = renderPanel("BUSINESS");

		// Open the history list and select the conversation.
		await selectConversation(user, "My conversation");

		// Hydrated thread + conversation title in the header.
		expect(
			await screen.findByText("It handles sign-in."),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "My conversation" }),
		).toBeInTheDocument();

		// Toggle the graph view — the conversation must survive untouched.
		rerenderWithMode("TECHNICAL");

		expect(
			screen.getByRole("heading", { name: "My conversation" }),
		).toBeInTheDocument();
		expect(screen.getByText("It handles sign-in.")).toBeInTheDocument();
	});

	it("shows BUSINESS and TECHNICAL conversations together in one list", async () => {
		const user = userEvent.setup();
		conversationsData = [
			{
				id: "conv-b",
				mode: "BUSINESS",
				title: "Business question",
				visibility: "PRIVATE",
				userId: "u1",
				ownerName: null,
				isOwner: true,
				updatedAt: new Date().toISOString(),
			},
			{
				id: "conv-t",
				mode: "TECHNICAL",
				title: "Technical question",
				visibility: "PRIVATE",
				userId: "u1",
				ownerName: null,
				isOwner: true,
				updatedAt: new Date().toISOString(),
			},
		];

		renderPanel("BUSINESS");
		await user.click(screen.getByRole("button", { name: "conversations" }));

		expect(
			await screen.findByText("Business question", { selector: "span" }),
		).toBeInTheDocument();
		expect(
			screen.getByText("Technical question", { selector: "span" }),
		).toBeInTheDocument();
	});
});

// ----------------------------------------------------------------------------
// Mode-free list query input + invalidation keys
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — list scoping", () => {
	it("never passes `mode` in the conversations list query input", async () => {
		const user = userEvent.setup();
		renderPanel("BUSINESS");

		// The list is fetched on mount; sending a turn invalidates it so it
		// re-fetches — neither fetch may carry a graph `mode` (one shared history).
		await waitFor(() => {
			expect(listFn).toHaveBeenCalled();
		});
		await user.type(screen.getByLabelText("inputLabel"), "hello assistant");
		await user.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(listFn.mock.calls.length).toBeGreaterThan(1);
		});

		expect(listFn.mock.calls.length).toBeGreaterThan(0);
		for (const call of listFn.mock.calls) {
			expect(call[0]).not.toHaveProperty("mode");
		}
	});

	it("creates new conversations without a mode field", async () => {
		const user = userEvent.setup();
		renderPanel("TECHNICAL");

		await user.type(screen.getByLabelText("inputLabel"), "hi");
		await user.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(createConversationFn).toHaveBeenCalledTimes(1);
		});
		expect(createConversationFn.mock.calls[0][0]).not.toHaveProperty(
			"mode",
		);
	});
});

// ----------------------------------------------------------------------------
// Persist-failed sentinel
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — persistence failure sentinel", () => {
	it("fires exactly one warning toast and keeps the rendered answer", async () => {
		const user = userEvent.setup();
		chatFn.mockImplementation(() =>
			streamOf([
				"Hello ",
				"world",
				{ type: "atlas-chat-persist-failed" },
				// Defensive double-fire — must still toast only once.
				{ type: "atlas-chat-persist-failed" },
			]),
		);
		renderPanel();

		await user.type(screen.getByLabelText("inputLabel"), "save this");
		await user.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(toastWarning).toHaveBeenCalledTimes(1);
		});
		expect(toastWarning).toHaveBeenCalledWith("turnNotSaved");
		// The in-memory thread keeps the streamed answer.
		expect(screen.getByText("Hello world")).toBeInTheDocument();
		// A persistence warning is not a chat error.
		expect(toastError).not.toHaveBeenCalled();
	});

	it("ignores unknown object events without toasting", async () => {
		const user = userEvent.setup();
		chatFn.mockImplementation(() =>
			streamOf(["Answer", { type: "some-future-event" }]),
		);
		renderPanel();

		await user.type(screen.getByLabelText("inputLabel"), "q");
		await user.click(screen.getByRole("button", { name: "send" }));

		expect(await screen.findByText("Answer")).toBeInTheDocument();
		expect(toastWarning).not.toHaveBeenCalled();
	});
});

// ----------------------------------------------------------------------------
// Interrupted marker
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — interrupted marker", () => {
	it("renders the calm marker under assistant messages stored as interrupted", async () => {
		const user = userEvent.setup();
		conversationsData = [summaryOf("conv-1", "Cut short")];
		conversationDetailById["conv-1"] = {
			id: "conv-1",
			updatedAt: "2026-06-06T10:00:00.000Z",
			messages: [
				{ role: "user", content: "Long question" },
				{
					role: "assistant",
					content: "Partial answer that was",
					interrupted: true,
				},
			],
		};

		renderPanel();
		await selectConversation(user, "Cut short");

		expect(
			await screen.findByText("Partial answer that was"),
		).toBeInTheDocument();
		expect(screen.getByText("— interrupted")).toBeInTheDocument();
	});

	it("renders no marker for completed messages", async () => {
		const user = userEvent.setup();
		conversationsData = [summaryOf("conv-2", "Complete")];
		conversationDetailById["conv-2"] = {
			id: "conv-2",
			updatedAt: "2026-06-06T10:00:00.000Z",
			messages: [
				{ role: "user", content: "Q" },
				{ role: "assistant", content: "Full answer." },
			],
		};

		renderPanel();
		await selectConversation(user, "Complete");

		expect(await screen.findByText("Full answer.")).toBeInTheDocument();
		expect(screen.queryByText("— interrupted")).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Interrupted sentinel (live, no reload)
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — interrupted sentinel", () => {
	it("error before the first token: drops the empty bubble and fires one error toast", async () => {
		const user = userEvent.setup();
		// Provider errors end the stream NORMALLY — only the sentinel arrives.
		chatFn.mockImplementation(() =>
			streamOf([{ type: "atlas-chat-interrupted" }]),
		);
		renderPanel();

		await user.type(screen.getByLabelText("inputLabel"), "doomed question");
		await user.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("error", {
				description: "interrupted",
			});
		});
		// Let the stream fully settle, then prove the toast fired exactly once
		// (the defensive empty-end branch must not double-fire).
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(toastError).toHaveBeenCalledTimes(1);

		// The user's message stays; the empty assistant bubble is gone — no
		// stranded spinner (the only svg in the log would be the loader) and
		// no marker for a dropped bubble.
		expect(screen.getByText("doomed question")).toBeInTheDocument();
		expect(screen.queryByText("— interrupted")).toBeNull();
		const log = screen.getByRole("log");
		expect(log.querySelectorAll("svg")).toHaveLength(0);
	});

	it("mid-stream sentinel: keeps the partial and shows the marker immediately", async () => {
		const user = userEvent.setup();
		chatFn.mockImplementation(() =>
			streamOf(["Partial ans", { type: "atlas-chat-interrupted" }]),
		);
		renderPanel();

		await user.type(screen.getByLabelText("inputLabel"), "q");
		await user.click(screen.getByRole("button", { name: "send" }));

		// Marker renders live — no reload required.
		expect(await screen.findByText("Partial ans")).toBeInTheDocument();
		expect(await screen.findByText("— interrupted")).toBeInTheDocument();
		// A salvaged partial is not an error and not a persistence failure.
		expect(toastError).not.toHaveBeenCalled();
		expect(toastWarning).not.toHaveBeenCalled();
	});

	it("defensive: a normally-ended empty stream without a sentinel never strands a spinner", async () => {
		const user = userEvent.setup();
		chatFn.mockImplementation(() => streamOf([]));
		renderPanel();

		await user.type(screen.getByLabelText("inputLabel"), "q");
		await user.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("error", {
				description: "interrupted",
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(toastError).toHaveBeenCalledTimes(1);
		const log = screen.getByRole("log");
		expect(log.querySelectorAll("svg")).toHaveLength(0);
	});
});

// ----------------------------------------------------------------------------
// Stale hydration after a send
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — stale hydration after a send", () => {
	const T0 = "2026-06-06T10:00:00.000Z";
	const T1 = "2026-06-06T10:05:00.000Z";

	function seedTwoConversations() {
		conversationsData = [
			summaryOf("conv-1", "First conversation"),
			summaryOf("conv-2", "Second conversation"),
		];
		conversationDetailById["conv-1"] = {
			id: "conv-1",
			updatedAt: T0,
			messages: [
				{ role: "user", content: "old question" },
				{ role: "assistant", content: "old answer" },
			],
		};
		conversationDetailById["conv-2"] = {
			id: "conv-2",
			updatedAt: T0,
			messages: [{ role: "user", content: "other thread" }],
		};
	}

	it("a turn sent in an open conversation survives switching away and back", async () => {
		const user = userEvent.setup();
		seedTwoConversations();
		// By the time the stream runs, the server has persisted the turn —
		// the post-send refetch returns the post-turn thread (newer snapshot).
		chatFn.mockImplementation(() => {
			conversationDetailById["conv-1"] = {
				id: "conv-1",
				updatedAt: T1,
				messages: [
					{ role: "user", content: "old question" },
					{ role: "assistant", content: "old answer" },
					{ role: "user", content: "new question" },
					{ role: "assistant", content: "new answer" },
				],
			};
			return streamOf(["new answer"]);
		});

		renderPanel();
		await selectConversation(user, "First conversation");
		await screen.findByText("old answer");

		await user.type(screen.getByLabelText("inputLabel"), "new question");
		await user.click(screen.getByRole("button", { name: "send" }));
		await screen.findByText("new answer");

		// Switch away…
		await selectConversation(user, "Second conversation");
		await screen.findByText("other thread");

		// …and back within the stale window: the just-sent exchange must
		// still be there — nothing visually disappears.
		await selectConversation(user, "First conversation");
		expect(await screen.findByText("new answer")).toBeInTheDocument();
		expect(screen.getByText("new question")).toBeInTheDocument();
		expect(screen.getByText("old answer")).toBeInTheDocument();
	});

	it("an equal/older server snapshot never clobbers the optimistic thread", async () => {
		const user = userEvent.setup();
		seedTwoConversations();
		// Server lag: the refetch after the send still returns the pre-turn
		// snapshot (same updatedAt) — it must NOT wipe the just-sent turns.
		chatFn.mockImplementation(() => streamOf(["new answer"]));

		renderPanel();
		await selectConversation(user, "First conversation");
		await screen.findByText("old answer");

		await user.type(screen.getByLabelText("inputLabel"), "new question");
		await user.click(screen.getByRole("button", { name: "send" }));
		await screen.findByText("new answer");

		// Let the post-send invalidation, refetch, and hydration effect settle.
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(screen.getByText("new answer")).toBeInTheDocument();
		expect(screen.getByText("new question")).toBeInTheDocument();
		expect(screen.getByText("old answer")).toBeInTheDocument();
	});

	it("a persist-failed answer stays pinned even when a newer answer-less snapshot arrives", async () => {
		const user = userEvent.setup();
		seedTwoConversations();
		chatFn.mockImplementation(() => {
			// The user turn persisted (newer updatedAt) but the assistant
			// append failed — the fresh server copy is missing the answer.
			conversationDetailById["conv-1"] = {
				id: "conv-1",
				updatedAt: T1,
				messages: [
					{ role: "user", content: "old question" },
					{ role: "assistant", content: "old answer" },
					{ role: "user", content: "new question" },
				],
			};
			return streamOf([
				"unsaved answer",
				{ type: "atlas-chat-persist-failed" },
			]);
		});

		renderPanel();
		await selectConversation(user, "First conversation");
		await screen.findByText("old answer");

		await user.type(screen.getByLabelText("inputLabel"), "new question");
		await user.click(screen.getByRole("button", { name: "send" }));

		await waitFor(() => {
			expect(toastWarning).toHaveBeenCalledTimes(1);
		});
		// Let the post-send refetch land the newer (answer-less) snapshot.
		await new Promise((resolve) => setTimeout(resolve, 50));
		// The rendered-but-unsaved answer must survive on screen.
		expect(screen.getByText("unsaved answer")).toBeInTheDocument();
	});
});

// ----------------------------------------------------------------------------
// Runtime transport
// ----------------------------------------------------------------------------

describe("AtlasChatPanel — runtime transport (COPILOTKIT_ATLAS_CHAT)", () => {
	beforeEach(() => {
		access.organizationId = "org-example-1";
		access.userRole = "member";
		access.isGuest = false;
	});

	it("runs a single-repository turn on the agent runtime under the conversation's id", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		renderPanel();

		await ask(user, "hello assistant");

		expect(await screen.findByText("Hello world")).toBeInTheDocument();
		expect(access.runs).toHaveLength(1);
		const [runtimeRun] = access.runs;
		expect(runtimeRun?.url).toBe(
			"/api/agents/runtime/agent/atlas-chat/run",
		);
		expect(runtimeRun?.input.threadId).toBe("conv-new");
		expect(runtimeRun?.input.forwardedProps).toEqual({
			projectId: "proj-1",
			repositoryIntegrationId: "integration-1",
			mode: "BUSINESS",
		});
		expect(
			runtimeRun?.input.messages.map(({ role, content }) => ({
				role,
				content,
			})),
		).toEqual([{ role: "user", content: "hello assistant" }]);
		expect(runtimeRun?.org).toBe("org-example-1");
		expect(runtimeRun?.signal).toBeInstanceOf(AbortSignal);
		expect(runtimeRun?.signal.aborted).toBe(false);
		expect(chatFn).not.toHaveBeenCalled();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("carries the focused node in forwardedProps", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		renderPanel("TECHNICAL", { focusNodeKey: "node-a" });

		await ask(user, "what does this do?");

		await screen.findByText("Hello world");
		expect(access.runs[0]?.input.forwardedProps).toEqual({
			projectId: "proj-1",
			repositoryIntegrationId: "integration-1",
			mode: "TECHNICAL",
			focusNodeKey: "node-a",
		});
	});

	it("a persist-failed note warns once and keeps the answer", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		access.respond = runtimeAnswer(
			["Hello ", "world"],
			["persist-failed", "persist-failed"],
		);
		renderPanel();

		await ask(user, "save this");

		await waitFor(() => {
			expect(toastWarning).toHaveBeenCalledTimes(1);
		});
		expect(toastWarning).toHaveBeenCalledWith("turnNotSaved");
		expect(screen.getByText("Hello world")).toBeInTheDocument();
		expect(toastError).not.toHaveBeenCalled();
	});

	it("an interrupted note keeps the partial with the marker; with nothing rendered it drops the bubble and shows one error toast", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		access.respond = runtimeAnswer(["Partial ans"], ["interrupted"]);
		const { unmount } = renderPanel();

		await ask(user, "q");

		expect(await screen.findByText("Partial ans")).toBeInTheDocument();
		expect(await screen.findByText("— interrupted")).toBeInTheDocument();
		expect(toastError).not.toHaveBeenCalled();
		unmount();

		access.respond = runtimeAnswer([], ["interrupted"]);
		renderPanel();

		await ask(user, "doomed question");

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("error", {
				description: "interrupted",
			});
		});
		await new Promise((resolve) => setTimeout(resolve, 25));
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(screen.queryByText("— interrupted")).toBeNull();
		expect(screen.getByRole("log").querySelectorAll("svg")).toHaveLength(0);
	});

	it.each([
		[
			"a RUN_ERROR shows its message in the error toast and drops the empty bubble",
			"NOT_FOUND",
			"This repository has not been analysed yet.",
		],
		[
			"a turn the runtime refuses because the conversation is still answering shows that in the toast",
			"THREAD_ALREADY_RUNNING",
			"This chat is still answering.",
		],
	])("%s", async (_label, code, message) => {
		const user = userEvent.setup();
		access.flagOn = true;
		access.respond = runtimeRefusal(code, message);
		renderPanel();

		await ask(user, "q");

		await waitFor(() => {
			expect(toastError).toHaveBeenCalledWith("error", {
				description: message,
			});
		});
		expect(toastError).toHaveBeenCalledTimes(1);
		expect(screen.getByText("q")).toBeInTheDocument();
		expect(screen.getByRole("log").querySelectorAll("svg")).toHaveLength(0);
	});

	it("the System map chat stays on atlas.systemChat even when eligible", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		renderPanel("BUSINESS", {
			systemScope: { repositoryIntegrationIds: ["integration-1"] },
		});

		await ask(user, "how do the services talk?");

		expect(await screen.findByText("System answer")).toBeInTheDocument();
		expect(systemChatFn).toHaveBeenCalledTimes(1);
		expect(access.runs).toHaveLength(0);
		expect(chatFn).not.toHaveBeenCalled();
	});

	it("keeps the transport chosen at mount", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		const first = renderPanel();
		access.flagOn = false;
		first.rerenderWithMode("BUSINESS");

		await ask(user, "first");

		await screen.findByText("Hello world");
		expect(access.runs).toHaveLength(1);
		expect(chatFn).not.toHaveBeenCalled();
		first.unmount();

		renderPanel().rerenderWithMode("BUSINESS");
		access.flagOn = true;

		await ask(user, "second");

		await screen.findByText("Hello world");
		expect(chatFn).toHaveBeenCalledTimes(1);
		expect(access.runs).toHaveLength(1);
	});

	it("a send whose conversation could not be created goes over the route, as today", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		createConversationFn.mockRejectedValue(new Error("create failed"));
		renderPanel();

		await ask(user, "hello");

		expect(await screen.findByText("Hello world")).toBeInTheDocument();
		expect(chatFn).toHaveBeenCalledTimes(1);
		expect(access.runs).toHaveLength(0);
	});

	it.each([
		["a project guest", { isGuest: true, userRole: null }],
		["a viewer", { isGuest: false, userRole: "viewer" }],
		[
			"a member whose role has not loaded",
			{ isGuest: false, userRole: null },
		],
	])("keeps %s on atlas.chat with the flag on", async (_label, viewer) => {
		const user = userEvent.setup();
		access.flagOn = true;
		access.isGuest = viewer.isGuest;
		access.userRole = viewer.userRole;
		renderPanel();

		await ask(user, "hello");

		await screen.findByText("Hello world");
		expect(chatFn).toHaveBeenCalledTimes(1);
		expect(access.runs).toHaveLength(0);
	});

	it("stays on atlas.chat while the flag is off", async () => {
		const user = userEvent.setup();
		renderPanel();

		await ask(user, "hello");

		await screen.findByText("Hello world");
		expect(chatFn).toHaveBeenCalledTimes(1);
		expect(access.runs).toHaveLength(0);
	});

	// Aborting the request is the only way a runtime turn ends early: the
	// engine then saves the partial and frees the conversation at once.
	it("lets go of a runtime answer silently when the panel unmounts mid-answer: its request is aborted", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		access.respond = heldRuntimeAnswer("Partial ans").respond;
		const { unmount } = renderPanel();

		await ask(user, "a long question");
		expect(await screen.findByText("Partial ans")).toBeInTheDocument();
		expect(access.runs).toHaveLength(1);
		expect(access.runs[0]?.signal.aborted).toBe(false);

		unmount();
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 20));
		});

		expect(access.runs[0]?.signal.aborted).toBe(true);
		expect(toastError).not.toHaveBeenCalled();
	});

	// A new send never meets an open runtime turn: the panel refuses to send
	// while an answer streams, so it neither aborts nor doubles the turn.
	it("starts no second runtime run while an answer streams, and leaves the open one to finish", async () => {
		const user = userEvent.setup();
		access.flagOn = true;
		const held = heldRuntimeAnswer("First answer");
		access.respond = held.respond;
		renderPanel();

		await ask(user, "first question");
		await screen.findByText("First answer");
		await user.type(
			screen.getByLabelText("inputLabel"),
			"second question{Enter}",
		);

		expect(access.runs).toHaveLength(1);
		expect(access.runs[0]?.signal.aborted).toBe(false);

		await act(async () => {
			held.finish();
		});

		await waitFor(() => {
			expect(screen.getByRole("button", { name: "send" })).toBeEnabled();
		});
		expect(access.runs).toHaveLength(1);
		expect(access.runs[0]?.signal.aborted).toBe(false);
		expect(screen.getByText("First answer")).toBeInTheDocument();
		expect(toastError).not.toHaveBeenCalled();
	});
});
