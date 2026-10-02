/**
 * The shared context-source forms, driven by a stub owner.
 *
 * The File, Link and Text tab bodies and the source-details dialog were moved
 * out of the project dialog so a second owner can drive them. These tests pin
 * what an owner receives through its adapter: the payload of every submit
 * (file, single link, bulk link, text), one `onSourceAdded` per source that
 * landed, `onComplete` only when there is nothing left to review, and a
 * refresh of the owner's own list. The project dialog's own tests
 * (`projects/components/__tests__/ContextUploaderDialog.*`) pin the same
 * submits as `projects.contexts.*` calls.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
	afterEach,
	beforeAll,
	beforeEach,
	describe,
	expect,
	it,
	vi,
} from "vitest";

// ── jsdom polyfills (Radix radio / select) ───────────────────────────────
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		class ResizeObserverPolyfill {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		}
		(
			globalThis as unknown as {
				ResizeObserver: typeof ResizeObserverPolyfill;
			}
		).ResizeObserver = ResizeObserverPolyfill;
	}
	if (!HTMLElement.prototype.hasPointerCapture) {
		HTMLElement.prototype.hasPointerCapture = (() => false) as never;
	}
	if (!HTMLElement.prototype.scrollIntoView) {
		HTMLElement.prototype.scrollIntoView = (() => undefined) as never;
	}
});

const { getOrgProvidersMock, toastSuccess, toastError, toastWarning } =
	vi.hoisted(() => ({
		getOrgProvidersMock: vi.fn(),
		toastSuccess: vi.fn(),
		toastError: vi.fn(),
		toastWarning: vi.fn(),
	}));

// The Link tab's provider pre-flight is the only server call the shared forms
// make on their own; every write goes through the adapter.
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		searchProviders: {
			getOrganizationProviders: (input: unknown) =>
				getOrgProvidersMock(input),
			getUserProviders: vi.fn(),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => toastSuccess(...a),
		error: (...a: unknown[]) => toastError(...a),
		warning: (...a: unknown[]) => toastWarning(...a),
	},
}));

// Echo interpolation values so the details dialog's "last edited" line shows
// the resolved name, which the global echo mock drops.
vi.mock("next-intl", () => {
	const t = (key: string, values?: Record<string, unknown>) =>
		values ? `${key} ${JSON.stringify(values)}` : key;
	t.raw = (key: string) => key;
	return {
		useTranslations: () => t,
		useFormatter: () => ({
			dateTime: (date: Date) => date.toISOString().slice(0, 10),
		}),
	};
});

import { ContextSourceSubmitFooter } from "../components/ContextSourceSubmitFooter";
import { FileSourceTabContent } from "../components/FileSourceTabContent";
import { SourceDetailsDialog } from "../components/SourceDetailsDialog";
import { TextSourceTabContent } from "../components/TextSourceTabContent";
import { UrlSourceTabContent } from "../components/UrlSourceTabContent";
import { useFileSourceForm } from "../hooks/use-file-source-form";
import { useTextSourceForm } from "../hooks/use-text-source-form";
import { useUrlSourceForm } from "../hooks/use-url-source-form";
import type {
	ContextSourceAdded,
	ContextSourceDetailsAdapter,
	ContextSourceSubmitAdapter,
} from "../lib/submit-adapter";

// ── Harness ──────────────────────────────────────────────────────────────

const LIST_KEY = ["stub-owner", "sources"];

const FIRECRAWL_ROW = {
	id: "sp_1",
	providerName: "firecrawl",
	enabled: true,
	maskedApiKey: "fc-…abcd",
	isDefault: true,
	priority: 0,
};

function stubAdapter() {
	return {
		createUploadUrl: vi.fn(
			async (file: {
				filename: string;
				mimeType: string;
				size: number;
			}) => ({
				signedUploadUrl: `https://storage.example.com/put/${file.filename}`,
				contextId: `ctx-${file.filename}`,
				...(file.filename.endsWith(".pdf")
					? { contentType: "application/pdf" }
					: {}),
			}),
		),
		processFile: vi.fn(async () => undefined),
		processLink: vi.fn(async () => undefined),
		createText: vi.fn(async () => undefined),
		listQueryKey: LIST_KEY,
	} satisfies ContextSourceSubmitAdapter;
}

type StubAdapter = ReturnType<typeof stubAdapter>;

/** A minimal owner: the three shared tabs and the shared footer. */
function StubOwnerForms({
	tab,
	adapter,
	onSourceAdded,
	onComplete,
}: {
	tab: "file" | "link" | "text";
	adapter: ContextSourceSubmitAdapter;
	onSourceAdded: (added: ContextSourceAdded) => void;
	onComplete: () => void;
}) {
	const file = useFileSourceForm({ adapter, onSourceAdded, onComplete });
	const link = useUrlSourceForm({
		adapter,
		open: true,
		organizationId: "org-1",
		organizationSlug: "example-org",
		requireKnowledgeBaseCategory: false,
		onSourceAdded,
		onComplete,
	});
	const text = useTextSourceForm({ adapter, onSourceAdded, onComplete });
	const isLoading = file.isLoading || link.isLoading || text.isLoading;

	return (
		<>
			{tab === "file" && (
				<FileSourceTabContent form={file} isLoading={isLoading} />
			)}
			{tab === "link" && (
				<UrlSourceTabContent form={link} isLoading={isLoading} />
			)}
			{tab === "text" && (
				<TextSourceTabContent form={text} isLoading={isLoading} />
			)}
			<ContextSourceSubmitFooter
				tab={tab}
				file={file}
				link={link}
				text={text}
				isLoading={isLoading}
				onCancel={vi.fn()}
			/>
		</>
	);
}

