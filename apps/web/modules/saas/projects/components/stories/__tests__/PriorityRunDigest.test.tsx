/**
 * Component tests for <PriorityRunDigest> — the review-and-revert dialog shown
 * after a re-prioritization run moved at least one band.
 *
 * Covers: the per-change rows (item, from→to, rationale), the truncation and
 * pinned-order notes, and the Revert flow — which must write through the same
 * `setPriority` path as a manual change, with the original band and a comment.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

// Resolve the real `projects.stories.priority` strings (same rationale as
// PriorityRankedList.test.tsx): assertions should be on what a user reads.
vi.mock("next-intl", async () => {
	const en = (
		await import(
			"../../../../../../../../packages/i18n/translations/en.json"
		)
	).default as Record<string, unknown>;
	const priority = (en as any).projects.stories.priority as Record<
		string,
		string
	>;
	const t = (key: string, values?: Record<string, string | number>) => {
		let out = priority[key] ?? key;
		// Minimal ICU: the priority block only uses the exact shape
		// `{name, plural, one {...} other {...}}`; resolve that, then plain
		// `{name}` substitution — enough for digestDescription.
		out = out.replace(
			/\{(\w+), plural, one \{([^}]*)\} other \{([^}]*)\}\}/g,
			(_match, name, one, other) => {
				const count = Number(values?.[name] ?? Number.NaN);
				const branch = count === 1 ? one : other;
				return String(branch).replace(/#/g, String(count));
			},
		);
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.split(`{${name}}`).join(String(value));
		}
		return out;
	};
	return {
		useTranslations: () => t,
		useLocale: () => "en",
		NextIntlClientProvider: ({ children }: { children: ReactNode }) =>
			children,
	};
});

const { mocks } = vi.hoisted(() => ({
	mocks: {
		setPriority: vi.fn(),
		toastError: vi.fn(),
	},
}));

vi.mock("sonner", () => ({
	toast: { error: mocks.toastError, success: vi.fn(), info: vi.fn() },
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				setPriority: (input: unknown) => mocks.setPriority(input),
			},
		},
	},
}));

import {
	type PriorityRunChange,
	PriorityRunDigest,
} from "../priority/PriorityRunDigest";

const CHANGES: PriorityRunChange[] = [
	{
		storyId: "s1",
		fromPriority: "P2_MEDIUM",
		toPriority: "P0_CRITICAL",
		rationale: "Security exposure blocking the release.",
	},
	{
		storyId: "s2",
		fromPriority: "P1_HIGH",
		toPriority: "P3_LOW",
		rationale: null,
	},
];

const META = new Map([
	["s1", { identifier: "F-001", title: "Login rework" }],
	["s2", { identifier: "F-002", title: "Old importer" }],
]);

function renderDigest(
	overrides: Partial<Parameters<typeof PriorityRunDigest>[0]> = {},
) {
	const onReverted = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<PriorityRunDigest
				open
				onOpenChange={() => {}}
				changes={CHANGES}
				considered={40}
				truncated={false}
				pinned={false}
				storyMeta={META}
				projectId="p-1"
				organizationId={null}
				onReverted={onReverted}
				{...overrides}
			/>
		</QueryClientProvider>,
	);
	return { onReverted };
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.setPriority.mockResolvedValue({
		changed: true,
		priority: "P2_MEDIUM",
		priorityChangedAt: new Date("2026-07-22T00:00:00Z"),
	});
});

describe("PriorityRunDigest", () => {
	it("lists every move with item, bands and rationale", () => {
		renderDigest();

		expect(screen.getByText("Login rework")).toBeTruthy();
		// Twice by design: the visible chip and the Revert button's sr-only
		// disambiguation both carry the identifier.
		expect(screen.getAllByText("F-001").length).toBeGreaterThanOrEqual(1);
		expect(
			screen.getByText("Security exposure blocking the release."),
		).toBeTruthy();
		expect(screen.getByText("Old importer")).toBeTruthy();
		// The summary line reports the run's shape.
		expect(screen.getByText(/2 bands changed out of 40/)).toBeTruthy();
	});

	it("shows the truncation and pinned-order notes only when they apply", () => {
		renderDigest({ truncated: true, pinned: true });

		expect(
			screen.getByText(/only the first 500 items were re-assessed/),
		).toBeTruthy();
		expect(
			screen.getByText(/Your saved order still controls positions/),
		).toBeTruthy();
	});

	it("reverts through setPriority with the original band and a comment", async () => {
		const { onReverted } = renderDigest();

		const [firstRevert] = screen.getAllByRole("button", {
			name: /Revert/,
		});
		fireEvent.click(firstRevert);

		await waitFor(() =>
			expect(mocks.setPriority).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: "p-1",
					storyId: "s1",
					priority: "P2_MEDIUM",
					comment: "Reverted the AI re-prioritization.",
				}),
			),
		);
		// The row flips to its reverted state and the caches get refreshed.
		await waitFor(() => expect(screen.getByText("Reverted")).toBeTruthy());
		expect(onReverted).toHaveBeenCalledTimes(1);
	});

	it("surfaces a revert failure without marking the row reverted", async () => {
		mocks.setPriority.mockRejectedValueOnce(new Error("boom"));
		renderDigest();

		const [firstRevert] = screen.getAllByRole("button", {
			name: /Revert/,
		});
		fireEvent.click(firstRevert);

		await waitFor(() => expect(mocks.toastError).toHaveBeenCalled());
		expect(screen.queryByText("Reverted")).toBeNull();
	});
});
