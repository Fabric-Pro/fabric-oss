/**
 * "Since your last visit" on the Coding Instructions tab: a first visit or a
 * visit with nothing new records the marker silently and shows nothing; news
 * stays on screen until "Mark all as seen", which records the version shown.
 *
 * `next-intl` is left on the shared echoing mock (`vitest.setup.ts`).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	digest: null as Record<string, unknown> | null,
	seenCalls: [] as Array<Record<string, unknown>>,
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			instructions: {
				getDigest: {
					queryOptions: (o: { input: unknown }) => ({
						queryKey: ["getDigest", o.input],
						queryFn: async () => m.digest,
					}),
				},
				markSeen: {
					mutationOptions: (opts: Record<string, unknown> = {}) => ({
						mutationFn: async (input: Record<string, unknown>) => {
							m.seenCalls.push(input);
							return { ok: true };
						},
						...opts,
					}),
				},
			},
		},
	},
}));

import { InstructionsDigestPanel } from "../InstructionsDigestPanel";

function Wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

const seenAt = new Date("2026-10-01T00:00:00Z");

function withNews(overrides: Record<string, unknown> = {}) {
	return {
		firstVisit: false,
		hasChanges: true,
		current: { snapshotId: "s5", version: 5 },
		seen: { snapshotId: "s3", version: 3, seenAt, comparable: true },
		versions: [
			{
				snapshotId: "s5",
				version: 5,
				source: "UPLOAD",
				sourceRef: null,
				shortCommitSha: null,
				publishedAt: seenAt,
				author: { id: "u2", name: "Example Author" },
			},
		],
		paths: {
			added: [{ path: "docs/new.md" }],
			changed: [{ path: "CLAUDE.md" }],
			removed: [],
		},
		proposals: [],
		...overrides,
	};
}

beforeEach(() => {
	m.digest = null;
	m.seenCalls.length = 0;
});

describe("InstructionsDigestPanel", () => {
	it("shows nothing on a first visit and records what is published now", async () => {
		m.digest = {
			firstVisit: true,
			hasChanges: false,
			current: { snapshotId: "s5", version: 5 },
			seen: null,
			versions: [],
			paths: null,
			proposals: [],
		};
		render(<InstructionsDigestPanel projectId="p" />, { wrapper: Wrapper });

		await waitFor(() =>
			expect(m.seenCalls).toEqual([{ projectId: "p", snapshotId: "s5" }]),
		);
		expect(screen.queryByTestId("instructions-digest")).toBeNull();
	});

	it("keeps the news on screen, without recording it, until it is marked seen", async () => {
		m.digest = withNews();
		render(<InstructionsDigestPanel projectId="p" />, { wrapper: Wrapper });

		const panel = await screen.findByTestId("instructions-digest");
		expect(panel).toHaveTextContent("docs/new.md");
		expect(panel).toHaveTextContent("CLAUDE.md");
		expect(m.seenCalls).toEqual([]);

		await userEvent.click(screen.getByRole("button", { name: "markSeen" }));

		await waitFor(() =>
			expect(m.seenCalls).toEqual([{ projectId: "p", snapshotId: "s5" }]),
		);
	});

	it("says the seen version is gone when there is nothing to compare with", async () => {
		m.digest = withNews({
			paths: null,
			seen: { snapshotId: "gone", version: 3, seenAt, comparable: false },
		});
		render(<InstructionsDigestPanel projectId="p" />, { wrapper: Wrapper });

		expect(await screen.findByText("seenVersionGone")).toBeInTheDocument();
	});

	// Recorded while nothing was published (a first visit, or after every
	// version was removed): no version was ever seen, so none is "gone".
	it("names no lost version when the last visit saw nothing published", async () => {
		m.digest = withNews({
			paths: null,
			seen: {
				snapshotId: null,
				version: null,
				seenAt,
				comparable: false,
			},
		});
		render(<InstructionsDigestPanel projectId="p" />, { wrapper: Wrapper });

		expect(
			await screen.findByTestId("instructions-digest"),
		).toBeInTheDocument();
		expect(screen.queryByText("seenVersionGone")).toBeNull();
	});
});
