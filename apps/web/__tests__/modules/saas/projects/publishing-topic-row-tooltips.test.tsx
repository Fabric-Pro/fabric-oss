/**
 * Hover/focus tooltips on the topic row's two icon-only controls (Fizzy #2265).
 *
 * The icons already carried `aria-label`, so a screen-reader user was never
 * stuck — but a sighted mouse user had no way to learn what the envelope and
 * the alarm clock do. Review feedback on the 1D Inbox asked for the visible
 * hint; these tests pin it.
 *
 * A SEPARATE file from publishing-suite-inbox.test.tsx on purpose. Radix opens
 * a tooltip on a 500ms timer, so asserting one needs fake timers for the whole
 * file; that suite runs real timers and holds mutations open through hand-built
 * gates, and switching its clock to satisfy this feature would put those gates
 * at risk for no gain here.
 *
 * `next-intl` is mocked globally as `t(key) => key` (vitest.setup.ts), which
 * has a sharp edge: a component asking for a key that does not exist renders
 * the key itself and every component assertion still passes. So the keys are
 * declared ONCE below, used both to drive the component assertions and to
 * check the catalogue — a typo in the component fails the first, a missing
 * entry in en.json fails the second.
 */

import en from "@repo/i18n/translations/en.json";
import { TopicRow } from "@saas/projects/components/publishing-suite/TopicRow";
import type { PublishingTopic } from "@saas/projects/components/publishing-suite/topic-shared";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Key under `tooltips.publishing`, per control and per state. */
const KEYS = {
	markRead: "markRead",
	markUnread: "markUnread",
	snooze: "snooze",
	unsnooze: "unsnooze",
} as const;

function makeTopic(overrides: Record<string, unknown> = {}) {
	return {
		id: "t1",
		title: "Alpha topic",
		pitch: "Alpha pitch",
		angle: null,
		status: "SUGGESTION",
		origin: "AI",
		declineReason: null,
		publishedUrl: null,
		createdById: null,
		createdAt: new Date("2026-08-01T00:00:00Z"),
		updatedAt: new Date("2026-08-01T00:00:00Z"),
		snoozedUntil: null,
		snoozeReason: null,
		isSnoozed: false,
		isRead: false,
		contributors: [],
		suggestedPostTypes: [],
		postTypeRecommendations: [],
		rankReason: null,
		authorRecommendation: null,
		subject: null,
		userPostTypes: null,
		whySuggested: null,
		meetingSpeakers: null,
		...overrides,
	};
}

function renderRow(overrides: Record<string, unknown> = {}) {
	return render(
		<TopicRow
			topic={makeTopic(overrides) as unknown as PublishingTopic}
			canEdit
			inbox
			isPending={false}
			topicHref="/topic/t1"
			onChangeStatus={async () => {}}
			onChangePostTypes={async () => {}}
			onSetReadState={async () => {}}
			onSetSnooze={async () => {}}
		/>,
	);
}

/**
 * Radix duplicates tooltip copy into a VisuallyHidden sibling that carries its
 * own `role="tooltip"`, so a role query matches twice. `data-slot` sits only on
 * the visible content element.
 */
function visibleTooltips(): HTMLElement[] {
	return Array.from(
		document.querySelectorAll<HTMLElement>('[data-slot="tooltip-content"]'),
	);
}

async function openTooltipOn(name: RegExp) {
	const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
	await user.hover(screen.getByRole("button", { name }));
	act(() => {
		vi.advanceTimersByTime(500);
	});
	await waitFor(() => {
		expect(visibleTooltips().length).toBeGreaterThan(0);
	});
	return visibleTooltips()[0] as HTMLElement;
}

describe("TopicRow icon tooltips", () => {
	beforeEach(() => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("shows no tooltip until the user asks for one", () => {
		renderRow();

		expect(visibleTooltips()).toHaveLength(0);
	});

	it("explains the read control on hover", async () => {
		renderRow();

		const tip = await openTooltipOn(/mark as read/i);

		expect(tip).toHaveTextContent(KEYS.markRead);
	});

	it("explains the read control's other state on hover", async () => {
		renderRow({ isRead: true });

		const tip = await openTooltipOn(/mark as unread/i);

		expect(tip).toHaveTextContent(KEYS.markUnread);
	});

	it("explains the snooze control on hover", async () => {
		renderRow();

		const tip = await openTooltipOn(/^snooze$/i);

		expect(tip).toHaveTextContent(KEYS.snooze);
	});

	it("explains the snooze control's other state on hover", async () => {
		renderRow({
			isSnoozed: true,
			snoozedUntil: new Date("2026-09-06T00:00:00Z"),
		});

		const tip = await openTooltipOn(/unsnooze/i);

		expect(tip).toHaveTextContent(KEYS.unsnooze);
	});

	// Hover alone would make this a mouse-only affordance. Radix opens on
	// focus too, and that is the half a keyboard user depends on.
	it("opens on keyboard focus, not only on hover", async () => {
		renderRow();

		screen.getByRole("button", { name: /mark as read/i }).focus();
		act(() => {
			vi.advanceTimersByTime(500);
		});

		await waitFor(() => {
			expect(visibleTooltips().length).toBeGreaterThan(0);
		});
		expect(visibleTooltips()[0]).toHaveTextContent(KEYS.markRead);
	});

	// The screen-reader name must survive: the tooltip is a visual addition,
	// not a replacement for the control's accessible name.
	it("keeps the accessible names the icons already had", () => {
		renderRow();

		expect(
			screen.getByRole("button", { name: /mark as read/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^snooze$/i }),
		).toBeInTheDocument();
	});
});

describe("tooltips.publishing copy catalogue", () => {
	const bucket = (en as Record<string, Record<string, unknown>>).tooltips
		?.publishing as Record<string, string> | undefined;

	it("exists", () => {
		expect(bucket).toBeDefined();
	});

	it.each(Object.values(KEYS))(
		"%s is a non-empty sentence, not a restated button label",
		(key) => {
			const copy = bucket?.[key];
			expect(typeof copy).toBe("string");
			expect((copy ?? "").length).toBeGreaterThan(20);
		},
	);

	it("says something different for each of the four states", () => {
		const values = Object.values(KEYS).map((k) => bucket?.[k]);
		expect(new Set(values).size).toBe(values.length);
	});
});
