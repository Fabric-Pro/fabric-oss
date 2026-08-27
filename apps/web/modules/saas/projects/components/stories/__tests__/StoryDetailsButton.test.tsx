import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { StoryDetailsButton } from "../StoryDetailsButton";

// The members query flows through orpc.projects.members.list.queryOptions().
// Spy on its queryFn so we can assert lazy timing + the org id passed through.
const { membersFn } = vi.hoisted(() => ({ membersFn: vi.fn() }));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			members: {
				list: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["members", opts.input],
						queryFn: async () => membersFn(opts.input),
					}),
				},
			},
		},
	},
}));

const wrap = (ui: ReactNode) => (
	<QueryClientProvider
		client={
			new QueryClient({ defaultOptions: { queries: { retry: false } } })
		}
	>
		{ui}
	</QueryClientProvider>
);

// `as unknown as UserStory` — only the fields ProvenanceSection reads matter.
// reporterName ("Dana") is deliberately DIFFERENT from the resolved creator
// name ("Dave") so the two assertions don't collide on the same text node.
const story = {
	id: "s1",
	identifier: "F-1",
	kind: "FEATURE",
	createdById: "u1",
	createdAt: new Date("2026-05-18T00:00:00Z"),
	updatedAt: new Date("2026-05-20T00:00:00Z"),
	source: "manual",
	version: 3,
	labels: [],
	externalUrl: null,
	reporterName: "Dana",
	reporterSource: "SLACK",
	reporterSourceUrl: null,
	lastEditedByName: null,
} as unknown as UserStory;

const props = {
	story,
	projectId: "p1",
	organizationId: "o1" as string | null,
	pmToolName: "Jira",
};

beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe() {}
			unobserve() {}
			disconnect() {}
		} as unknown as typeof ResizeObserver;
	}
});

beforeEach(() => {
	membersFn.mockReset().mockResolvedValue({
		members: [
			{ userId: "u1", user: { name: "Dave", email: "k@example.com" } },
		],
	});
});

describe("StoryDetailsButton", () => {
	it("renders the info button unconditionally (no flag gating)", () => {
		render(wrap(<StoryDetailsButton {...props} />));
		expect(
			screen.getByRole("button", { name: "Feature details" }),
		).toBeInTheDocument();
	});

	it("does not fetch members until the popover opens", () => {
		render(wrap(<StoryDetailsButton {...props} />));
		expect(membersFn).not.toHaveBeenCalled();
	});

	it("opens the popover, shows provenance, and resolves the creator from a lazy members fetch carrying the org id", async () => {
		render(wrap(<StoryDetailsButton {...props} />));
		fireEvent.click(
			screen.getByRole("button", { name: "Feature details" }),
		);
		// ProvenanceSection rendered inside the popover.
		expect(await screen.findByText("Version")).toBeInTheDocument();
		// Feature with a reporter shows the "Proposed" row.
		expect(screen.getByText("Proposed")).toBeInTheDocument();
		// Members fetched lazily, with the org id supplied via props.
		await waitFor(() =>
			expect(membersFn).toHaveBeenCalledWith({
				projectId: "p1",
				organizationId: "o1",
			}),
		);
		// Creator name resolved from that fetch.
		expect(await screen.findByText("Dave")).toBeInTheDocument();
	});

	it("fetches members only on first open and serves reopen from cache (staleTime: Infinity)", async () => {
		render(wrap(<StoryDetailsButton {...props} />));
		const btn = screen.getByRole("button", { name: "Feature details" });
		// First open → exactly one fetch.
		fireEvent.click(btn);
		await waitFor(() => expect(membersFn).toHaveBeenCalledTimes(1));
		expect(await screen.findByText("Version")).toBeInTheDocument();
		// Close. Radix Popover toggles closed on a second trigger click; if
		// jsdom does not toggle, fall back to
		// `fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" })`.
		fireEvent.click(btn);
		await waitFor(() =>
			expect(screen.queryByText("Version")).not.toBeInTheDocument(),
		);
		// Reopen — `wrap` deliberately does NOT override staleTime (production
		// default 0), so a second fetch would happen unless the component's own
		// `staleTime: Infinity` serves it from cache. Assert it does.
		fireEvent.click(btn);
		expect(await screen.findByText("Version")).toBeInTheDocument();
		expect(membersFn).toHaveBeenCalledTimes(1);
	});

	it("falls back to 'Unknown user' instead of a stuck skeleton when the members fetch errors", async () => {
		membersFn
			.mockReset()
			.mockRejectedValue(new Error("members fetch failed"));
		render(wrap(<StoryDetailsButton {...props} />));
		fireEvent.click(
			screen.getByRole("button", { name: "Feature details" }),
		);
		// On error the members query settles with no data; the creator field must
		// resolve to the "Unknown user" fallback, not hang on the loading skeleton.
		expect(await screen.findByText("Unknown user")).toBeInTheDocument();
		expect(
			screen.queryByTestId("creator-skeleton"),
		).not.toBeInTheDocument();
	});
});