function renderForms(tab: "file" | "link" | "text", adapter: StubAdapter) {
	const onSourceAdded = vi.fn();
	const onComplete = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	render(
		<QueryClientProvider client={queryClient}>
			<StubOwnerForms
				tab={tab}
				adapter={adapter}
				onSourceAdded={onSourceAdded}
				onComplete={onComplete}
			/>
		</QueryClientProvider>,
	);
	return { onSourceAdded, onComplete, invalidateSpy };
}

function makeFile(name: string, type: string, sizeBytes = 1024): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

/** The Link tab is usable once the provider pre-flight has resolved. */
async function waitForPreflight() {
	await screen.findByTestId("url-source-indexing-with");
}

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	getOrgProvidersMock.mockResolvedValue([FIRECRAWL_ROW]);
	fetchMock.mockImplementation(
		async () => new Response(null, { status: 200 }),
	);
	Object.defineProperty(globalThis, "fetch", {
		writable: true,
		configurable: true,
		value: fetchMock,
	});
});

afterEach(() => {
	vi.useRealTimers();
});

// ── File tab ─────────────────────────────────────────────────────────────

describe("shared forms — File tab through the adapter", () => {
	it("hands each queued file to the adapter and PUTs its bytes to the URL it returned", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		const { onSourceAdded, onComplete, invalidateSpy } = renderForms(
			"file",
			adapter,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		// The markdown file arrives untyped, as it does from an OS that has no
		// registration for `.md`.
		await user.upload(input, [
			makeFile("brief.pdf", "application/pdf"),
			makeFile("notes.md", ""),
		]);
		await user.click(
			screen.getByRole("button", { name: /^Upload 2 files$/ }),
		);

		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));

		expect(adapter.createUploadUrl).toHaveBeenCalledTimes(2);
		expect(adapter.createUploadUrl).toHaveBeenCalledWith({
			filename: "brief.pdf",
			mimeType: "application/pdf",
			size: 1024,
		});
		expect(adapter.createUploadUrl).toHaveBeenCalledWith({
			filename: "notes.md",
			mimeType: "application/octet-stream",
			size: 1024,
		});

		// The server's resolved type wins; without one the client resolves
		// the untyped file from its extension.
		expect(fetchMock).toHaveBeenCalledWith(
			"https://storage.example.com/put/brief.pdf",
			expect.objectContaining({
				method: "PUT",
				headers: { "Content-Type": "application/pdf" },
			}),
		);
		expect(fetchMock).toHaveBeenCalledWith(
			"https://storage.example.com/put/notes.md",
			expect.objectContaining({
				method: "PUT",
				headers: { "Content-Type": "text/markdown" },
			}),
		);

		expect(adapter.processFile).toHaveBeenCalledWith({
			contextId: "ctx-brief.pdf",
		});
		expect(adapter.processFile).toHaveBeenCalledWith({
			contextId: "ctx-notes.md",
		});
		expect(onSourceAdded).toHaveBeenCalledTimes(2);
		expect(onSourceAdded).toHaveBeenCalledWith({ contextType: "FILE" });
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
		expect(toastSuccess).toHaveBeenCalledWith("2 files uploaded");
	});

	it("fails only the row the adapter refused, and keeps the dialog open", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		adapter.createUploadUrl.mockImplementationOnce(async () => {
			throw new Error("Storage is not available for this owner");
		});
		const { onSourceAdded, onComplete, invalidateSpy } = renderForms(
			"file",
			adapter,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("first.pdf", "application/pdf"),
			makeFile("second.pdf", "application/pdf"),
		]);
		await user.click(
			screen.getByRole("button", { name: /^Upload 2 files$/ }),
		);

		expect(
			await screen.findByText("Storage is not available for this owner"),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(adapter.processFile).toHaveBeenCalledTimes(1),
		);
		expect(onSourceAdded).toHaveBeenCalledTimes(1);
		expect(onComplete).not.toHaveBeenCalled();
		// The row that did land still shows up in the owner's list.
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
		expect(toastWarning).toHaveBeenCalled();
	});
});

