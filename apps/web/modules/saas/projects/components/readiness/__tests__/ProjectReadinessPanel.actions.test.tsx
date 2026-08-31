/**
 * Undoing a readiness state, and choosing how long a snooze lasts
 * (Fizzy #2165 — Checklist AC-8, plus the FR22 gap where nothing undid a
 * snooze).
 *
 * These assert what the panel SENDS, because that is where the two mistakes
 * live: lifting a snooze is `until: null` rather than a second endpoint, and
 * "Mark applicable" is the same procedure with `false`. A test that only checked
 * a button rendered would pass while sending the wrong thing.
 *
 * `useTranslations` resolves against the real `en.json` rather than echoing the
 * key, so a missing message fails here too.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

const { snoozeMock, setNotApplicableMock, readinessRef } = vi.hoisted(() => ({
	snoozeMock: vi.fn(),
	setNotApplicableMock: vi.fn(),
	readinessRef: { current: null as unknown },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			readiness: {
				snooze: (input: unknown) => snoozeMock(input),
				setNotApplicable: (input: unknown) =>
					setNotApplicableMock(input),
			},
		},
	},
}));

vi.mock("@saas/projects/lib/project-tab-preferences", () => ({
	// These tests are about the panel's actions, not tab visibility: every tab
	// is reachable so the calls to action render as links.
	useProjectTabCustomization: () => ({ config: undefined, prefs: undefined }),
	resolveProjectTabs: (tabs: readonly unknown[]) => tabs,
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

// Resolve against the shipped catalogue: a key with no copy must fail here, the
// same exposure the CTA labels had.
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

function mountWith(items: Item[]) {
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
		},
	};
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>
			<ProjectReadinessPanelSlot />
		</QueryClientProvider>,
	);
}

/** Reveal the resolved rows, which Show All is what surfaces. */
async function showAll(user: ReturnType<typeof userEvent.setup>) {
	const toggle = screen.queryByRole("button", { name: /show all/i });
	if (toggle) {
		await user.click(toggle);
	}
}

beforeEach(() => {
	vi.clearAllMocks();
	snoozeMock.mockResolvedValue({ ok: true });
	setNotApplicableMock.mockResolvedValue({ ok: true });
});

describe("snoozing with a chosen duration", () => {
	it("offers durations instead of snoozing for a fixed period", async () => {
		const user = userEvent.setup();
		mountWith([item()]);

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		const menu = await screen.findByRole("menu");

		expect(
			within(menu)
				.getAllByRole("menuitem")
				.map((el) => el.textContent?.trim()),
		).toEqual([
			"1 day",
			"3 days",
			"1 week",
			"2 weeks",
			"1 month",
			// FR22 / AC-9: one menu holds the item's actions, so Not applicable
			// sits alongside the durations rather than as a separate button.
			"Not applicable",
		]);
	});

	it("sends the instant the chosen duration lands on", async () => {
		const user = userEvent.setup();
		mountWith([item()]);
		const before = Date.now();

		await user.click(
			screen.getByRole("button", { name: "Actions for this item" }),
		);
		await user.click(
			await screen.findByRole("menuitem", { name: "1 week" }),
		);

		await waitFor(() => expect(snoozeMock).toHaveBeenCalledTimes(1));
		const { until, itemKey } = snoozeMock.mock.calls[0][0];
		expect(itemKey).toBe("feature-snapshot");
		const days = (until.getTime() - before) / (24 * 60 * 60 * 1000);
		expect(days).toBeGreaterThan(6.9);
		expect(days).toBeLessThan(7.1);
	});
});

describe("undoing a state", () => {
	const snoozed = () =>
		item({
			manualState: "SNOOZED",
			isActiveGap: false,
			snoozeUntil: new Date(Date.now() + 6 * 24 * 60 * 60 * 1000),
		});

	it("says how much longer the item stays quiet", async () => {
		const user = userEvent.setup();
		mountWith([snoozed()]);
		await showAll(user);

		expect(
			await screen.findByText(/Snoozed for 6 days/i),
		).toBeInTheDocument();
	});

	it("lifts a snooze by sending a null date", async () => {
		const user = userEvent.setup();
		mountWith([snoozed()]);
		await showAll(user);

		await user.click(screen.getByRole("button", { name: /un-snooze/i }));

		await waitFor(() => expect(snoozeMock).toHaveBeenCalledTimes(1));
		// Null is what clears it — a date in the past would leave a stale row
		// behind and re-snooze the item the moment the clock moved.
		expect(snoozeMock.mock.calls[0][0].until).toBeNull();
	});

	it("can re-snooze a snoozed item for a different period", async () => {
		const user = userEvent.setup();
		mountWith([snoozed()]);
		await showAll(user);

		await user.click(screen.getByRole("button", { name: /^Change/i }));
		await user.click(
			await screen.findByRole("menuitem", { name: "1 day" }),
		);

		await waitFor(() => expect(snoozeMock).toHaveBeenCalledTimes(1));
		expect(snoozeMock.mock.calls[0][0].until).toBeInstanceOf(Date);
	});

	it("takes back Not Applicable", async () => {
		const user = userEvent.setup();
		mountWith([
			item({ manualState: "NOT_APPLICABLE", isActiveGap: false }),
		]);
		await showAll(user);

		await user.click(
			screen.getByRole("button", { name: /mark applicable/i }),
		);

		await waitFor(() =>
			expect(setNotApplicableMock).toHaveBeenCalledTimes(1),
		);
		expect(setNotApplicableMock.mock.calls[0][0].notApplicable).toBe(false);
	});

	it("offers no undo on a completed item, which nobody set", async () => {
		const user = userEvent.setup();
		mountWith([item({ isComplete: true, isActiveGap: false })]);
		await showAll(user);

		expect(
			screen.queryByRole("button", {
				name: /un-snooze|mark applicable/i,
			}),
		).not.toBeInTheDocument();
	});
});
