/**
 * Component tests for ImageUploadNode.
 *
 * Tests progress state rendering, error state rendering,
 * retry/cancel callbacks, and accessibility attributes.
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

// Mock TipTap's NodeViewWrapper to render a simple div
vi.mock("@tiptap/react", () => ({
	NodeViewWrapper: ({
		children,
		...props
	}: { children: React.ReactNode } & Record<string, unknown>) => (
		<div data-testid="node-view-wrapper" {...props}>
			{children}
		</div>
	),
}));

import { ImageUploadNode } from "../ImageUploadNode";

function createMockNodeAttrs(
	overrides: Partial<{
		uploadId: string;
		filename: string;
		progress: number;
		error: string | null;
	}> = {},
) {
	return {
		uploadId: "upload-1",
		filename: "test-image.png",
		progress: 50,
		error: null,
		...overrides,
	};
}

function createMockNode(attrs: ReturnType<typeof createMockNodeAttrs>) {
	return { attrs } as any;
}

describe("ImageUploadNode", () => {
	it("renders progress state with filename and percentage", () => {
		const node = createMockNode(createMockNodeAttrs({ progress: 42 }));

		render(<ImageUploadNode node={node} />);

		expect(screen.getByText("test-image.png")).toBeTruthy();
		expect(screen.getByText("Uploading... 42%")).toBeTruthy();
		const progressbar = screen.getByRole("progressbar");
		expect(progressbar.getAttribute("aria-valuenow")).toBe("42");
	});

	it("renders processing state when progress is 100", () => {
		const node = createMockNode(createMockNodeAttrs({ progress: 100 }));

		render(<ImageUploadNode node={node} />);

		expect(screen.getByText("Processing...")).toBeTruthy();
	});

	it("renders error state with error message", () => {
		const node = createMockNode(
			createMockNodeAttrs({
				error: "File too large",
				progress: 0,
			}),
		);

		render(<ImageUploadNode node={node} />);

		expect(screen.getByText("test-image.png")).toBeTruthy();
		expect(screen.getByText("File too large")).toBeTruthy();
	});

	it("has correct aria-label for progress state", () => {
		const node = createMockNode(createMockNodeAttrs({ progress: 75 }));

		render(<ImageUploadNode node={node} />);

		const output = screen.getByRole("status");
		expect(output.getAttribute("aria-label")).toBe(
			"Uploading test-image.png: 75%",
		);
	});

	it("has correct aria-label for error state", () => {
		const node = createMockNode(
			createMockNodeAttrs({ error: "Network error" }),
		);

		render(<ImageUploadNode node={node} />);

		const output = screen.getByRole("status");
		expect(output.getAttribute("aria-label")).toBe(
			"Upload failed: test-image.png",
		);
	});

	it("calls onRetry with uploadId when retry button is clicked", async () => {
		const user = userEvent.setup();
		const onRetry = vi.fn();
		const node = createMockNode(
			createMockNodeAttrs({
				uploadId: "upload-abc",
				error: "Something went wrong",
			}),
		);

		render(<ImageUploadNode node={node} onRetry={onRetry} />);

		const retryButton = screen.getByRole("button", {
			name: /retry upload/i,
		});
		await user.click(retryButton);

		expect(onRetry).toHaveBeenCalledWith("upload-abc");
	});

	it("calls onCancel with uploadId when cancel button is clicked in error state", async () => {
		const user = userEvent.setup();
		const onCancel = vi.fn();
		const node = createMockNode(
			createMockNodeAttrs({
				uploadId: "upload-xyz",
				error: "Timeout",
			}),
		);

		render(<ImageUploadNode node={node} onCancel={onCancel} />);

		const cancelButton = screen.getByRole("button", {
			name: /cancel upload/i,
		});
		await user.click(cancelButton);

		expect(onCancel).toHaveBeenCalledWith("upload-xyz");
	});

	it("shows cancel button during upload when progress < 100", () => {
		const onCancel = vi.fn();
		const node = createMockNode(createMockNodeAttrs({ progress: 30 }));

		render(<ImageUploadNode node={node} onCancel={onCancel} />);

		expect(
			screen.getByRole("button", { name: /cancel upload/i }),
		).toBeTruthy();
	});

	it("does not show cancel button when progress is 100 (processing)", () => {
		const onCancel = vi.fn();
		const node = createMockNode(createMockNodeAttrs({ progress: 100 }));

		render(<ImageUploadNode node={node} onCancel={onCancel} />);

		expect(
			screen.queryByRole("button", { name: /cancel upload/i }),
		).toBeNull();
	});

	it("does not show retry button when onRetry is not provided", () => {
		const node = createMockNode(createMockNodeAttrs({ error: "Failed" }));

		render(<ImageUploadNode node={node} />);

		expect(screen.queryByRole("button", { name: /retry/i })).toBeNull();
	});
});
