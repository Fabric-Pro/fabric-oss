/**
 * `AddCompanyContextDialog` — adding to the organization's company context
 * (Fizzy #2719).
 *
 * The File, Link and Text tabs are the project Context tab's shared forms;
 * what this dialog owns is the company adapter behind them. These tests pin
 * that every submit becomes an `organizations.companyContext.*` call for the
 * organization the page was opened for, with `sourceId` translated at the
 * seam, and that the project-only extras (Tag as Document, the readiness
 * category, the integration tabs) are not offered.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
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

const state = vi.hoisted(() => ({
	createUploadUrl: vi.fn(),
	processFile: vi.fn(),
	processLink: vi.fn(),
	createText: vi.fn(),
	getOrganizationProviders: vi.fn(),
	projectCall: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	toastWarning: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			companyContext: {
				// Present so the list's query key can be derived from it.
				list: vi.fn(),
				createUploadUrl: (input: unknown) =>
					state.createUploadUrl(input),
				processFile: (input: unknown) => state.processFile(input),
				processLink: (input: unknown) => state.processLink(input),
				createText: (input: unknown) => state.createText(input),
			},
		},
		// Any project procedure reached from here would be a leak of the
		// project adapter into the company dialog.
		projects: new Proxy(
			{},
			{
				get: () => new Proxy(() => state.projectCall(), {}),
			},
		),
		searchProviders: {
			getOrganizationProviders: (input: unknown) =>
				state.getOrganizationProviders(input),
			getUserProviders: vi.fn(),
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...a: unknown[]) => state.toastSuccess(...a),
		error: (...a: unknown[]) => state.toastError(...a),
		warning: (...a: unknown[]) => state.toastWarning(...a),
	},
}));

import { orpc } from "@shared/lib/orpc-query-utils";
import { AddCompanyContextDialog } from "../AddCompanyContextDialog";
import { companyContextSubmitAdapter } from "../company-context-adapter";

const FIRECRAWL_ROW = {
	id: "sp_1",
	providerName: "firecrawl",
	enabled: true,
	maskedApiKey: "fc-…abcd",
	isDefault: true,
	priority: 0,
};

function renderDialog() {
	const onOpenChange = vi.fn();
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false, refetchOnWindowFocus: false },
			mutations: { retry: false },
		},
	});
	const invalidateSpy = vi.spyOn(queryClient, "invalidateQueries");
	render(
		<QueryClientProvider client={queryClient}>
			<AddCompanyContextDialog
				organizationId="org-1"
				organizationSlug="example-org"
				open
				onOpenChange={onOpenChange}
			/>
		</QueryClientProvider>,
	);
	return { onOpenChange, invalidateSpy };
}

const LIST_KEY = orpc.organizations.companyContext.list.queryKey({
	input: { organizationId: "org-1" },
});

const fetchMock = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	state.getOrganizationProviders.mockResolvedValue([FIRECRAWL_ROW]);
	state.createUploadUrl.mockImplementation(
		async ({ filename }: { filename: string }) => ({
			sourceId: `src-${filename}`,
			signedUploadUrl: `https://storage.example.com/put/${filename}`,
			contentType: "application/pdf",
		}),
	);
	state.processFile.mockResolvedValue({
		sourceId: "src",
		status: "EXTRACTING",
	});
	state.processLink.mockImplementation(async ({ url }: { url: string }) => ({
		sources: [{ url, sourceId: `src-${url}`, status: "EXTRACTING" }],
	}));
	state.createText.mockResolvedValue({
		sourceId: "src-text",
		status: "PENDING",
	});
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

describe("AddCompanyContextDialog — tabs", () => {
	it("offers File, Link and Text only, and no project-only fields", () => {
		renderDialog();

		const tabs = screen.getAllByRole("tab");
		expect(tabs.map((tab) => tab.id)).toEqual([
			"context-tab-file",
			"context-tab-link",
			"context-tab-text",
		]);
		expect(screen.getByRole("tabpanel")).toHaveAttribute(
			"aria-labelledby",
			"context-tab-file",
		);
		expect(
			screen.queryByLabelText(/Tag as Document/i),
		).not.toBeInTheDocument();
		// The copy says where anything added here ends up.
		expect(screen.getByText("description")).toBeInTheDocument();
	});

	it("moves between tabs with the arrow keys", async () => {
		const user = userEvent.setup();
		renderDialog();

		screen.getByRole("tab", { name: "tabs.file" }).focus();
		await user.keyboard("{ArrowRight}");

		const link = screen.getByRole("tab", { name: "tabs.link" });
		expect(link).toHaveAttribute("aria-selected", "true");
		expect(link).toHaveFocus();
		await user.keyboard("{ArrowLeft}{ArrowLeft}");
		expect(screen.getByRole("tab", { name: "tabs.text" })).toHaveFocus();
	});

	it("offers the scheduled refresh cadences but not Live", async () => {
		const user = userEvent.setup();
		renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.link" }));
		await screen.findByTestId("url-source-indexing-with");
		expect(
			screen.getByText("Scheduled refreshes use Temporal."),
		).toBeInTheDocument();

		await user.click(
			screen.getByRole("combobox", { name: "Refresh cadence" }),
		);
		const options = await screen.findAllByRole("option");
		expect(options.map((option) => option.textContent)).toEqual([
			"Once (no auto-refresh)",
			"Daily",
			"Weekly",
			"Monthly",
		]);
	});

	it("refuses a Live link before calling the company procedure", async () => {
		const adapter = companyContextSubmitAdapter("org-1");

		await expect(
			adapter.processLink({
				url: "https://example.com/",
				scope: "SINGLE_PAGE",
				refreshMode: "LIVE",
			}),
		).rejects.toThrow("Live refresh is not available for company context");
		expect(state.processLink).not.toHaveBeenCalled();
	});
});

describe("AddCompanyContextDialog — submits through the company procedures", () => {
	it("uploads a file: reserve, PUT, then process, for this organization", async () => {
		const user = userEvent.setup();
		const { onOpenChange, invalidateSpy } = renderDialog();

		const input = document.getElementById(
			"context-file-input",
		) as HTMLInputElement;
		await user.upload(
			input,
			new File([new Uint8Array(2048)], "case-study.pdf", {
				type: "application/pdf",
			}),
		);
		await user.click(screen.getByRole("button", { name: /^Upload$/ }));

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(state.createUploadUrl).toHaveBeenCalledWith({
			organizationId: "org-1",
			filename: "case-study.pdf",
			mimeType: "application/pdf",
			size: 2048,
		});
		expect(fetchMock).toHaveBeenCalledWith(
			"https://storage.example.com/put/case-study.pdf",
			expect.objectContaining({
				method: "PUT",
				headers: { "Content-Type": "application/pdf" },
			}),
		);
		expect(state.processFile).toHaveBeenCalledWith({
			organizationId: "org-1",
			sourceId: "src-case-study.pdf",
		});
		expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY });
		expect(state.projectCall).not.toHaveBeenCalled();
	});

	it("adds pasted text", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.text" }));
		await user.type(screen.getByLabelText("Title"), "Positioning");
		await user.type(
			screen.getByLabelText("Content"),
			"We deliver warehouse software for mid-size distributors.",
		);
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(state.createText).toHaveBeenCalledWith({
			organizationId: "org-1",
			title: "Positioning",
			content: "We deliver warehouse software for mid-size distributors.",
		});
	});

	it("adds one website with its type label and no readiness category", async () => {
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.link" }));
		await screen.findByTestId("url-source-indexing-with");
		expect(
			screen.queryByLabelText(/knowledge base source category/i),
		).not.toBeInTheDocument();

		await user.type(screen.getByLabelText("URL"), "https://example.com/");
		await user.type(
			screen.getByLabelText("sourceDetails.typeLabelOptional"),
			"Company website",
		);
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(state.processLink).toHaveBeenCalledWith({
			organizationId: "org-1",
			url: "https://example.com/",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
			sourceType: "Company website",
		});
		expect(state.getOrganizationProviders).toHaveBeenCalledWith({
			organizationId: "org-1",
		});
	});

	it("adds a bulk list of URLs, one company source each", async () => {
		const user = userEvent.setup();
		const { invalidateSpy } = renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.link" }));
		await screen.findByTestId("url-source-indexing-with");
		await user.click(screen.getByRole("tab", { name: /Multiple URLs/i }));
		const textarea = await screen.findByLabelText(/URLs \(one per line\)/i);
		await user.click(textarea);
		await user.paste(
			["https://example.com/about", "https://example.com/customers"].join(
				"\n",
			),
		);
		await user.click(screen.getByRole("button", { name: /^Add 2 URLs$/ }));

		await waitFor(() => expect(state.processLink).toHaveBeenCalledTimes(2));
		expect(state.processLink).toHaveBeenCalledWith({
			organizationId: "org-1",
			url: "https://example.com/about",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
		});
		expect(state.processLink).toHaveBeenCalledWith({
			organizationId: "org-1",
			url: "https://example.com/customers",
			scope: "SINGLE_PAGE",
			refreshMode: "ONCE",
		});
		await waitFor(() =>
			expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: LIST_KEY }),
		);
	});

	it("adds a website whose refresh could not be scheduled, and warns once per organization", async () => {
		const user = userEvent.setup();
		const scheduleWarning = {
			code: "REFRESH_SCHEDULE_NOT_CREATED",
			message:
				"The website is being crawled, but its automatic refresh could not be scheduled. Re-sync the website to try again.",
		};
		state.processLink.mockImplementation(
			async ({ url }: { url: string }) => ({
				sources: [
					{
						url,
						sourceId: `src-${url}`,
						status: "EXTRACTING",
						scheduleWarning,
					},
				],
			}),
		);
		const { onOpenChange } = renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.link" }));
		await screen.findByTestId("url-source-indexing-with");
		await user.type(screen.getByLabelText("URL"), "https://example.com/");
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		// Added: the crawl runs, only its schedule is missing.
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(state.toastError).not.toHaveBeenCalled();
		// A fixed toast id, so a bulk paste that hits this for every URL
		// replaces one toast instead of stacking one per URL.
		expect(state.toastWarning).toHaveBeenCalledTimes(1);
		expect(state.toastWarning).toHaveBeenCalledWith(
			scheduleWarning.message,
			{ id: "company-context-schedule-warning-org-1" },
		);
	});

	it("reports a website whose crawl could not start as not added", async () => {
		const user = userEvent.setup();
		state.processLink.mockResolvedValueOnce({
			sources: [
				{
					url: "https://example.com/",
					sourceId: "src-1",
					status: "FAILED",
					error: "The crawler is unavailable",
				},
			],
		});
		const { onOpenChange } = renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.link" }));
		await screen.findByTestId("url-source-indexing-with");
		await user.type(screen.getByLabelText("URL"), "https://example.com/");
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));

		await waitFor(() =>
			expect(state.toastError).toHaveBeenCalledWith(
				"Failed to add URL source: The crawler is unavailable",
			),
		);
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("does not close on Escape while a submit is in flight", async () => {
		// Deferred so the submit stays "in flight" until we resolve it below —
		// gives Escape a real mid-submit window to fire into.
		let resolveProcessLink: (() => void) | undefined;
		state.processLink.mockImplementationOnce(
			() =>
				new Promise((resolve) => {
					resolveProcessLink = () =>
						resolve({
							sources: [
								{
									url: "https://example.com/",
									sourceId: "src-1",
									status: "EXTRACTING",
								},
							],
						});
				}),
		);
		const user = userEvent.setup();
		const { onOpenChange } = renderDialog();

		await user.click(screen.getByRole("tab", { name: "tabs.link" }));
		await screen.findByTestId("url-source-indexing-with");
		await user.type(screen.getByLabelText("URL"), "https://example.com/");
		await user.click(screen.getByRole("button", { name: /^Add Context$/ }));
		await waitFor(() => expect(state.processLink).toHaveBeenCalledTimes(1));

		await user.keyboard("{Escape}");
		expect(onOpenChange).not.toHaveBeenCalledWith(false);

		resolveProcessLink?.();
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