// ── Link tab ─────────────────────────────────────────────────────────────

describe("shared forms — Link tab through the adapter", () => {
	it("sends a single URL with only the fields the user set", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		const { onSourceAdded, onComplete, invalidateSpy } = renderForms(
			"link",
			adapter,
		);
		await waitForPreflight();

		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/pricing",
		);
		await user.type(
			screen.getByLabelText(/^Label \(Optional\)$/),
			"Pricing page",
		);
		await user.type(
			screen.getByLabelText("sourceDetails.typeLabelOptional"),
			"Knowledge Base",
		);
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		// No owner identifiers and no category: the owner's adapter adds its
		// own ids, and the category field is off for an owner that does not
		// require it.
		expect(adapter.processLink).toHaveBeenCalledTimes(1);
		expect(adapter.processLink).toHaveBeenCalledWith({
			url: "https://example.com/pricing",
			label: "Pricing page",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
			sourceType: "Knowledge Base",
		});
		expect(onSourceAdded).toHaveBeenCalledWith({
			contextType: "LINK",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
			maxPages: null,
		});
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
		expect(
			screen.queryByLabelText(/knowledge base source category/i),
		).not.toBeInTheDocument();
	});

	it("carries the page cap for a path-prefix crawl", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		const { onSourceAdded } = renderForms("link", adapter);
		await waitForPreflight();

		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/docs/",
		);
		// Blur runs the scope auto-detect, which picks path-prefix for a docs
		// section when a crawl-capable provider is configured.
		await user.tab();
		await screen.findByLabelText("Max pages to crawl");
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() =>
			expect(adapter.processLink).toHaveBeenCalledTimes(1),
		);
		expect(adapter.processLink).toHaveBeenCalledWith({
			url: "https://example.com/docs/",
			scope: "PATH_PREFIX",
			refreshMode: "ONCE",
			maxPages: 200,
		});
		expect(onSourceAdded).toHaveBeenCalledWith({
			contextType: "LINK",
			scope: "PATH_PREFIX",
			refreshMode: "ONCE",
			maxPages: 200,
		});
	});

	it("sends one call per unique pasted URL with the shared settings only, then closes", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		const { onSourceAdded, onComplete, invalidateSpy } = renderForms(
			"link",
			adapter,
		);
		await waitForPreflight();

		await user.click(screen.getByRole("tab", { name: /Multiple URLs/i }));
		const textarea = await screen.findByLabelText(/URLs \(one per line\)/i);
		await user.click(textarea);
		await user.paste(
			[
				"https://example.com/about",
				"https://example.com/customers",
				"https://EXAMPLE.com/about/",
			].join("\n"),
		);
		await user.click(screen.getByRole("button", { name: /^Add 2 URLs$/ }));

		await waitFor(() =>
			expect(adapter.processLink).toHaveBeenCalledTimes(2),
		);
		// Every line shares scope and refresh; a bulk line carries no label
		// or type label of its own.
		expect(adapter.processLink).toHaveBeenCalledWith({
			url: "https://example.com/about",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
		});
		expect(adapter.processLink).toHaveBeenCalledWith({
			url: "https://example.com/customers",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
		});
		await waitFor(() => expect(onSourceAdded).toHaveBeenCalledTimes(2));
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });

		// A fully successful batch leaves its summary up briefly, then
		// completes.
		expect(onComplete).not.toHaveBeenCalled();
		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1), {
			timeout: 3_500,
		});
	});

	it("reports nothing and keeps the form when the adapter rejects the link", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		adapter.processLink.mockRejectedValueOnce(new Error("Crawler offline"));
		const { onSourceAdded, onComplete, invalidateSpy } = renderForms(
			"link",
			adapter,
		);
		await waitForPreflight();

		await user.type(
			screen.getByLabelText("URL"),
			"https://example.com/team",
		);
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() =>
			expect(toastError).toHaveBeenCalledWith(
				"Failed to add URL source: Crawler offline",
			),
		);
		expect(onSourceAdded).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
		expect(invalidateSpy).not.toHaveBeenCalled();
		expect(screen.getByLabelText("URL")).toHaveValue(
			"https://example.com/team",
		);
	});
});

// ── Text tab ─────────────────────────────────────────────────────────────

