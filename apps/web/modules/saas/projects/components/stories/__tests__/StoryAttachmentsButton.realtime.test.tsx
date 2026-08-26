import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../lib/stories/types";
import { AttachmentsTab } from "../editor/AttachmentsTab";
import { StoryAttachmentsButton } from "../StoryAttachmentsButton";

const { listAttachments, uploadStoryAttachment } = vi.hoisted(() => ({
	listAttachments: vi.fn(),
	uploadStoryAttachment: vi.fn(),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: { projects: { stories: { listAttachments } } },
}));
vi.mock("../../../lib/attachment-upload-utils", () => ({
	uploadStoryAttachment: (args: unknown) => uploadStoryAttachment(args),
}));

const story = {
	id: "s1",
	identifier: "F-1",
	description: "",
} as unknown as UserStory;
const props = {
	story,
	projectId: "p1",
	organizationId: "o1" as string | null,
	canEdit: true,
};

describe("badge real-time via shared cache", () => {
	it("updates the badge after an upload that resolves AFTER AttachmentsTab unmounts", async () => {
		const qc = new QueryClient(); // ONE stable client for the whole test
		let count = 0;
		listAttachments.mockImplementation(() =>
			Promise.resolve({
				attachments: Array.from({ length: count }, () => ({})),
			}),
		);
		// Deferred upload: we control exactly when it resolves.
		let resolveUpload: (v: unknown) => void = () => {};
		uploadStoryAttachment.mockImplementation(
			() =>
				new Promise((res) => {
					resolveUpload = (v) => {
						count = 1; // the next listAttachments refetch will see 1
						res(v);
					};
				}),
		);

		function Harness({ showTab }: { showTab: boolean }) {
			return (
				<QueryClientProvider client={qc}>
					<StoryAttachmentsButton {...props} />
					{showTab && <AttachmentsTab {...props} />}
				</QueryClientProvider>
			);
		}

		const { rerender } = render(<Harness showTab={true} />);
		await waitFor(() => expect(listAttachments).toHaveBeenCalled());
		expect(screen.queryByText("1")).not.toBeInTheDocument();

		// Start the upload (now pending), then UNMOUNT the tab while still pending.
		const input = document.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		fireEvent.change(input, {
			target: {
				files: [new File(["x"], "a.pdf", { type: "application/pdf" })],
			},
		});
		// useMutation's execute() awaits its (empty) onMutate hooks before invoking
		// mutationFn, so the mock isn't called synchronously with fireEvent — wait
		// for it so `resolveUpload` is bound to the in-flight promise before we
		// unmount and resolve it.
		await waitFor(() => expect(uploadStoryAttachment).toHaveBeenCalled());
		rerender(<Harness showTab={false} />);
		expect(screen.queryByText("1")).not.toBeInTheDocument(); // still pending → no badge

		// Resolve AFTER unmount → mutationFn's qc.invalidateQueries runs on the SAME
		// client → the still-mounted badge observer refetches → badge shows "1".
		await act(async () => {
			resolveUpload({ id: "a1" });
		});
		expect(await screen.findByText("1")).toBeInTheDocument();
	});
});
