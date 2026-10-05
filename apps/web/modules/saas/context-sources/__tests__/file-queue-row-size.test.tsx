/**
 * Tests for the size a queued file shows on the File tab. The row writes the
 * size in the unit that fits it, so a small file reads as bytes or kilobytes
 * instead of rounding down to "0.00 MB".
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { FileSourceTabContent } from "../components/FileSourceTabContent";
import { useFileSourceForm } from "../hooks/use-file-source-form";
import type { ContextSourceSubmitAdapter } from "../lib/submit-adapter";

const adapter: ContextSourceSubmitAdapter = {
	createUploadUrl: vi.fn(async () => ({
		signedUploadUrl: "https://example.com/upload",
		contextId: "context-1",
	})),
	processFile: vi.fn(async () => undefined),
	processLink: vi.fn(async () => undefined),
	createText: vi.fn(async () => undefined),
	listQueryKey: ["stub-owner", "sources"],
};

const onComplete = vi.fn();

function Harness() {
	const form = useFileSourceForm({ adapter, onComplete });
	return <FileSourceTabContent form={form} isLoading={form.isLoading} />;
}

describe("FileSourceTabContent — queued file size", () => {
	it.each([
		[212, "212 B"],
		[6349, "6.2 KB"],
		[1.5 * 1024 * 1024, "1.5 MB"],
	])("writes a %d-byte file as %s", async (sizeBytes, written) => {
		const user = userEvent.setup();
		render(
			<QueryClientProvider client={new QueryClient()}>
				<Harness />
			</QueryClientProvider>,
		);

		await user.upload(
			document.getElementById("context-file-input") as HTMLInputElement,
			new File([new Uint8Array(sizeBytes)], "notes.pdf", {
				type: "application/pdf",
			}),
		);

		const row = within(
			screen.getByRole("list", { name: "Selected files" }),
		).getByRole("listitem");
		expect(within(row).getByText(written)).toBeInTheDocument();
	});
});
