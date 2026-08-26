/**
 * Component tests for the multi-file upgrade on the File tab (Group 7).
 *
 * Spec:
 * - fabric/specs/2026-05-23-unified-context-uploader-wizard/spec.md §7.1, §7.2
 * - fabric/specs/2026-05-23-unified-context-uploader-wizard/tasks.md Group 7
 * - CLAUDE.md editorial aesthetic (banned-token regression mirrors the sibling
 *   `ContextUploaderDialog.test.tsx`).
 *
 * Scope (per tasks.md 7.8):
 *   (a) file array accumulates on sequential multi-drop / multi-pick;
 *   (b) oversize file rejected with inline error, siblings proceed;
 *   (c) all-success batch closes the dialog + invalidates the contexts query;
 *   (d) submit-button label switches from "Upload" to "Upload 3 files" on
 *       count change;
 *   (e) disabled while uploading state present.
 *
 * Plus an editorial-aesthetic banned-token regression net on the new File-tab
 * markup so the multi-file upgrade does not reintroduce gradients,
 * glassmorphism, animated blob orbs, or hardcoded hex colors.
 *
 * Later addition — the type gate moved from the server's 400 to queue time:
 *   (i)   an unsupported file is refused as it enters the queue, before any
 *         upload request, and its siblings in the same batch are unaffected;
 *   (ii)  the refusal names the file, the refused type, and the accepted
 *         formats, all derived from the shared vocabulary in `@repo/utils`;
 *   (iii) the dropzone's supported-format copy is derived from that same
 *         vocabulary rather than hand-written;
 *   (iv)  the refusal is announced in a pre-mounted `aria-live` region and
 *         persists as a removable failed row.
 */

import {
	CONTEXT_UPLOAD_ACCEPT_ATTR,
	CONTEXT_UPLOAD_FORMAT_LABELS,
} from "@repo/utils";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ── jsdom polyfills ──────────────────────────────────────────────────────
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

// ── Module mocks ─────────────────────────────────────────────────────────

const {
	createUploadUrlMock,
	processFileMock,
	contextsListMock,
	mcpConfigsListMock,
	getUserSearchProvidersMock,
	getOrgSearchProvidersMock,
	trackEventMock,
	invalidateQueriesMock,
} = vi.hoisted(() => ({
	createUploadUrlMock: vi.fn(),
	processFileMock: vi.fn(),
	contextsListMock: vi.fn(),
	mcpConfigsListMock: vi.fn(),
	getUserSearchProvidersMock: vi.fn(),
	getOrgSearchProvidersMock: vi.fn(),
	trackEventMock: vi.fn(),
	invalidateQueriesMock: vi.fn(),
}));

// The dialog reads PROJECT_READINESS to decide whether a link source has to be
// classified before it is saved (Fizzy #2165). Every assertion in this file
// predates that field and describes the flag-OFF behaviour, which must stay
// byte-identical to what shipped before it — so this mock is the regression
// guard, not a convenience.
vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: () => false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			contexts: {
				processLink: vi.fn(),
				list: (input: unknown) => contextsListMock(input),
				createUploadUrl: (input: unknown) => createUploadUrlMock(input),
				processFile: (input: unknown) => processFileMock(input),
			},
		},
		searchProviders: {
			getUserProviders: () => getUserSearchProvidersMock(),
			getOrganizationProviders: (input: unknown) =>
				getOrgSearchProvidersMock(input),
		},
		mcp: {
			configs: {
				list: (input: unknown) => mcpConfigsListMock(input),
			},
		},
	},
}));

vi.mock("@analytics", () => ({
	useAnalytics: () => ({ trackEvent: trackEventMock }),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				list: {
					queryKey: (args: { input: unknown }) => [
						"projects.contexts.list",
						args.input,
					],
				},
				create: {
					mutationOptions: ({
						onSuccess,
						onError,
					}: {
						onSuccess?: () => void;
						onError?: (err: { message: string }) => void;
					}) => ({
						mutationFn: vi.fn(),
						onSuccess,
						onError,
					}),
				},
			},
		},
	},
}));

const { toastSuccessMock, toastErrorMock, toastWarningMock } = vi.hoisted(
	() => ({
		toastSuccessMock: vi.fn(),
		toastErrorMock: vi.fn(),
		toastWarningMock: vi.fn(),
	}),
);

