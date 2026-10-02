/**
 * Tests for the File tab's in-flight guard: a file dropped onto the zone
 * while a batch is uploading must not queue silently and must not be
 * discarded by that batch's own auto-close. Two layers are pinned
 * separately since the fix touches both:
 *   - the component gate in `FileSourceTabContent` (drop/select ignored
 *     while `isLoading`);
 *   - the hook's own defense in `useFileSourceForm` (don't auto-close over
 *     a row that landed after the settled batch's own snapshot).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), warning: vi.fn() },
}));

import { FileSourceTabContent } from "../components/FileSourceTabContent";
import {
	useFileSourceForm,
	type FileSourceForm,
	type UploadedFileRow,
} from "../hooks/use-file-source-form";
import type { ContextSourceSubmitAdapter } from "../lib/submit-adapter";

const LIST_KEY = ["stub-owner", "sources"];

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

function makeRow(
	name: string,
	status: UploadedFileRow["status"],
): UploadedFileRow {
	return {
		id: name,
		file: makeFile(name, "application/pdf"),
		name,
		size: 1024,
		mimeType: "application/pdf",
		status,
	};
}

function newQueryClient() {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
}

beforeEach(() => {
	vi.clearAllMocks();
	Object.defineProperty(globalThis, "fetch", {
		writable: true,
		configurable: true,
		value: vi.fn(async () => new Response(null, { status: 200 })),
	});
});

describe("FileSourceTabContent — drop/select gated while a batch is in flight", () => {
	function Harness({
		adapter,
		onComplete,
	}: {
		adapter: ContextSourceSubmitAdapter;
		onComplete: () => void;
	}) {
		const form = useFileSourceForm({ adapter, onComplete });
		return (
			<>
				<FileSourceTabContent form={form} isLoading={form.isLoading} />
				{/* Stands in for ContextSourceSubmitFooter's "Upload" button —
				    only the tab body's own drop gate is under test here. */}
				<button
					type="button"
					disabled={form.isLoading}
					onClick={() => form.upload()}
				>
					trigger-upload
				</button>
			</>
		);
	}

	it("ignores a file dropped onto the zone while an earlier file is still uploading", async () => {
		const user = userEvent.setup();
		let resolveCreateUploadUrl:
			| ((value: { signedUploadUrl: string; contextId: string }) => void)
			| undefined;
		const adapter: ContextSourceSubmitAdapter = {
			createUploadUrl: vi.fn(
				() =>
					new Promise((resolve) => {
						resolveCreateUploadUrl = resolve;
					}),
			),
			processFile: vi.fn(async () => undefined),
			processLink: vi.fn(async () => undefined),
			createText: vi.fn(async () => undefined),
			listQueryKey: LIST_KEY,
		};
		const onComplete = vi.fn();
		const { container } = render(
			<QueryClientProvider client={newQueryClient()}>
				<Harness adapter={adapter} onComplete={onComplete} />
			</QueryClientProvider>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, makeFile("a.pdf", "application/pdf"));
		await user.click(
			screen.getByRole("button", { name: "trigger-upload" }),
		);

		// The batch is now mid-flight — createUploadUrl is pending, so
		// isLoading is true and the dropzone must ignore an incoming file.
		await waitFor(() => expect(adapter.createUploadUrl).toHaveBeenCalled());
		const dropzone = container.querySelector<HTMLElement>(".border-dashed");
		if (!dropzone) {
			throw new Error("dropzone not found");
		}
		fireEvent.drop(dropzone, {
			dataTransfer: { files: [makeFile("b.pdf", "application/pdf")] },
		});

		expect(screen.queryByText("b.pdf")).not.toBeInTheDocument();

		resolveCreateUploadUrl?.({
			signedUploadUrl: "https://storage.example.com/put/a.pdf",
			contextId: "ctx-a",
		});
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
	});
});

describe("useFileSourceForm — auto-close after a batch settles clean", () => {
	function HookHarness({
		adapter,
		onComplete,
		formRef,
	}: {
		adapter: ContextSourceSubmitAdapter;
		onComplete: () => void;
		formRef: { current: FileSourceForm | null };
	}) {
		const form = useFileSourceForm({ adapter, onComplete });
		formRef.current = form;
		return null;
	}

	it("does not close the dialog when a row lands after the settled batch's own snapshot", async () => {
		const adapter: ContextSourceSubmitAdapter = {
			createUploadUrl: vi.fn(async () => ({
				signedUploadUrl: "https://storage.example.com/put/a.pdf",
				contextId: "ctx-a",
			})),
			processFile: vi.fn(async () => undefined),
			processLink: vi.fn(async () => undefined),
			createText: vi.fn(async () => undefined),
			listQueryKey: LIST_KEY,
		};
		const onComplete = vi.fn();
		const formRef: { current: FileSourceForm | null } = { current: null };
		render(
			<QueryClientProvider client={newQueryClient()}>
				<HookHarness
					adapter={adapter}
					onComplete={onComplete}
					formRef={formRef}
				/>
			</QueryClientProvider>,
		);

		await act(async () => {
			formRef.current?.setFiles([makeRow("a.pdf", "queued")]);
		});

		// Start the batch, then — before any of its awaits resolve — inject the
		// row a drop landed mid-flight. `upload()`'s own `files` closure
		// snapshotted only "a.pdf"; the live queue (what the component gate
		// reads from on its next render) now also has "b.pdf".
		let uploadDone: Promise<void> | undefined;
		await act(async () => {
			uploadDone = formRef.current?.upload();
			formRef.current?.setFiles((prev) => [
				...prev,
				makeRow("b.pdf", "queued"),
			]);
			await uploadDone;
		});

		expect(onComplete).not.toHaveBeenCalled();
		expect(
			formRef.current?.files.find((row) => row.name === "b.pdf")?.status,
		).toBe("queued");
	});
});
