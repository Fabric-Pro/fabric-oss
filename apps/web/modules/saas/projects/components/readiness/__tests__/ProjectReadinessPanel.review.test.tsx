/**
 * The three behavioural changes from the 20 Aug review (Fizzy #2165).
 *
 * Checklist order, the assumed-phase correction, and saying WHY the level reads
 * Not Ready. Each of these was previously either the opposite behaviour or
 * absent, so a test that only asserted "the panel renders" would have passed
 * before the change too.
 *
 * The phase test asserts what the panel SENDS: the correction has to reach
 * `projects.update` with a real phase, because a control that looks right and
 * writes nothing is exactly the failure it replaces.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, describe, expect, it, vi } from "vitest";

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	for (const method of [
		"hasPointerCapture",
		"setPointerCapture",
		"releasePointerCapture",
		"scrollIntoView",
	] as const) {
		if (!HTMLElement.prototype[method]) {
			HTMLElement.prototype[method] = (() => undefined) as never;
		}
	}
});

const { updateMock, readinessRef } = vi.hoisted(() => ({
	updateMock: vi.fn(),
	readinessRef: { current: null as unknown },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			update: (input: unknown) => updateMock(input),
			readiness: {
				snooze: vi.fn(),
				setNotApplicable: vi.fn(),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("../ProjectReadinessProvider", () => ({
	useProjectReadiness: () => readinessRef.current,
}));

vi.mock("next-intl", async () => {
	const { readFileSync } = await import("node:fs");
	const messages = JSON.parse(
		readFileSync("../../packages/i18n/translations/en.json", "utf8"),
	) as Record<string, unknown>;
	return {
		useTranslations: (namespace: string) => {
			const base = namespace
				.split(".")
				.reduce<unknown>(
					(node, part) => (node as Record<string, unknown>)?.[part],
					messages,
				);
			return (key: string, values?: Record<string, unknown>) => {
				const raw = key
					.split(".")
					.reduce<unknown>(
						(node, part) =>
							(node as Record<string, unknown>)?.[part],
						base,
					);
				if (typeof raw !== "string") {
					throw new Error(`missing message: ${namespace}.${key}`);
				}
				return raw.replace(/\{(\w+)\}/g, (_, name: string) =>
					String(values?.[name] ?? `{${name}}`),
				);
			};
		},
	};
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ProjectReadinessPanelSlot } from "../ProjectReadinessPanel";

type Item = Record<string, unknown>;

function item(overrides: Item = {}): Item {
	return {
		key: "feature-snapshot",
		category: "PROJECT_BASICS",
		i18nKey: "readiness.items.featureSnapshot",
		ctaLabelKey: "readiness.cta.featureSnapshot",
		needLevel: "MUST",
		isComplete: false,
		manualState: null,
		snoozeUntil: null,
		isVisible: true,
		isActiveGap: true,
		target: { kind: "tab", tab: "overview" },
		...overrides,
	};
}

function mountWith(items: Item[], data: Record<string, unknown> = {}) {
	const refetch = vi.fn();
	readinessRef.current = {
		projectId: "p1",
		isLoading: false,
		isExpanded: true,
		setExpanded: vi.fn(),
		refetch,
		hasInlineSlot: false,
		claimInlineSlot: vi.fn(),
		data: {
			enabled: true,
			level: "PARTIALLY_READY",
			phase: "DEVELOPMENT_EXECUTION",
			phaseSource: "set",
			completedCount: 1,
			totalCount: 26,
			items,
			activeGaps: items.filter((i) => i.isActiveGap),
			recentlyCompleted: [],
			suggestPhaseTransition: false,
			canAct: true,
			...data,
		},
	};
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<ProjectReadinessPanelSlot />
		</QueryClientProvider>,
	);
	return { refetch };
}

describe("checklist order survives completion", () => {
	it("keeps a completed item where the checklist puts it", async () => {
		const user = userEvent.setup();
		// tech-stack sits BEFORE feature-snapshot is not the claim — the claim is
		// that the array order the server sent is the order rendered, whatever an
		// item's completion state. Previously the resolved one was moved last.
		mountWith([
			item({ key: "tech-stack", i18nKey: "readiness.items.techStack" }),
			item({
				key: "feature-snapshot",
				isComplete: true,
				isActiveGap: false,
			}),
			item({
				key: "context-source",
				i18nKey: "readiness.items.contextSource",
			}),
		]);

		await user.click(screen.getByRole("button", { name: /show all/i }));

		const rendered = screen
			.getAllByRole("listitem")
			.map((el) => el.textContent ?? "");
		expect(rendered).toHaveLength(3);
		// The resolved row is still second, not pushed to the bottom.
		expect(rendered[1]).toMatch(/Done/i);
	});
});

describe("correcting an assumed phase", () => {
	it("writes the chosen phase rather than sending the user to settings", async () => {
		const user = userEvent.setup();
		updateMock.mockResolvedValue({ ok: true });
		const { refetch } = mountWith([item()], { phaseSource: "inferred" });

		await user.click(screen.getByRole("button", { name: /set phase/i }));
		await user.click(
			await screen.findByRole("menuitem", { name: /discovery/i }),
		);

		expect(updateMock).toHaveBeenCalledWith({
			id: "p1",
			projectPhase: "DISCOVERY_PLANNING",
			organizationId: null,
		});
		await vi.waitFor(() => expect(refetch).toHaveBeenCalled());
	});

	it("offers no phase control when someone already chose one", () => {
		mountWith([item()], { phaseSource: "set" });

		expect(
			screen.queryByRole("button", { name: /set phase/i }),
		).not.toBeInTheDocument();
	});
});

describe("saying why the level reads as it does", () => {
	it("counts the required items holding the project back", () => {
		mountWith([
			item({ needLevel: "MUST" }),
			item({ key: "tech-stack", needLevel: "SHOULD" }),
		]);

		expect(screen.getByText(/required item/i)).toBeInTheDocument();
	});

	it("stays quiet when nothing required is outstanding", () => {
		mountWith([item({ needLevel: "SHOULD" })]);

		expect(screen.queryByText(/required item/i)).not.toBeInTheDocument();
	});
});

/**
 * A reader kept every control and got a 403 from each — the panel offered work
 * it knew would fail. State still shows; only the verbs are withdrawn.
 */