describe("shared forms — Text tab through the adapter", () => {
	it("sends the trimmed title and content", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		const { onSourceAdded, onComplete, invalidateSpy } = renderForms(
			"text",
			adapter,
		);

		await user.type(screen.getByLabelText("Title"), "  Positioning  ");
		await user.type(
			screen.getByLabelText("Content"),
			"  We build tools for teams.  ",
		);
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() => expect(onComplete).toHaveBeenCalledTimes(1));
		expect(adapter.createText).toHaveBeenCalledTimes(1);
		expect(adapter.createText).toHaveBeenCalledWith({
			title: "Positioning",
			content: "We build tools for teams.",
		});
		expect(onSourceAdded).toHaveBeenCalledWith({ contextType: "TEXT" });
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
	});

	it("refuses a text without a title before reaching the adapter", async () => {
		const user = userEvent.setup();
		const adapter = stubAdapter();
		const { onComplete } = renderForms("text", adapter);

		await user.type(screen.getByLabelText("Content"), "Body only");
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		expect(toastError).toHaveBeenCalledWith(
			"Please enter both title and content",
		);
		expect(adapter.createText).not.toHaveBeenCalled();
		expect(onComplete).not.toHaveBeenCalled();
	});
});

// ── Source details ───────────────────────────────────────────────────────

describe("SourceDetailsDialog — through a details adapter", () => {
	function stubDetailsAdapter() {
		return {
			saveMetadata: vi.fn(async (input: { contextId: string }) => ({
				contextId: input.contextId,
				sourceType: "SDK Docs",
				aiInstructions: null,
				metadataUpdatedAt: "2026-09-30T09:00:00.000Z",
				metadataUpdatedByUserId: "user-2",
			})),
			listQueryKey: LIST_KEY,
			useEditorName: vi.fn((userId: string | null) =>
				userId === "user-2" ? "Dana Example" : null,
			),
		} satisfies ContextSourceDetailsAdapter;
	}

	function renderDetails(
		adapter: ReturnType<typeof stubDetailsAdapter>,
		stamped: boolean,
	) {
		const onOpenChange = vi.fn();
		const queryClient = new QueryClient({
			defaultOptions: {
				queries: { retry: false },
				mutations: { retry: false },
			},
		});
		queryClient.setQueryData(LIST_KEY, {
			contexts: [
				{
					id: "ctx-1",
					sourceType: "Client Chat",
					aiInstructions: null,
				},
			],
		});
		render(
			<QueryClientProvider client={queryClient}>
				<SourceDetailsDialog
					open
					onOpenChange={onOpenChange}
					adapter={adapter}
					contextId="ctx-1"
					sourceName="Company overview"
					initialSourceType="Client Chat"
					initialAiInstructions={null}
					{...(stamped
						? {
								initialMetadataUpdatedAt:
									"2026-09-20T08:00:00.000Z",
								initialMetadataUpdatedByUserId: "user-2",
							}
						: {})}
				/>
			</QueryClientProvider>,
		);
		return { onOpenChange, queryClient };
	}

	it("saves through the adapter against the opened version and updates the adapter's list", async () => {
		const user = userEvent.setup();
		const adapter = stubDetailsAdapter();
		const { onOpenChange, queryClient } = renderDetails(adapter, false);

		const type = screen.getByLabelText("typeLabel");
		await user.clear(type);
		await user.type(type, "SDK Docs");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(adapter.saveMetadata).toHaveBeenCalledWith({
			contextId: "ctx-1",
			sourceType: "SDK Docs",
			aiInstructions: null,
			expected: { sourceType: "Client Chat", aiInstructions: null },
		});
		expect(
			(
				queryClient.getQueryData(LIST_KEY) as {
					contexts: Array<Record<string, unknown>>;
				}
			).contexts[0],
		).toMatchObject({
			id: "ctx-1",
			sourceType: "SDK Docs",
			metadataUpdatedByUserId: "user-2",
		});
	});

	it("names the last editor through the adapter's resolver", () => {
		const adapter = stubDetailsAdapter();
		renderDetails(adapter, true);

		const line = screen.getByTestId("context-source-last-edited");
		expect(line).toHaveTextContent("lastEditedBy");
		expect(within(line).getByText(/Dana Example/)).toBeInTheDocument();
		expect(line).toHaveTextContent("2026-09-20");
		expect(adapter.useEditorName).toHaveBeenCalledWith("user-2");
	});

	it("does not look anyone up for a source nobody has edited", () => {
		const adapter = stubDetailsAdapter();
		renderDetails(adapter, false);

		expect(
			screen.queryByTestId("context-source-last-edited"),
		).not.toBeInTheDocument();
		expect(adapter.useEditorName).not.toHaveBeenCalled();
	});
});
