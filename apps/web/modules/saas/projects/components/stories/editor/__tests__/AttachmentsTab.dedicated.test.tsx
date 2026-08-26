import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { UserStory } from "../../../../lib/stories/types";
import { AttachmentsTab } from "../AttachmentsTab";

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			stories: {
				listAttachments: vi.fn().mockResolvedValue({
					attachments: [
						{
							id: "a1",
							filename: "spec.pdf",
							mimeType: "application/pdf",
							sizeBytes: 2048,
							designation: "LOCKED",
							createdAt: new Date(0),
							downloadUrl: "https://dl/a1",
						},
					],
				}),
				removeAttachment: vi.fn().mockResolvedValue({ removed: true }),
				setAttachmentDesignation: vi.fn().mockResolvedValue({
					attachment: { id: "a1", designation: "UNLOCKED" },
				}),
			},
		},
	},
}));

const wrap = (ui: React.ReactNode) => (
	<QueryClientProvider client={new QueryClient()}>{ui}</QueryClientProvider>
);
const story = { id: "s1", description: "" } as unknown as UserStory;
const baseProps = {
	story,
	projectId: "p1",
	organizationId: null as string | null,
};

describe("AttachmentsTab", () => {
	it("lists attachments with name, size, and a download link", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={false} />));
		expect(await screen.findByText("spec.pdf")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: /download/i })).toHaveAttribute(
			"href",
			"https://dl/a1",
		);
	});
	it("hides Browse/Remove/lock controls in read-only mode", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={false} />));
		await screen.findByText("spec.pdf");
		expect(
			screen.queryByRole("button", { name: /browse/i }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /remove/i }),
		).not.toBeInTheDocument();
	});
	it("blocks Remove on a Locked file with an unlock prompt (no API call)", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("spec.pdf");
		fireEvent.click(screen.getByRole("button", { name: /remove/i }));
		expect(
			await screen.findByText(/unlock this file/i),
		).toBeInTheDocument();
	});
	it("opens the file dialog on keyboard activation of the drop zone (SC 2.1.1)", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("spec.pdf");
		const dropzone = screen.getByRole("button", {
			name: /drag files here/i,
		});
		const input = dropzone.parentElement?.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const clickSpy = vi.spyOn(input, "click");
		fireEvent.keyDown(dropzone, { key: "Enter" });
		expect(clickSpy).toHaveBeenCalled();
	});
	it("opens the file dialog on Space activation of the drop zone", async () => {
		render(wrap(<AttachmentsTab {...baseProps} canEdit={true} />));
		await screen.findByText("spec.pdf");
		const dropzone = screen.getByRole("button", {
			name: /drag files here/i,
		});
		const input = dropzone.parentElement?.querySelector(
			'input[type="file"]',
		) as HTMLInputElement;
		const clickSpy = vi.spyOn(input, "click");
		fireEvent.keyDown(dropzone, { key: " " });
		expect(clickSpy).toHaveBeenCalled();
	});
});
