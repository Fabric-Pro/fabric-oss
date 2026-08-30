/**
 * TopicRow — the list's link to the Topic Item Page (Fizzy #1851, FR2).
 *
 * The Inbox row is where this gets delicate. Before 2A the title WAS the
 * disclosure button: it carried `data-testid="topic-disclosure"`,
 * `aria-expanded`, `aria-controls`, and an `aria-label` of
 * `"{title}, read|unread"` that is the row's only non-colour unread signal.
 * A `<Link>` cannot nest inside a `<button>`, so the disclosure moves to its
 * own chevron and MUST carry that same testid and that same accessible name —
 * otherwise the 18 disclosure assertions in `publishing-suite-inbox.test.tsx`
 * and its "signals unread with more than colour" case break, and the row
 * regresses on accessibility rather than on markup.
 *
 * These cases pin both halves: the title navigates, the chevron still
 * discloses, and the unread announcement survives the move.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { TopicRow } from "@saas/projects/components/publishing-suite/TopicRow";

function topic(overrides: Record<string, unknown> = {}) {
	return {
		id: "topic-1",
		title: "Alpha topic",
		pitch: "A short pitch.",
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-02T00:00:00Z"),
		snoozedUntil: null,
		snoozeReason: null,
		isSnoozed: false,
		isRead: false,
		suggestedPostTypes: [],
		relevantFunctionTags: [],
		postTypeRecommendations: [],
		contributors: [],
		rankReason: null,
		authorRecommendation: null,
		angle: null,
		subject: null,
		whySuggested: null,
		userPostTypes: null,
		meetingSpeakers: null,
		...overrides,
	};
}

function renderRow({
	inbox,
	topicHref = "/app/projects/proj-1/publishing/topic-1",
	overrides = {},
}: {
	inbox: boolean;
	topicHref?: string;
	overrides?: Record<string, unknown>;
}) {
	return render(
		<ul>
			<TopicRow
				topic={topic(overrides) as never}
				canEdit
				inbox={inbox}
				isPending={false}
				topicHref={topicHref}
				onChangeStatus={vi.fn().mockResolvedValue(undefined)}
				onChangePostTypes={vi.fn().mockResolvedValue(undefined)}
				onSetReadState={vi.fn().mockResolvedValue(undefined)}
				onSetSnooze={vi.fn().mockResolvedValue(undefined)}
			/>
		</ul>,
	);
}

describe("TopicRow — link to the Topic Item Page", () => {
	it("makes the title a real link in the Inbox layout", () => {
		// A real anchor, not an onClick handler: middle-click, Ctrl+click and
		// "open in new tab" all have to work, and only an href gives them.
		renderRow({ inbox: true });
		expect(
			screen.getByRole("link", { name: /alpha topic/i }),
		).toHaveAttribute("href", "/app/projects/proj-1/publishing/topic-1");
	});

	it("makes the title a real link in the flat layout", () => {
		renderRow({ inbox: false });
		expect(
			screen.getByRole("link", { name: /alpha topic/i }),
		).toHaveAttribute("href", "/app/projects/proj-1/publishing/topic-1");
	});

	it("carries the organization base path when in an org context", () => {
		renderRow({
			inbox: true,
			topicHref: "/app/acme/projects/proj-1/publishing/topic-1",
		});
		expect(
			screen.getByRole("link", { name: /alpha topic/i }),
		).toHaveAttribute(
			"href",
			"/app/acme/projects/proj-1/publishing/topic-1",
		);
	});
});

describe("TopicRow — the disclosure survives the move to a chevron", () => {
	it("still exposes a disclosure control with the same test id", () => {
		renderRow({ inbox: true });
		expect(screen.getByTestId("topic-disclosure")).toBeInTheDocument();
	});

	it("keeps the read/unread announcement on the disclosure control", () => {
		// This is the guard for the whole change: it is the row's only
		// non-colour unread signal, and `publishing-suite-inbox.test.tsx`
		// asserts exactly this accessible name.
		renderRow({ inbox: true });
		expect(
			screen.getByRole("button", { name: /alpha topic, unread/i }),
		).toBeInTheDocument();
	});

	it("expands the details region when the chevron is clicked", async () => {
		const user = userEvent.setup();
		renderRow({ inbox: true });

		const disclosure = screen.getByTestId("topic-disclosure");
		expect(disclosure).toHaveAttribute("aria-expanded", "false");

		await user.click(disclosure);
		expect(disclosure).toHaveAttribute("aria-expanded", "true");
	});

	it("marks the topic read when the chevron expands it (1D FR4)", async () => {
		const user = userEvent.setup();
		const onSetReadState = vi.fn().mockResolvedValue(undefined);
		render(
			<ul>
				<TopicRow
					topic={topic() as never}
					canEdit
					inbox
					isPending={false}
					topicHref="/app/projects/proj-1/publishing/topic-1"
					onChangeStatus={vi.fn().mockResolvedValue(undefined)}
					onChangePostTypes={vi.fn().mockResolvedValue(undefined)}
					onSetReadState={onSetReadState}
					onSetSnooze={vi.fn().mockResolvedValue(undefined)}
				/>
			</ul>,
		);

		await user.click(screen.getByTestId("topic-disclosure"));
		expect(onSetReadState).toHaveBeenCalledWith(true);
	});
});
