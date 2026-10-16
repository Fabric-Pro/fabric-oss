/**
 * A shared conversation shows a teammate's answers as they wrote them, with the
 * real markdown renderer: an image they point at must not be fetched for the
 * reader.
 */
import { FABRIC_AGENT_ID } from "@repo/utils/page-limits";
import type { ConversationDetail } from "@saas/agents/lib/conversation-list";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { agents: { conversations: { continueInNewChat: vi.fn() } } },
}));
vi.mock("sonner", () => ({ toast: { error: vi.fn() } }));

import { SharedSessionView } from "../SharedSessionView";

function viewOf(content: string) {
	const conversation: ConversationDetail = {
		id: "shared-1",
		agentId: FABRIC_AGENT_ID,
		title: "Their notes",
		messages: [
			{
				id: "m1",
				role: "assistant",
				content,
				timestamp: "2026-10-14T09:00:00.000Z",
			},
		],
		trajectory: null,
		metadata: null,
		pinned: false,
		status: "ACTIVE",
		createdAt: "2026-10-14T09:00:00.000Z",
		updatedAt: "2026-10-14T10:00:00.000Z",
		visibility: "ORGANIZATION",
		isOwn: false,
		owner: { id: "u2", name: "Sam Example" },
		parentConversationId: null,
		carriedOverSummary: null,
		carriedOverAt: null,
	};
	return render(
		<QueryClientProvider client={new QueryClient()}>
			<SharedSessionView
				conversation={conversation}
				organizationId="org-1"
				engine="direct"
				onContinue={vi.fn()}
			/>
		</QueryClientProvider>,
	);
}

describe("images in a teammate's answers", () => {
	it("are shown as links, and nothing is loaded for the reader", async () => {
		const { container } = viewOf(
			"Here is the chart ![the chart](https://tracker.example/pixel.png?q=secret).",
		);

		const link = await screen.findByRole("link", { name: "the chart" });
		expect(link).toHaveAttribute(
			"href",
			"https://tracker.example/pixel.png?q=secret",
		);
		expect(link).toHaveAttribute("rel", "noopener noreferrer");
		expect(container.querySelector("img")).toBeNull();
	});

	it("are links too when the app's own image address is used", async () => {
		const { container } = viewOf(
			"![a screenshot](/api/storage/image?path=owner-only.png)",
		);

		expect(
			await screen.findByRole("link", { name: "a screenshot" }),
		).toBeInTheDocument();
		expect(container.querySelector("img")).toBeNull();
	});

	it("show the address when the image has no description", async () => {
		viewOf("![](https://example.com/a.png)");

		expect(
			await screen.findByRole("link", {
				name: "https://example.com/a.png",
			}),
		).toBeInTheDocument();
	});

	it("leave ordinary links as they are", async () => {
		viewOf("See [the plan](https://example.com/plan).");

		expect(
			await screen.findByRole("link", { name: "the plan" }),
		).toHaveAttribute("href", "https://example.com/plan");
	});
});