vi.mock("sonner", () => ({
	toast: {
		success: toastSuccessMock,
		error: toastErrorMock,
		warning: toastWarningMock,
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({
		organizationId: null,
		organizationSlug: null,
		basePath: "/app",
	}),
}));

vi.mock("@saas/settings/hooks/use-settings-return-url", () => ({
	useSettingsReturnUrl: () => (path: string) => path,
}));

vi.mock("../NotionResourceBrowser", () => ({
	NotionResourceBrowser: () => null,
}));
vi.mock("../SlackChannelSelectorDialog", () => ({
	SlackChannelSelectorDialog: () => null,
}));
vi.mock("../TeamsChatSelectorDialog", () => ({
	TeamsChatSelectorDialog: () => null,
}));
vi.mock("../GoogleDocsSelectorDialog", () => ({
	GoogleDocsSelectorDialog: () => null,
}));

// `useQueryClient` is hooked so we can assert that the success path
// invalidates `projects.contexts.list` (Group 8's pending-items list reads
// this query). We rely on the real QueryClient + a spy on invalidateQueries.
import { ContextUploaderDialog } from "../ContextUploaderDialog";

// ── Helpers ──────────────────────────────────────────────────────────────

function wrap(
	ui: React.ReactElement,
	{ client }: { client?: QueryClient } = {},
) {
	const resolvedClient =
		client ??
		new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
	// Wrap invalidateQueries so tests can assert the contexts list refresh.
	const originalInvalidate =
		resolvedClient.invalidateQueries.bind(resolvedClient);
	resolvedClient.invalidateQueries = ((args: unknown) => {
		invalidateQueriesMock(args);
		return originalInvalidate(args as never);
	}) as typeof resolvedClient.invalidateQueries;
	return render(
		<QueryClientProvider client={resolvedClient}>{ui}</QueryClientProvider>,
	);
}

// Construct a `File` with a controllable byte-size. Used to exercise the
// per-file size-limit branch without allocating real megabytes.
function makeFile(name: string, type: string, sizeBytes = 1024): File {
	return new File([new Uint8Array(sizeBytes)], name, { type });
}

const banned: ReadonlyArray<{ name: string; pattern: RegExp }> = [
	{ name: "from-*-500 (gradient pill start)", pattern: /from-\w+-500/ },
	{ name: "to-*-500 (gradient pill end)", pattern: /to-\w+-500/ },
	{ name: "bg-gradient-to-*", pattern: /bg-gradient-to-/ },
	{ name: "backdrop-blur", pattern: /backdrop-blur/ },
	{
		name: "animate-pulse rounded-full blur-[…] orb",
		pattern: /animate-pulse\s+rounded-full\s+blur-\[/,
	},
	{
		name: "hardcoded hex color literal",
		pattern: /#[0-9a-fA-F]{3,8}\b/,
	},
];

function assertNoBannedTokens(root: HTMLElement, label: string) {
	const html = root.innerHTML;
	for (const { name, pattern } of banned) {
		expect(
			pattern.test(html),
			`Editorial regression (${label}): markup contains ${name}.`,
		).toBe(false);
	}
}

// Canonical configured-provider row so the dialog's pre-flight resolves
// without rendering the URL-tab notice card (irrelevant to file-tab tests).
const FIRECRAWL_CONFIGURED_ROW = {
	id: "row_fc_1",
	providerName: "firecrawl" as const,
	maskedApiKey: "fc-***-1234",
	endpoint: null,
	isDefault: true,
	priority: 0,
	enabled: true,
	lastUsedAt: null,
	searchesCount: 0,
	totalCost: 0,
};

describe("ContextUploaderDialog — multi-file upgrade (File tab)", () => {
	beforeEach(() => {
		createUploadUrlMock.mockReset();
		processFileMock.mockReset();
		contextsListMock.mockReset();
		mcpConfigsListMock.mockReset();
		getUserSearchProvidersMock.mockReset();
		getOrgSearchProvidersMock.mockReset();
		trackEventMock.mockReset();
		invalidateQueriesMock.mockReset();
		toastSuccessMock.mockReset();
		toastErrorMock.mockReset();
		toastWarningMock.mockReset();

		contextsListMock.mockResolvedValue({ contexts: [] });
		mcpConfigsListMock.mockResolvedValue([]);
		getUserSearchProvidersMock.mockResolvedValue([
			FIRECRAWL_CONFIGURED_ROW,
		]);
		getOrgSearchProvidersMock.mockResolvedValue([FIRECRAWL_CONFIGURED_ROW]);

		// Default to a fast happy-path: `createUploadUrl` returns a stub URL,
		// `fetch` succeeds, `processFile` resolves. Individual tests override
		// these to exercise failure branches.
		createUploadUrlMock.mockImplementation(
			async (input: { filename: string }) => ({
				signedUploadUrl: "https://example.com/upload",
				contextId: `ctx_${input.filename}`,
			}),
		);
		processFileMock.mockResolvedValue(undefined);

		// Stub the global `fetch` used for the S3 PUT.
		Object.defineProperty(globalThis, "fetch", {
			writable: true,
			configurable: true,
			value: vi.fn(async () => new Response(null, { status: 200 })),
		});
	});

	// ── (a) file array accumulates on sequential multi-drop / multi-pick ──
	it("accumulates files across sequential drops and picks", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// First: pick two files via the input
		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		const file1 = makeFile("doc1.pdf", "application/pdf");
		const file2 = makeFile("doc2.pdf", "application/pdf");
		await user.upload(input, [file1, file2]);

		await waitFor(() => {
			expect(screen.getByText("doc1.pdf")).toBeInTheDocument();
			expect(screen.getByText("doc2.pdf")).toBeInTheDocument();
		});

		// Second: drop one more file via the dropzone. Confirm prior files
		// remain (accumulation, not replacement).
		const dropzone = screen.getByText(/Drop more files or browse/i)
			.parentElement?.parentElement as HTMLElement;
		expect(dropzone).toBeTruthy();
		const file3 = makeFile("doc3.pdf", "application/pdf");
		const dt = new DataTransfer();
		dt.items.add(file3);
		fireEvent.drop(dropzone, { dataTransfer: dt });

		await waitFor(() => {
			expect(screen.getByText("doc1.pdf")).toBeInTheDocument();
			expect(screen.getByText("doc2.pdf")).toBeInTheDocument();
			expect(screen.getByText("doc3.pdf")).toBeInTheDocument();
		});
	});

	// ── (b) oversize file rejected inline, siblings proceed ──
	it("flags oversize files with an inline error pill and excludes them from the batch", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		// PDF size limit is 20 MB per `UPLOAD_SIZE_LIMITS.DOCUMENT`. Pick a
		// 25 MB blob alongside a 1 KB sibling.
		const ok = makeFile("small.pdf", "application/pdf");
		const tooBig = makeFile(
			"giant.pdf",
			"application/pdf",
			25 * 1024 * 1024,
		);
		await user.upload(input, [ok, tooBig]);

		await waitFor(() => {
			// Oversize row carries a "Failed" status pill plus the size-limit
			// copy on its own line — the reason no longer lives inside the
			// pill, because a sentence there collapsed the filename column.
			// The "Done" pill on the sibling is asserted by the success path
			// below.
			expect(screen.getByText(/^Failed$/)).toBeInTheDocument();
			// Appears twice by design: the failed row and the live region that
			// announces it. getAllByText, not a narrowed regex.
			expect(screen.getAllByText(/too large/i).length).toBeGreaterThan(0);
			expect(screen.getByText("giant.pdf")).toBeInTheDocument();
			expect(screen.getByText("small.pdf")).toBeInTheDocument();
		});

		// Footer "Upload" copy reads `Upload` (only one queueable row — the
		// oversize is `failed`, not `queued`).
		expect(
			screen.getByRole("button", { name: /^Upload$/ }),
		).toBeInTheDocument();

		// Submit — only the small.pdf row should hit createUploadUrl.
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledTimes(1);
		});
		expect(createUploadUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({ filename: "small.pdf" }),
		);
	});

	// ── untyped files: size-check and PUT use the resolved type (#2139) ──
	it("sizes an untyped image against the image limit, not the file limit", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		// The OS gave the browser no type for this file, so the client would
		// otherwise categorize the octet-stream placeholder as FILE (20 MB) and
		// let a 15 MB image through, only for the server to refuse it against
		// the 10 MB image limit after the upload had already run.
		const untypedBigImage = makeFile("photo.png", "", 15 * 1024 * 1024);
		await user.upload(input, [untypedBigImage]);

		await waitFor(() => {
			expect(screen.getByText(/^Failed$/)).toBeInTheDocument();
			// Appears twice by design: the failed row and the live region that
			// announces it. getAllByText, not a narrowed regex.
			expect(screen.getAllByText(/too large/i).length).toBeGreaterThan(0);
		});
	});

	it("queues an untyped markdown file at the larger file limit", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		const untypedMarkdown = makeFile("design.md", "", 15 * 1024 * 1024);
		await user.upload(input, [untypedMarkdown]);

		await waitFor(() => {
			expect(screen.getByText("design.md")).toBeInTheDocument();
		});
		expect(screen.queryByText(/Too large/i)).not.toBeInTheDocument();
	});

	it("PUTs the type the server resolved, not the browser placeholder", async () => {
		const user = userEvent.setup();
		// The server is the authority on the resolved type; the client only
		// falls back when talking to a deployment that predates the field.
		createUploadUrlMock.mockImplementation(
			async (input: { filename: string }) => ({
				signedUploadUrl: "https://example.com/upload",
				contextId: `ctx_${input.filename}`,
				contentType: "text/markdown",
			}),
		);
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [makeFile("design.md", "")]);
		await waitFor(() => {
			expect(screen.getByText("design.md")).toBeInTheDocument();
		});
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://example.com/upload",
				expect.objectContaining({
					method: "PUT",
					headers: { "Content-Type": "text/markdown" },
				}),
			);
		});
	});

	it("falls back to the locally resolved type when the server omits it", async () => {
		const user = userEvent.setup();
		// A new bundle against a server that predates the `contentType` field.
		// The default mock already omits it.
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [makeFile("design.md", "")]);
		await waitFor(() => {
			expect(screen.getByText("design.md")).toBeInTheDocument();
		});
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => {
			expect(globalThis.fetch).toHaveBeenCalledWith(
				"https://example.com/upload",
				expect.objectContaining({
					method: "PUT",
					headers: { "Content-Type": "text/markdown" },
				}),
			);
		});
	});

	// Was: "keeps siblings uploading when one file resolves to nothing", which
	// asserted the `.rar` *queued*, was submitted, and only then failed on the
	// server's 400. The refusal moved to queue time, so the same sibling
	// guarantee is now asserted at the new refusal point: the unresolvable file
	// never reaches the network, and its sibling stays queueable.
	it("refuses an unresolvable file at queue time and keeps its sibling queueable", async () => {
		// `applyAccept: false` stands in for a drag-and-drop, the only way an
		// unadvertised extension reaches the dropzone — the accept attribute
		// filters it out of the file dialog but never guards a drop.
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("archive.rar", ""),
			makeFile("design.md", ""),
		]);
		await waitFor(() => {
			expect(screen.getByText("archive.rar")).toBeInTheDocument();
			expect(screen.getByText("design.md")).toBeInTheDocument();
		});

		// Each file judged on its own: one failed row, one ready row.
		const refusedRow = screen.getByText("archive.rar").closest("li");
		expect(refusedRow).not.toBeNull();
		expect(
			within(refusedRow as HTMLElement).getByRole("status"),
		).toHaveTextContent(/^Failed$/);
		const acceptedRow = screen.getByText("design.md").closest("li");
		expect(
			within(acceptedRow as HTMLElement).getByRole("status"),
		).toHaveTextContent(/^Ready$/);

		// Refused before submit — the server was never consulted.
		expect(createUploadUrlMock).not.toHaveBeenCalled();

		// Only one queueable row, so the footer reads the single-file copy.
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledTimes(1);
		});
		expect(createUploadUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({ filename: "design.md" }),
		);
	});

	// ── R12 / R14 / R18: type gate runs at queue time, per file ──
	it("refuses an unsupported file and queues its supported sibling from the same batch", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile(
				"deck.pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			),
			makeFile("brief.pdf", "application/pdf"),
		]);

		await waitFor(() => {
			expect(screen.getByText("deck.pptx")).toBeInTheDocument();
			expect(screen.getByText("brief.pdf")).toBeInTheDocument();
		});

		// Exactly one refusal and one ready row.
		expect(screen.getAllByText(/^Failed$/)).toHaveLength(1);
		expect(screen.getAllByText(/^Ready$/)).toHaveLength(1);

		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledTimes(1);
		});
		expect(createUploadUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({ filename: "brief.pdf" }),
		);
	});

	it("names the refused type and the accepted formats, before any upload request", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile(
				"deck.pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			),
		]);

		const refusedRow = await waitFor(() => {
			const row = screen.getByText("deck.pptx").closest("li");
			if (!row) {
				throw new Error("refused row not rendered yet");
			}
			return row as HTMLElement;
		});

		// R14 — the reason names the file, the refused type, and what would
		// have been accepted.
		expect(refusedRow).toHaveTextContent("deck.pptx");
		expect(refusedRow).toHaveTextContent(
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);
		for (const label of CONTEXT_UPLOAD_FORMAT_LABELS) {
			expect(refusedRow).toHaveTextContent(label);
		}

		// R12 — refused at queue time. Nothing was uploaded, and the submit
		// button has no queueable row to act on.
		expect(createUploadUrlMock).not.toHaveBeenCalled();
		expect(globalThis.fetch).not.toHaveBeenCalled();
		expect(
			screen.getByRole("button", { name: /^Add Context$/ }),
		).toBeDisabled();
	});

	it("queues a newly admitted XML file as ready", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		// Browsers report `.xml` as `text/xml`; the vocabulary allowlists
		// `application/xml` and forces the resolution by extension.
		await user.upload(input, [makeFile("sitemap.xml", "text/xml")]);

		const row = await waitFor(() => {
			const found = screen.getByText("sitemap.xml").closest("li");
			if (!found) {
				throw new Error("row not rendered yet");
			}
			return found as HTMLElement;
		});
		expect(within(row).getByRole("status")).toHaveTextContent(/^Ready$/);

		await user.click(screen.getByRole("button", { name: /^Upload$/ }));
		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({ filename: "sitemap.xml" }),
			);
		});
	});

	// ── R3: the helper copy is derived from the same vocabulary as `accept` ──
	it("advertises exactly the formats the accept attribute carries, with their size limits", async () => {
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		expect(input.accept).toBe(CONTEXT_UPLOAD_ACCEPT_ATTR);

		const helper = screen.getByText(/MB maximum/i);
		const advertised = CONTEXT_UPLOAD_ACCEPT_ATTR.split(",").map((ext) =>
			ext.replace(/^\./, "").toUpperCase(),
		);
		for (const label of CONTEXT_UPLOAD_FORMAT_LABELS) {
			// Every canonical label the vocabulary exposes is both advertised by
			// `accept` and named in the visible copy.
			expect(advertised).toContain(label);
			expect(helper).toHaveTextContent(label);
		}

		// Both size buckets survive the derivation.
		expect(helper).toHaveTextContent(/20MB maximum/);
		expect(helper).toHaveTextContent(/10MB maximum/);

		// And the old hand-written list is gone — it named six formats while
		// the surface accepted sixteen.
		expect(helper.textContent).not.toMatch(/images and spreadsheets/i);
	});

	// ── R20: the refusal reaches assistive technology ──
	it("announces a queue-time refusal in a live region and leaves the row removable", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// The region is mounted before anything is picked — a screen reader
		// announces updates to an existing live region, not inserted nodes.
		const announcer = screen.getByTestId("context-upload-announcer");
		expect(announcer).toHaveAttribute("aria-live", "polite");
		expect(announcer).toBeEmptyDOMElement();

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile(
				"deck.pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			),
		]);

		await waitFor(() => {
			expect(announcer).toHaveTextContent("deck.pptx");
		});
		expect(announcer).toHaveTextContent(
			"application/vnd.openxmlformats-officedocument.presentationml.presentation",
		);
		expect(announcer).toHaveTextContent(
			CONTEXT_UPLOAD_FORMAT_LABELS.join(", "),
		);

		// R19 — the refusal persists as a row the user can remove, not a
		// transient message.
		expect(
			screen.getByRole("button", { name: "Remove deck.pptx" }),
		).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Remove deck.pptx" }),
		);
		await waitFor(() => {
			expect(screen.queryByText("deck.pptx")).not.toBeInTheDocument();
		});
	});

	// R20 covers *every* queue-time refusal, not only the type gate. An oversize
	// file inserts an already-failed row the same way, so it needs the same
	// announcement — this went unannounced at first precisely because no test
	// asked for it, while the type gate right beside it was covered.
	it("announces an oversize refusal too, not only an unsupported type", async () => {
		const user = userEvent.setup({ applyAccept: false });
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const announcer = screen.getByTestId("context-upload-announcer");
		expect(announcer).toBeEmptyDOMElement();

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		// An admitted type, over its category's ceiling.
		await user.upload(input, [
			makeFile("huge.pdf", "application/pdf", 21 * 1024 * 1024),
		]);

		await waitFor(() => {
			expect(announcer).toHaveTextContent("huge.pdf");
		});
		expect(announcer).toHaveTextContent(/too large/i);
	});

	it("queues an untyped document dropped with no browser type", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [makeFile("spec.docx", "")]);

		await waitFor(() => {
			expect(screen.getByText("spec.docx")).toBeInTheDocument();
		});
		expect(screen.queryByText(/^Failed$/)).not.toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: /^Upload$/ }));
		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledWith(
				expect.objectContaining({ filename: "spec.docx" }),
			);
		});
	});

	// ── (c) all-success batch closes the dialog + invalidates the contexts query ──
	it("invalidates contexts query and closes the dialog after a successful batch", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		const f1 = makeFile("a.pdf", "application/pdf");
		const f2 = makeFile("b.pdf", "application/pdf");
		await user.upload(input, [f1, f2]);

		await waitFor(() => {
			expect(screen.getByText("a.pdf")).toBeInTheDocument();
			expect(screen.getByText("b.pdf")).toBeInTheDocument();
		});

		// "Upload 2 files" copy.
		await user.click(
			screen.getByRole("button", { name: /Upload 2 files/i }),
		);

		await waitFor(() => {
			expect(createUploadUrlMock).toHaveBeenCalledTimes(2);
			expect(processFileMock).toHaveBeenCalledTimes(2);
		});

		// Dialog auto-closes on terminal-all-resolved (mirrors single-file's
		// `invalidateAndClose()` per spec §7.1 last bullet).
		await waitFor(() => {
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});

		// `projects.contexts.list` query was invalidated so the inline pending
		// cards (Group 8) refresh.
		expect(
			invalidateQueriesMock.mock.calls.some((args) => {
				const arg = args[0] as { queryKey?: unknown[] };
				return (
					Array.isArray(arg?.queryKey) &&
					arg.queryKey[0] === "projects.contexts.list"
				);
			}),
		).toBe(true);
	});

	// ── (d) submit-button label switches "Upload" → "Upload N files" ──
	it("switches the submit button label from Upload to Upload N files based on count", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// 0 files → "Add Context" (the disabled empty-queue copy).
		expect(
			screen.getByRole("button", { name: /^Add Context$/ }),
		).toBeInTheDocument();

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		// 1 file → "Upload"
		await user.upload(input, makeFile("one.pdf", "application/pdf"));
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /^Upload$/ }),
			).toBeInTheDocument();
		});

		// Add 2 more → "Upload 3 files"
		await user.upload(input, [
			makeFile("two.pdf", "application/pdf"),
			makeFile("three.pdf", "application/pdf"),
		]);
		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /Upload 3 files/i }),
			).toBeInTheDocument();
		});
	});

	// ── (e) disabled while uploading state present ──
	it("disables the submit button while any row is uploading", async () => {
		const user = userEvent.setup();
		// Hold `createUploadUrl` so we can observe the in-flight state.
		let resolveCreate: (value: {
			signedUploadUrl: string;
			contextId: string;
		}) => void = () => {};
		createUploadUrlMock.mockImplementation(
			() =>
				new Promise((resolve) => {
					resolveCreate = resolve;
				}),
		);

		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, makeFile("doc.pdf", "application/pdf"));

		await waitFor(() => {
			expect(
				screen.getByRole("button", { name: /^Upload$/ }),
			).toBeInTheDocument();
		});

		// Kick off the upload. The button copy flips to "Processing..."
		// (motion-safe spinner) and the button is disabled.
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => {
			const btn = screen.getByRole("button", { name: /Processing/i });
			expect(btn).toBeDisabled();
		});

		// Release the upload so the test cleans up. We don't need to assert
		// on the post-resolve state — that's covered by (c) above.
		resolveCreate({
			signedUploadUrl: "https://example.com/upload",
			contextId: "ctx_late",
		});
	});

	// ── (f) PARTIAL failure branch (H1 fix from 2026-05-23 static review) ──
	// Verifies: when some rows succeed and some fail at runtime, the dialog
	// MUST stay open + show an amber `toast.warning("X uploaded, Y failed …")`
	// so the user can see inline error details and retry. Previously, the
	// dialog auto-closed and a green success toast fired regardless of
	// failure count — hiding the failed rows from the user.
	it("on PARTIAL failure: keeps dialog open + fires amber warning toast (no auto-close)", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		// Make the S3 PUT fail for one specific file: "b.pdf"
		const fetchMock = vi.fn(async (url: string | URL | Request) => {
			const href = typeof url === "string" ? url : (url as Request).url;
			if (/b\.pdf|b%2Epdf/.test(href)) {
				return new Response("Forbidden", { status: 403 });
			}
			return new Response(null, { status: 200 });
		});
		Object.defineProperty(globalThis, "fetch", {
			writable: true,
			configurable: true,
			value: fetchMock,
		});
		// createUploadUrl returns predictable URLs that embed the filename
		createUploadUrlMock.mockImplementation(
			async (input: { filename: string }) => ({
				signedUploadUrl: `https://example.com/upload/${encodeURIComponent(input.filename)}`,
				contextId: `ctx_${input.filename}`,
			}),
		);

		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("a.pdf", "application/pdf"),
			makeFile("b.pdf", "application/pdf"),
			makeFile("c.pdf", "application/pdf"),
		]);

		await waitFor(() => {
			expect(screen.getByText("a.pdf")).toBeInTheDocument();
			expect(screen.getByText("b.pdf")).toBeInTheDocument();
			expect(screen.getByText("c.pdf")).toBeInTheDocument();
		});

		await user.click(
			screen.getByRole("button", { name: /Upload 3 files/i }),
		);

		// Wait for the batch to settle: 2 successes + 1 failure
		await waitFor(() => {
			expect(toastWarningMock).toHaveBeenCalled();
		});

		// Amber warning copy includes the success + unresolved counts.
		//
		// The second half reads "1 not uploaded", not "1 failed": the summary
		// now counts queue-time refusals alongside runtime failures, and a
		// refusal is not a failed attempt the user can retry. Same specificity,
		// new vocabulary — see the refusal-survives-a-sibling test below.
		const warningCall = toastWarningMock.mock.calls[0]?.[0] as string;
		expect(warningCall).toMatch(/2 uploaded/i);
		expect(warningCall).toMatch(/1 not uploaded/i);

		// No green success toast on partial failure
		expect(toastSuccessMock).not.toHaveBeenCalled();
		// No red error toast on partial failure
		expect(toastErrorMock).not.toHaveBeenCalled();

		// Dialog STAYS OPEN — `onOpenChange(false)` MUST NOT have been called.
		// This is the core H2 behavior change.
		expect(onOpenChange).not.toHaveBeenCalledWith(false);

		// Pending-list invalidation STILL fires so the 2 successes surface
		// in the wizard cards even though we kept the dialog open.
		expect(
			invalidateQueriesMock.mock.calls.some((args) => {
				const arg = args[0] as { queryKey?: unknown[] };
				return (
					Array.isArray(arg?.queryKey) &&
					arg.queryKey[0] === "projects.contexts.list"
				);
			}),
		).toBe(true);
	});

	// ── (g) ALL-FAILED branch (H1 fix) ──
	it("on ALL-FAILED: keeps dialog open + fires red error toast (no auto-close)", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();
		Object.defineProperty(globalThis, "fetch", {
			writable: true,
			configurable: true,
			value: vi.fn(
				async () => new Response("Forbidden", { status: 403 }),
			),
		});

		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("x.pdf", "application/pdf"),
			makeFile("y.pdf", "application/pdf"),
		]);

		await waitFor(() => {
			expect(screen.getByText("x.pdf")).toBeInTheDocument();
		});

		await user.click(
			screen.getByRole("button", { name: /Upload 2 files/i }),
		);

		await waitFor(() => {
			expect(toastErrorMock).toHaveBeenCalled();
		});

		// All-failed copy
		const errorCall = toastErrorMock.mock.calls[0]?.[0] as string;
		expect(errorCall).toMatch(/All 2 uploads failed/i);
		expect(toastSuccessMock).not.toHaveBeenCalled();
		expect(toastWarningMock).not.toHaveBeenCalled();

		// Dialog STAYS OPEN
		expect(onOpenChange).not.toHaveBeenCalledWith(false);
	});

	// ── (h) FULL-SUCCESS keeps the original auto-close behavior ──
	// Regression: confirms (c) above wasn't accidentally regressed by the
	// new branching logic. Same test shape as (c) but explicitly asserts
	// `toast.success` fires with the new "N files uploaded" copy.
	it("on FULL-SUCCESS: green success toast + dialog auto-closes (unchanged from before)", async () => {
		const user = userEvent.setup();
		const onOpenChange = vi.fn();

		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("a.pdf", "application/pdf"),
			makeFile("b.pdf", "application/pdf"),
		]);

		await user.click(
			screen.getByRole("button", { name: /Upload 2 files/i }),
		);

		await waitFor(() => {
			expect(toastSuccessMock).toHaveBeenCalled();
		});

		// Green copy includes the count
		const successCall = toastSuccessMock.mock.calls[0]?.[0] as string;
		expect(successCall).toMatch(/2 files uploaded/i);
		expect(toastWarningMock).not.toHaveBeenCalled();
		expect(toastErrorMock).not.toHaveBeenCalled();

		// Dialog auto-closed
		await waitFor(() => {
			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	// ── (i) a refusal must survive a sibling's success ──
	//
	// Queue-time refusals never enter the fan-out, so they never reach
	// `failCount`. The close branch used to read `failCount === 0` alone: a
	// batch of one refused file plus one good upload uploaded the good one,
	// saw no runtime failure, and called `onOpenChange(false)` + `resetForm()`
	// — destroying the refusal row before the user had a chance to read it.
	//
	// The mixed-batch test above (`refuses an unsupported file and queues its
	// supported sibling…`) walks the same path but passes a bare `vi.fn()` it
	// never asserts on, which is exactly why this regressed unnoticed. Here the
	// spy is the point.
	it("keeps the dialog open and the refused row on screen when a sibling upload succeeds", async () => {
		const user = userEvent.setup({ applyAccept: false });
		const onOpenChange = vi.fn();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={onOpenChange}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile(
				"deck.pptx",
				"application/vnd.openxmlformats-officedocument.presentationml.presentation",
			),
			makeFile("brief.pdf", "application/pdf"),
		]);

		await waitFor(() => {
			expect(screen.getByText("deck.pptx")).toBeInTheDocument();
			expect(screen.getByText("brief.pdf")).toBeInTheDocument();
		});

		// One queueable row, so the footer reads the single-file copy.
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		// Settle on whichever terminal toast the batch fires. The pre-fix
		// branch fired `toast.success` here and the fixed one fires
		// `toast.warning`, so waiting on "any toast" makes the assertions
		// below the thing that fails, rather than a timeout.
		await waitFor(() => {
			expect(
				toastSuccessMock.mock.calls.length +
					toastWarningMock.mock.calls.length +
					toastErrorMock.mock.calls.length,
			).toBeGreaterThan(0);
		});

		// The sibling genuinely uploaded — this is the success the close
		// branch used to read as "nothing left for the user to review".
		expect(createUploadUrlMock).toHaveBeenCalledTimes(1);
		expect(createUploadUrlMock).toHaveBeenCalledWith(
			expect.objectContaining({ filename: "brief.pdf" }),
		);
		expect(processFileMock).toHaveBeenCalledTimes(1);

		// The dialog stays open …
		expect(onOpenChange).not.toHaveBeenCalledWith(false);

		// … and the refusal is still listed, still naming its reason. Raw
		// `textContent`, because the reason is one sentence rendered in its own
		// paragraph and `toHaveTextContent` would normalise across the row's
		// other columns.
		const refusedRow = screen
			.getByText("deck.pptx")
			.closest("li") as HTMLElement;
		expect(refusedRow).not.toBeNull();
		expect(within(refusedRow).getByRole("status")).toHaveTextContent(
			/^Failed$/,
		);
		expect(refusedRow.textContent).toContain(
			"deck.pptx is not a supported file type",
		);

		// The completed sibling is still listed too — nothing was reset.
		const completedRow = screen
			.getByText("brief.pdf")
			.closest("li") as HTMLElement;
		expect(within(completedRow).getByRole("status")).toHaveTextContent(
			/^Done$/,
		);

		// And the batch summary counts the refusal among the unresolved rows
		// rather than declaring the batch a clean success.
		expect(toastSuccessMock).not.toHaveBeenCalled();
		expect(toastWarningMock).toHaveBeenCalledWith(
			expect.stringContaining("1 uploaded, 1 not uploaded"),
		);
	});

	// ── Editorial-aesthetic regression on the upgraded File-tab markup ──
	it("contains no banned editorial-aesthetic class fragments on the File tab", async () => {
		const user = userEvent.setup();
		const { container } = wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		// Empty File tab: no banned tokens.
		assertNoBannedTokens(container, "file tab — empty");

		// Add an oversize + a happy file so all pill colors and the failed
		// row appear in the rendered markup.
		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("ok.pdf", "application/pdf"),
			makeFile("big.pdf", "application/pdf", 25 * 1024 * 1024),
		]);
		await waitFor(() => {
			expect(screen.getByText("ok.pdf")).toBeInTheDocument();
			expect(screen.getByText("big.pdf")).toBeInTheDocument();
		});

		assertNoBannedTokens(container, "file tab — queued + failed rows");
	});
	// ── failed rows must still name their file ────────────────────────────
	//
	// The status pill is a flex sibling of the name/size column. When the pill
	// carries the whole error sentence it takes its full content width and the
	// `min-w-0 flex-1` name column collapses, so the row visually loses the
	// filename — exactly what the batch toast tells the user to go and review.
	// Keep the pill a short marker and give the error its own line.
	it("names the failing file and keeps the error out of the status pill", async () => {
		const user = userEvent.setup();
		wrap(
			<ContextUploaderDialog
				projectId="proj_1"
				open
				onOpenChange={vi.fn()}
			/>,
		);

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(input, [
			makeFile("small.pdf", "application/pdf"),
			makeFile("giant.pdf", "application/pdf", 25 * 1024 * 1024),
		]);

		const failedRow = await waitFor(() => {
			const name = screen.getByText("giant.pdf");
			const row = name.closest("li");
			if (!row) {
				throw new Error("failed row not rendered yet");
			}
			return row as HTMLElement;
		});

		// The pill is a short status marker, not a sentence. This is the
		// assertion that bites: putting the error back inside the pill makes
		// its text content grow past "Failed" and fails here.
		const pill = within(failedRow).getByRole("status");
		expect(pill).toHaveTextContent(/^Failed$/);

		// The error copy is still shown to the user — just not in the pill.
		expect(failedRow).toHaveTextContent(/Too large/i);
		const errorNode = within(failedRow).getByText(/Too large/i);
		expect(pill.contains(errorNode)).toBe(false);

		// And the filename is still rendered in the row that names it.
		expect(within(failedRow).getByText("giant.pdf")).toBeInTheDocument();
	});
});
