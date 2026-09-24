/**
 * The Roadmap's "Start Building Your Roadmap" empty state (Fizzy #2204).
 *
 * next-intl is mocked to echo keys, so the approved FR7–FR9 copy is pinned
 * against en.json directly.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CapabilityGateView } from "../../../lib/capability-gate-view";
import { RoadmapStartBuilding } from "../RoadmapStartBuilding";
import type { DoBothState } from "../roadmap-entry/do-both-sequence";
import type { EntryPointStates } from "../roadmap-entry/entry-point-states";

const trackEvent = vi.fn();
vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent }),
}));

const here = path.dirname(fileURLToPath(import.meta.url));
const en = JSON.parse(
	readFileSync(
		path.resolve(
			here,
			"../../../../../../../../packages/i18n/translations/en.json",
		),
		"utf8",
	),
);
const copy = en.projects.stories.startBuilding;

const enabled = {
	visible: true,
	disabled: false,
	reason: null,
	warning: null,
};

function entry(overrides: Partial<EntryPointStates> = {}): EntryPointStates {
	return {
		pull: enabled,
		recommend: enabled,
		doBoth: enabled,
		sync: enabled,
		...overrides,
	};
}

function renderIt(
	overrides: Partial<Parameters<typeof RoadmapStartBuilding>[0]> = {},
) {
	const props = {
		entry: entry(),
		hasItems: false,
		maturationStages: false,
		hiddenCount: 0,
		onShowHidden: vi.fn(),
		onPull: vi.fn(),
		onRecommend: vi.fn(),
		onDoBoth: vi.fn(),
		doBoth: { step: "idle" } as DoBothState,
		onRetryPull: vi.fn(),
		onRecommendInstead: vi.fn(),
		onDismissDoBoth: vi.fn(),
		isRecommendStarting: false,
		...overrides,
	};
	render(<RoadmapStartBuilding {...props} />);
	return props;
}

function card(entryPoint: string): HTMLButtonElement {
	const el = document.querySelector<HTMLButtonElement>(
		`[data-entry-point="${entryPoint}"]`,
	);
	if (!el) {
		throw new Error(`no ${entryPoint} card`);
	}
	return el;
}

describe("approved copy (FR2, FR7–FR9, FR33)", () => {
	it("pins the heading and the three descriptions verbatim", () => {
		expect(copy.heading).toBe("Start Building Your Roadmap");
		expect(copy.recommend.description).toBe(
			"Use Fabric’s project context to suggest feature candidates for review.",
		);
		expect(copy.pull.description).toBe(
			"Bring existing work items into Roadmap from your connected project management system.",
		);
		expect(copy.doBoth.description).toBe(
			"Pull existing work items first, then have Fabric recommend additional feature candidates from project context.",
		);
	});

	it("FR10: pins the mature-Roadmap description verbatim", () => {
		expect(en.projects.recommendations.menuDescription).toBe(
			"Ask Fabric to suggest additional feature candidates based on the current project context and Roadmap.",
		);
	});

	it("says 'Backlog or Done', not status jargon", () => {
		expect(copy.introWithItems).toContain("Backlog or Done");
		expect(copy.introWithItems).not.toMatch(/default or a final/);
	});

	it("on a Maturation V2 board, names the To Do stage instead of statuses", () => {
		expect(copy.introWithItemsMaturation).toContain("To Do");
		expect(copy.introWithItemsMaturation).not.toMatch(/Backlog/);
	});

	it("never says 'Seed'", () => {
		expect(JSON.stringify(copy)).not.toMatch(/seed/i);
	});
});

describe("RoadmapStartBuilding", () => {
	it("picks the intro for the board the items move through", () => {
		renderIt({ hasItems: true });
		expect(screen.getByText("introWithItems")).toBeInTheDocument();
	});

	it("uses the stage intro on a Maturation V2 board", () => {
		renderIt({ hasItems: true, maturationStages: true });
		expect(
			screen.getByText("introWithItemsMaturation"),
		).toBeInTheDocument();
	});

	it("renders the heading and all three options", () => {
		renderIt();
		expect(
			screen.getByRole("heading", { name: "heading" }),
		).toBeInTheDocument();
		expect(card("pull")).toBeEnabled();
		expect(card("recommend")).toBeEnabled();
		expect(card("do-both")).toBeEnabled();
	});

	it("does not render Recommend or Do both when they are not visible", () => {
		const hiddenState = {
			visible: false,
			disabled: false,
			reason: null,
			warning: null,
		};
		renderIt({
			entry: entry({ recommend: hiddenState, doBoth: hiddenState }),
		});
		expect(card("pull")).toBeInTheDocument();
		expect(
			document.querySelector('[data-entry-point="recommend"]'),
		).toBeNull();
		expect(
			document.querySelector('[data-entry-point="do-both"]'),
		).toBeNull();
	});

	it("exposes a disabled card's reason through aria-describedby", () => {
		renderIt({
			entry: entry({
				pull: {
					visible: true,
					disabled: true,
					reason: { kind: "permission" },
					warning: null,
				},
			}),
		});
		const pull = card("pull");
		expect(pull).toBeDisabled();
		const ids = pull.getAttribute("aria-describedby")?.split(" ") ?? [];
		expect(ids).toHaveLength(2);
		const described = ids
			.map((id) => document.getElementById(id)?.textContent)
			.join(" ");
		expect(described).toContain("pull.description");
		expect(described).toContain("permission");
	});

	it("FR37: renders a gate's title and body as separate elements, never joined", () => {
		const view = {
			title: "reason.roadmap.pm-not-connected.title",
			body: "reason.roadmap.pm-not-connected.body",
			params: { dependency: "" },
			ctaKind: "navigate",
			ctaTarget: "integrations",
			ctaLabel: "remedy.configureIntegration",
		} as unknown as CapabilityGateView;
		renderIt({
			entry: entry({
				pull: {
					visible: true,
					disabled: true,
					reason: { kind: "gate", view },
					warning: null,
				},
			}),
		});
		// Exact text per element: a joined "title. body" matches neither.
		expect(
			screen.getByText("reason.roadmap.pm-not-connected.title"),
		).toBeInTheDocument();
		expect(
			screen.getByText("reason.roadmap.pm-not-connected.body"),
		).toBeInTheDocument();
	});

	it("S4: Recommend says a run is already in flight", () => {
		renderIt({
			entry: entry({
				recommend: {
					visible: true,
					disabled: true,
					reason: { kind: "recommending" },
					warning: null,
				},
			}),
		});
		const recommend = card("recommend");
		expect(recommend).toBeDisabled();
		const described = (recommend.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent)
			.join(" ");
		expect(described).toContain("running");
	});

	it("FR56/FR59: shows a warning under Recommend without disabling it", () => {
		const warning = {
			capabilityKey: "roadmap.recommend-features",
			reasonKey: "context.thin",
			state: "WARNING",
			title: "reason.context.thin.title",
			body: "reason.context.thin.body",
			params: { dependency: "" },
			dismissible: true,
		} as unknown as CapabilityGateView;
		renderIt({
			entry: entry({
				recommend: { ...enabled, warning },
			}),
		});
		const recommend = card("recommend");
		expect(recommend).toBeEnabled();
		const described = (recommend.getAttribute("aria-describedby") ?? "")
			.split(" ")
			.map((id) => document.getElementById(id)?.textContent)
			.join(" ");
		expect(described).toContain("reason.context.thin.body");
		expect(
			screen.getByRole("button", { name: "dismiss.action" }),
		).toBeInTheDocument();
	});

	it("tracks the chosen entry point and runs its handler", async () => {
		const user = userEvent.setup();
		const props = renderIt();
		await user.click(card("do-both"));
		expect(props.onDoBoth).toHaveBeenCalledTimes(1);
		expect(trackEvent).toHaveBeenCalledWith(
			"roadmap_entry_point_selected",
			{
				entryPoint: "do-both",
				placement: "empty",
			},
		);
	});

	function steps(): HTMLElement {
		const list = screen.getByRole("list");
		expect(list).toHaveAttribute("aria-live", "polite");
		return list;
	}

	it("reports Do both steps as text in a live region, not colour alone", () => {
		renderIt({ doBoth: { step: "pulling", workflowId: "wf_1" } });
		expect(steps()).toHaveTextContent("pull.running");
		expect(steps()).toHaveTextContent("recommend.waiting");
	});

	it("keeps the buttons out of the live region", () => {
		renderIt({ doBoth: { step: "pull-failed", message: null } });
		expect(steps().querySelector("button")).toBeNull();
		expect(
			screen
				.getByRole("button", { name: "retryPull" })
				.closest("[aria-live]"),
		).toBeNull();
	});

	it("S6: an unconfirmed pull stays unconfirmed once recommending", () => {
		renderIt({
			doBoth: { step: "recommend-started", pull: "unknown" },
		});
		expect(steps()).toHaveTextContent("pull.unknown");
		expect(steps()).not.toHaveTextContent("pull.done");
	});

	it("FR44: nothing new to pull reads as its own result", () => {
		renderIt({
			doBoth: { step: "recommend-started", pull: "nothing-new" },
		});
		expect(steps()).toHaveTextContent("pull.nothingNew");
	});

	it("shows a start failure's title and body separately", () => {
		renderIt({
			doBoth: {
				step: "recommend-failed",
				failure: { title: "Title", body: "FR37 body" },
				pull: "failed",
			},
		});
		const alert = screen.getByRole("alert");
		expect(screen.getByText("Title")).toBeInTheDocument();
		expect(screen.getByText("FR37 body")).toBeInTheDocument();
		expect(alert).toHaveTextContent("TitleFR37 body");
	});

	it("offers retry and manual recommend after a failed pull", async () => {
		const user = userEvent.setup();
		const props = renderIt({
			doBoth: { step: "pull-failed", message: null },
		});
		expect(steps()).toHaveTextContent("pull.failed");
		await user.click(screen.getByRole("button", { name: "retryPull" }));
		await user.click(
			screen.getByRole("button", { name: "recommendInstead" }),
		);
		expect(props.onRetryPull).toHaveBeenCalledTimes(1);
		expect(props.onRecommendInstead).toHaveBeenCalledTimes(1);
	});

	it("says the pull could not be confirmed rather than guessing", () => {
		renderIt({ doBoth: { step: "pull-unknown", workflowId: "wf_1" } });
		expect(steps()).toHaveTextContent("pull.unknown");
	});

	it("links to hidden work items when there are some", async () => {
		const user = userEvent.setup();
		const props = renderIt({ hiddenCount: 3 });
		await user.click(screen.getByRole("button", { name: "showHidden" }));
		expect(props.onShowHidden).toHaveBeenCalledTimes(1);
	});

	it("carries the get-started anchor", () => {
		renderIt();
		expect(
			document.querySelector(
				'[data-onboarding-target="roadmap-start-building"]',
			),
		).not.toBeNull();
	});
});
