/**
 * FeatureVersionHistory — a version row's word count (Fizzy #2946).
 *
 * A row counts the feature's description and acceptance criteria the way the
 * server counts a document's `wordCount`: a diagram fence or an image is no
 * words. A plain whitespace split counted every token inside them.
 *
 * The diff viewer drags in TipTap and is not under test here.
 */

import { countDocumentWords } from "@repo/utils/document-word-count";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const listVersions = vi.fn();

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			stories: {
				versions: {
					list: {
						queryOptions: () => ({
							queryKey: ["story-versions"],
							queryFn: () => listVersions(),
						}),
						queryKey: () => ["story-versions"],
					},
					restore: {
						mutationOptions: (opts: unknown) => ({
							mutationFn: vi.fn(),
							...(opts as Record<string, unknown>),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn() },
}));

vi.mock("../../VersionDiffViewer", () => ({
	VersionDiffViewer: () => null,
}));

import { FeatureVersionHistory } from "../FeatureVersionHistory";

const DESCRIPTION =
	"Intro text here.\n\n```mermaid\ngraph TD; A-->B\n```\n\n![diagram](https://example.com/a.png)\n\nClosing words.";

describe("FeatureVersionHistory — word count (Fizzy #2946)", () => {
	it("counts a version's words the way the server counts a document's, leaving fences and images out", async () => {
		listVersions.mockResolvedValue({
			versions: [
				{
					id: "story-ver-1",
					version: 1,
					description: DESCRIPTION,
					acceptanceCriteria: null,
					draftingStage: "DRAFT",
					changeDescription: null,
					changedBy: null,
					createdAt: "2026-07-01T00:00:00.000Z",
				},
			],
		});
		// The row counts what it would compare: the description under its
		// heading.
		const content = `## Description\n\n${DESCRIPTION}`;
		const expected = countDocumentWords(content);
		// The plain whitespace split the row used to count with disagrees,
		// so the row tells the two apart.
		expect(expected).not.toBe(content.split(/\s+/).length);

		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		render(
			<QueryClientProvider client={queryClient}>
				<FeatureVersionHistory
					open={true}
					onOpenChange={vi.fn()}
					projectId="p1"
					storyId="story-1"
					currentVersion={2}
					currentDescription="The current description."
					currentAcceptanceCriteria=""
					organizationId="org-1"
				/>
			</QueryClientProvider>,
		);

		await screen.findByText("v1");
		expect(screen.getByText(`${expected} words`)).toBeInTheDocument();
	});
});
