import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../../lib/stories/types";
import { AttachmentsTab } from "../AttachmentsTab";

const { listAttachments } = vi.hoisted(() => ({ listAttachments: vi.fn() }));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments } } },
}));

const story = { id: "s1", description: "" } as unknown as UserStory;

beforeEach(() => {
	// Org-stamped rows so the DOM proves two independent cache entries (not a
	// shared/deduped one). Returning per-call data keyed on the input org is
	// what makes the red phase fail deterministically (only one org resolves).
	listAttachments
		.mockReset()
		.mockImplementation((input: { organizationId: string }) =>
			Promise.resolve({
				attachments: [
					{
						id: input.organizationId,
						filename: `file-${input.organizationId}.txt`,
						mimeType: "text/plain",
						sizeBytes: 10,
						designation: "UNLOCKED",
						createdAt: new Date(0),
						downloadUrl: `https://dl/${input.organizationId}`,
					},
				],
			}),
		);
});

describe("AttachmentsTab — tenant-scoped list cache key", () => {
	it("fetches separately per organizationId for the same project + story", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		render(
			<QueryClientProvider client={client}>
				<AttachmentsTab
					story={story}
					projectId="p1"
					organizationId="o1"
					canEdit={false}
				/>
				<AttachmentsTab
					story={story}
					projectId="p1"
					organizationId="o2"
					canEdit={false}
				/>
			</QueryClientProvider>,
		);
		// Both org-distinct rows must render → two independent cache entries.
		expect(await screen.findByText("file-o1.txt")).toBeInTheDocument();
		expect(await screen.findByText("file-o2.txt")).toBeInTheDocument();
		expect(listAttachments).toHaveBeenCalledTimes(2);
		const orgs = listAttachments.mock.calls
			.map((c) => (c[0] as { organizationId: string }).organizationId)
			.sort();
		expect(orgs).toEqual(["o1", "o2"]);
	});
});