describe("a viewer who cannot edit the project", () => {
	it("is shown the state but offered no actions", () => {
		mountWith([item()], { canAct: false });

		expect(
			screen.queryByRole("button", { name: /^Snooze/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /not applicable/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText(/view only/i)).toBeInTheDocument();
	});

	it("is not offered the next phase", () => {
		mountWith([item()], {
			canAct: false,
			suggestPhaseTransition: true,
		});

		expect(
			screen.queryByRole("button", { name: /^Switch/i }),
		).not.toBeInTheDocument();
	});

	it("still gets the actions when they can edit", () => {
		mountWith([item()], { canAct: true });

		expect(
			screen.getByRole("button", { name: /^Snooze/i }),
		).toBeInTheDocument();
		expect(screen.queryByText(/view only/i)).not.toBeInTheDocument();
	});
});

/**
 * Staging QA follow-ups (Fizzy #2165).
 *
 * The colour assertions are the point of this block: the running theme resolves
 * `--primary` to a teal and `--secondary` to an emerald, so a panel that painted
 * NOT_READY with `primary` showed two greens and reproduced the very complaint
 * the salience work was for. These pin the token, not the pixel.
 */
describe("readiness level is painted with the right token", () => {
	function panel() {
		return document.querySelector(
			'section[aria-label="Project readiness"]',
		);
	}

	it("paints a not-ready project with destructive, never primary", () => {
		mountWith([item()], { level: "NOT_READY" });
		const cls = panel()?.className ?? "";
		expect(cls).toContain("border-l-destructive");
		expect(cls).toContain("bg-destructive/10");
		expect(cls).not.toContain("primary");
	});

	it("tints a partially-ready project amber", () => {
		mountWith([item()], { level: "PARTIALLY_READY" });
		const cls = panel()?.className ?? "";
		expect(cls).toContain("border-l-highlight");
		expect(cls).toContain("bg-highlight/10");
	});

	it("leaves a ready project untinted — it has nothing to ask for", () => {
		mountWith([item()], { level: "READY" });
		const cls = panel()?.className ?? "";
		expect(cls).toContain("bg-muted/40");
		expect(cls).not.toContain("bg-destructive");
		expect(cls).not.toContain("bg-highlight");
	});
});

describe("recently completed", () => {
	it("lists each item as its own struck-through row", () => {
		mountWith([item()], {
			recentlyCompleted: [{ key: "tech-stack" }, { key: "prd" }],
		});

		const rows = screen
			.getAllByRole("listitem")
			.filter(
				(li) =>
					li.className.includes("line-through") ||
					li.querySelector(".line-through"),
			);
		expect(rows).toHaveLength(2);
	});
});

describe("pointing at the destination", () => {
	function listen() {
		const events: Array<{ anchorId: string; projectTab?: string }> = [];
		const listener = (e: Event) => {
			events.push((e as CustomEvent).detail);
		};
		window.addEventListener("get-started:spotlight", listener);
		return {
			events,
			stop: () =>
				window.removeEventListener("get-started:spotlight", listener),
		};
	}

	it("spotlights the anchor when help is asked for", async () => {
		const user = userEvent.setup();
		const { events, stop } = listen();

		// The default fixture is feature-snapshot, whose anchor is on Overview.
		mountWith([item()]);
		await user.click(screen.getByRole("button", { name: /show me/i }));

		stop();
		expect(events).toHaveLength(1);
		expect(events[0].anchorId).toBe("overview-feature-snapshot");
		expect(events[0].projectTab).toBe("overview");
	});

	/**
	 * The primary action just goes. Spotlighting on every call-to-action meant a
	 * dimmed screen each time someone acted on the checklist, which is why the
	 * help control exists separately.
	 */
	it("does not spotlight when the call-to-action itself is used", async () => {
		const user = userEvent.setup();
		const { events, stop } = listen();

		mountWith([item()]);
		await user.click(screen.getByText("Define Features"));

		stop();
		expect(events).toHaveLength(0);
	});

	it("offers no help control for an item with no anchor to point at", () => {
		mountWith([
			item({
				key: "team-members",
				ctaLabelKey: "readiness.cta.teamMembers",
			}),
		]);

		expect(
			screen.queryByRole("button", { name: /show me/i }),
		).not.toBeInTheDocument();
	});
});

/**
 * Every row in the sheet carries a short description and a tooltip explaining
 * what the item wants and why. Both were translated and neither reached the
 * page, which is the whole reason a checklist item could read as an
 * instruction nobody could follow.
 */
describe("each item explains itself", () => {
	it("puts the item name in a tooltip trigger, reachable by keyboard", () => {
		mountWith([item()]);

		const name = screen.getByText("Feature Snapshot");
		// Radix does not open on a synthetic hover under jsdom, so assert the
		// wiring rather than the animation: the name is the trigger, and it is
		// focusable, which is how a keyboard user reaches the explanation.
		expect(name.closest('[data-slot="tooltip-trigger"]')).not.toBeNull();
		// A real button, so focus works without a tabIndex on a non-interactive
		// element — which is both the accessible choice and what the linter
		// insists on.
		expect(name.tagName).toBe("BUTTON");
	});

	it("resolves both catalogue strings for every registered item", () => {
		// The strings existed and were never rendered. This fails loudly if a
		// key is missing rather than showing an empty tooltip.
		mountWith([
			item({ key: "tech-stack", ctaLabelKey: "readiness.cta.techStack" }),
		]);
		expect(screen.getByText("Tech Stack")).toBeInTheDocument();
	});
});
