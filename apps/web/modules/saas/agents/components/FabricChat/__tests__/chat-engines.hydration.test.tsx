import { waitFor, within } from "@testing-library/react";
import { act } from "react";
import { hydrateRoot, type Root } from "react-dom/client";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationDetail } from "../../../lib/conversation-list";
import { createEngineView } from "./helpers/chat-engine-ssr-harness";

vi.mock("@tanstack/react-query", async (importOriginal) => {
	const actual =
		await importOriginal<typeof import("@tanstack/react-query")>();
	return {
		...actual,
		useQuery: () => ({
			data: undefined,
			isLoading: false,
			isPending: false,
		}),
	};
});
afterEach(() => vi.unstubAllGlobals());

describe("empty chat hydration", () => {
	it.each<["direct" | "orchestrator", boolean]>([
		["direct", false],
		["orchestrator", false],
		["orchestrator", true],
	])(
		"restores the saved %s transcript and composer; legacy settings=%s",
		async (mode, legacy) => {
			const writes: unknown[] = [];
			const network = vi.fn<typeof fetch>(async (input) => {
				const request =
					input instanceof Request ? input : new Request(input);
				if (
					legacy &&
					request.method === "POST" &&
					new URL(request.url).pathname ===
						"/api/rpc/agents/conversations/updateSettings"
				) {
					writes.push(await request.clone().json());
					return new Response(
						JSON.stringify({ json: { success: true } }),
						{ headers: { "content-type": "application/json" } },
					);
				}
				throw new Error("Unexpected navigation mutation");
			});
			vi.stubGlobal("fetch", network);
			const timestamp = "2026-01-01T00:00:00.000Z";
			const conversation: ConversationDetail = {
				id: "conversation-example",
				agentId: "fabric",
				title: "Saved example",
				pinned: false,
				status: "ACTIVE",
				visibility: "PRIVATE",
				createdAt: timestamp,
				updatedAt: timestamp,
				isOwn: true,
				owner: { id: "user-example", name: "Example user" },
				metadata: {
					mode,
					...(!legacy && { executionMode: "balanced" }),
					executions: [
						{
							id: "execution-example",
							userMessage: "Saved question",
							finalResponse: "Saved answer",
							stepResults: [],
							completedAt: timestamp,
							status: "success",
						},
					],
				},
				messages: [
					{
						id: "question-example",
						role: "user",
						content: "Saved question",
						timestamp,
					},
					{
						id: "answer-example",
						role: "assistant",
						content: "Saved answer",
						timestamp,
					},
				],
				trajectory: null,
				parentConversationId: null,
				carriedOverSummary: null,
				carriedOverAt: null,
			};
			const view = createEngineView(mode, conversation.id, conversation);
			const container = document.createElement("div");
			document.body.append(container);
			container.innerHTML = renderToString(view.element);
			expect(container.textContent).toContain("Loading conversation");
			expect(container.querySelector("textarea")).toBeNull();
			const recoverable = vi.fn();
			let root: Root | undefined;
			try {
				await act(async () => {
					root = hydrateRoot(container, view.element, {
						onRecoverableError: recoverable,
					});
				});
				await waitFor(() =>
					expect(
						within(container).getByText("Saved answer"),
					).toBeInTheDocument(),
				);
				expect(container.querySelector("textarea")).not.toBeNull();
				expect(container.textContent).not.toContain(
					"What do you want to get done?",
				);
				expect(recoverable).not.toHaveBeenCalled();
				if (legacy) {
					expect(network).toHaveBeenCalledOnce();
					expect(writes).toHaveLength(1);
					expect(JSON.stringify(writes)).toContain(
						'"conversationId":"conversation-example"',
					);
				} else {
					expect(network).not.toHaveBeenCalled();
				}
			} finally {
				await act(async () => root?.unmount());
				view.client.clear();
				container.remove();
			}
		},
	);
	it.each(["direct", "orchestrator"] as const)(
		"preserves the genuine %s welcome and composer without navigation mutations",
		async (mode) => {
			const network = vi.fn<typeof fetch>(() => {
				throw new Error("Unexpected navigation mutation");
			});
			vi.stubGlobal("fetch", network);
			const view = createEngineView(mode);
			const container = document.createElement("div");
			document.body.append(container);
			container.innerHTML = renderToString(view.element);
			const heading = container.querySelector("h1")?.textContent;
			const headingNode = container.querySelector("h1");
			const composerNode = container.querySelector("textarea");
			const recoverable = vi.fn();
			let root: Root | undefined;
			try {
				await act(async () => {
					root = hydrateRoot(container, view.element, {
						onRecoverableError: recoverable,
					});
				});
				expect(container.querySelector("h1")?.textContent).toBe(
					heading,
				);
				expect(heading).toBeTruthy();
				expect(container.querySelector("textarea")).not.toBeNull();
				expect(container.querySelector("h1")).toBe(headingNode);
				expect(container.querySelector("textarea")).toBe(composerNode);
				expect(recoverable).not.toHaveBeenCalled();
				expect(network).not.toHaveBeenCalled();
			} finally {
				await act(async () => root?.unmount());
				view.client.clear();
				container.remove();
			}
		},
	);
});
