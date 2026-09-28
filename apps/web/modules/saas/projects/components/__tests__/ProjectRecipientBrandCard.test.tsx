/**
 * `ProjectRecipientBrandCard` and the `RecipientBrandFields` it shares with
 * the Glossy Align-first panel (Fizzy #2589, R32–R34, AE9): the party a
 * project's Glossy editions are prepared for.
 *
 * Pinned here: a website fetch proposes a logo and colors that the editor
 * confirms by saving; any failure — an answered code or the thrown rate
 * limit — leaves manual entry in place (R34); a manual upload goes through
 * the signed URL; a confirmation that lost the version race reloads and says
 * so; and non-editors read without controls.
 *
 * `@tanstack/react-query` is real rather than mocked, so the fetch, the
 * upload and the confirmation all run through the components' own hooks.
 * `next-intl` is the global key-echo mock, so copy is asserted by key.
 */

import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const api = vi.hoisted(() => ({
	get: vi.fn(),
	fetch: vi.fn(),
	createLogoUploadUrl: vi.fn(),
	update: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			recipientBrand: {
				get: (input: unknown) => api.get(input),
				fetch: (input: unknown) => api.fetch(input),
				createLogoUploadUrl: (input: unknown) =>
					api.createLogoUploadUrl(input),
				update: (input: unknown) => api.update(input),
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => api.toastSuccess(...args),
		error: (...args: unknown[]) => api.toastError(...args),
	},
}));

import { ProjectRecipientBrandCard } from "../ProjectRecipientBrandCard";

const PROJECT_ID = "project-1";
const TOKEN = "t".repeat(32);
const UPLOAD_TOKEN = "u".repeat(32);
const SIGNED_LOGO = "https://storage.example.com/pending/logo.png?sig=1";
const SAVED_LOGO = "https://storage.example.com/current/logo.png?sig=2";

function flags(overrides: Partial<Record<FeatureFlagKey, boolean>>) {
	const values = Object.fromEntries(
		Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>;
	return { ...values, ...overrides };
}

function renderCard({
	gate = true,
	canEdit = true,
}: {
	gate?: boolean;
	canEdit?: boolean;
} = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<FeatureFlagProvider value={flags({ GLOSSY_EDITION: gate })}>
			<QueryClientProvider client={client}>
				<ProjectRecipientBrandCard
					projectId={PROJECT_ID}
					canEdit={canEdit}
				/>
			</QueryClientProvider>
		</FeatureFlagProvider>,
	);
}

function savedBrand(
	version: number,
	brand: Partial<{
		name: string | null;
		website: string | null;
		colors: string[];
		logoUrl: string | null;
	}> = {},
) {
	return {
		version,
		recipientBrand: {
			name: "Example Corp",
			website: "https://example.com",
			colors: ["#1a73e8"],
			logoUrl: SAVED_LOGO,
			updatedAt: new Date("2026-09-01T10:00:00.000Z"),
			...brand,
		},
	};
}

async function fetchFrom(website: string) {
	const user = userEvent.setup();
	const input = await screen.findByLabelText("website");
	await user.clear(input);
	await user.type(input, website);
	await user.click(screen.getByRole("button", { name: "fetch" }));
	return user;
}

const fetchSpy = vi.fn();

beforeEach(() => {
	vi.clearAllMocks();
	api.get.mockResolvedValue({ version: 0, recipientBrand: null });
	api.update.mockResolvedValue({ outcome: "applied", version: 1 });
	fetchSpy.mockResolvedValue({ ok: true });
	vi.stubGlobal("fetch", fetchSpy);
});

afterEach(() => {
	vi.unstubAllGlobals();
});

describe("ProjectRecipientBrandCard", () => {
	it("renders nothing and loads nothing while the Glossy gate is off", () => {
		const { container } = renderCard({ gate: false });

		expect(container).toBeEmptyDOMElement();
		expect(api.get).not.toHaveBeenCalled();
	});

	it("loads the saved recipient brand into the fields", async () => {
		api.get.mockResolvedValue(savedBrand(3));
		renderCard();

		expect(await screen.findByLabelText("name")).toHaveValue(
			"Example Corp",
		);
		expect(screen.getByLabelText("website")).toHaveValue(
			"https://example.com",
		);
		expect(screen.getByRole("textbox", { name: "colorHex" })).toHaveValue(
			"#1a73e8",
		);
		expect(screen.getByRole("img", { name: "logoAlt" })).toHaveAttribute(
			"src",
			SAVED_LOGO,
		);
		expect(api.get).toHaveBeenCalledWith({ projectId: PROJECT_ID });
	});

	it("shows a successful fetch as a proposal and saves it on confirm", async () => {
		api.fetch.mockResolvedValue({
			outcome: "fetched",
			website: "https://example.com",
			token: TOKEN,
			logoUrl: SIGNED_LOGO,
			colors: ["#0d9488", "#1a73e8"],
		});
		renderCard();

		const user = await fetchFrom("example.com/about");

		expect(api.fetch).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			website: "example.com/about",
		});
		// The proposal lands in the fields for review: the fetched logo, its
		// colors, and the website as it will be stored.
		expect(
			await screen.findByRole("img", { name: "logoAlt" }),
		).toHaveAttribute("src", SIGNED_LOGO);
		expect(
			screen
				.getAllByRole("textbox", { name: "colorHex" })
				.map((input) => (input as HTMLInputElement).value),
		).toEqual(["#0d9488", "#1a73e8"]);
		expect(screen.getByLabelText("website")).toHaveValue(
			"https://example.com",
		);
		expect(screen.getByRole("status")).toHaveTextContent("fetched");
		expect(api.update).not.toHaveBeenCalled();

		await user.type(screen.getByLabelText("name"), "Example Corp");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(api.update).toHaveBeenCalledTimes(1));
		expect(api.update).toHaveBeenCalledWith({
			projectId: PROJECT_ID,
			expectedVersion: 0,
			name: "Example Corp",
			website: "https://example.com",
			colors: ["#0d9488", "#1a73e8"],
			logo: { action: "replace", token: TOKEN },
		});
		await waitFor(() =>
			expect(api.toastSuccess).toHaveBeenCalledWith("saved"),
		);
	});

	it("disables Fetch and shows progress while a fetch is outstanding", async () => {
		let settle: (value: unknown) => void = () => {};
		api.fetch.mockReturnValue(
			new Promise((resolve) => {
				settle = resolve;
			}),
		);
		renderCard();

		await fetchFrom("example.com");

		const fetchButton = screen.getByRole("button", { name: "fetch" });
		expect(fetchButton).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent("fetching");
		// A second press while one is outstanding sends nothing.
		fireEvent.click(fetchButton);
		expect(api.fetch).toHaveBeenCalledTimes(1);

		settle({ outcome: "failed", code: "unreachable", colors: [] });
		await waitFor(() => expect(fetchButton).toBeEnabled());
		expect(screen.getByRole("status")).not.toHaveTextContent("fetching");
	});

	it("covers AE9: a failed fetch leaves manual logo and color entry", async () => {
		api.fetch.mockResolvedValue({
			outcome: "failed",
			code: "unreachable",
			colors: [],
		});
		renderCard();

		await fetchFrom("unreachable.example.com");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"failure.unreachable",
		);
		expect(
			screen.getByRole("button", { name: "uploadLogo" }),
		).toBeEnabled();
		expect(screen.getByRole("button", { name: "addColor" })).toBeEnabled();
		expect(screen.getByLabelText("name")).toBeEnabled();
	});

	it("offers colors a failed fetch still found", async () => {
		api.fetch.mockResolvedValue({
			outcome: "failed",
			code: "no_logo",
			colors: ["#eb0600"],
		});
		renderCard();

		await fetchFrom("example.com");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"failure.no_logo",
		);
		expect(screen.getByRole("textbox", { name: "colorHex" })).toHaveValue(
			"#eb0600",
		);
	});

	it("maps the thrown rate limit to manual entry, not an error toast", async () => {
		api.fetch.mockRejectedValue(
			Object.assign(new Error("Too many website lookups"), {
				code: "TOO_MANY_REQUESTS",
			}),
		);
		renderCard();

		await fetchFrom("example.com");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"failure.rateLimited",
		);
		expect(
			screen.getByRole("button", { name: "uploadLogo" }),
		).toBeEnabled();
		expect(api.toastError).not.toHaveBeenCalled();
	});

	it("uploads a logo through the signed URL and confirms its token", async () => {
		api.createLogoUploadUrl.mockResolvedValue({
			token: UPLOAD_TOKEN,
			signedUploadUrl: "https://storage.example.com/upload?sig=3",
			contentType: "image/png",
		});
		renderCard();
		const user = userEvent.setup();

		const file = new File([new Uint8Array(64)], "logo.png", {
			type: "image/png",
		});
		fireEvent.change(await screen.findByLabelText("uploadLogo"), {
			target: { files: [file] },
		});

		await waitFor(() =>
			expect(api.createLogoUploadUrl).toHaveBeenCalledWith({
				projectId: PROJECT_ID,
				contentType: "image/png",
				size: 64,
			}),
		);
		await waitFor(() =>
			expect(fetchSpy).toHaveBeenCalledWith(
				"https://storage.example.com/upload?sig=3",
				expect.objectContaining({
					method: "PUT",
					body: file,
					headers: { "Content-Type": "image/png" },
				}),
			),
		);

		const save = screen.getByRole("button", { name: "save" });
		await waitFor(() => expect(save).toBeEnabled());
		await user.click(save);

		await waitFor(() =>
			expect(api.update).toHaveBeenCalledWith(
				expect.objectContaining({
					logo: { action: "replace", token: UPLOAD_TOKEN },
				}),
			),
		);
	});

	it("refuses an unsupported logo file before asking for an upload URL", async () => {
		renderCard();

		fireEvent.change(await screen.findByLabelText("uploadLogo"), {
			target: {
				files: [
					new File(["<svg/>"], "logo.svg", { type: "image/svg+xml" }),
				],
			},
		});

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"logoError.unsupported",
		);
		expect(api.createLogoUploadUrl).not.toHaveBeenCalled();
	});

	it("rejects an invalid color before submit", async () => {
		api.get.mockResolvedValue(savedBrand(2));
		renderCard();
		const user = userEvent.setup();

		const color = await screen.findByRole("textbox", { name: "colorHex" });
		await user.clear(color);
		await user.type(color, "#xyz");
		await user.click(screen.getByRole("button", { name: "save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("fixColors");
		expect(api.update).not.toHaveBeenCalled();
	});

	it("on a conflict, reloads the current brand and says someone else changed it", async () => {
		api.get
			.mockResolvedValueOnce(savedBrand(1))
			.mockResolvedValue(
				savedBrand(2, { name: "Other Corp", colors: ["#16a34a"] }),
			);
		api.update.mockResolvedValue({ outcome: "conflict" });
		renderCard();
		const user = userEvent.setup();

		const name = await screen.findByLabelText("name");
		await user.clear(name);
		await user.type(name, "My Corp");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(api.update).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedVersion: 1,
					name: "My Corp",
					logo: { action: "keep" },
				}),
			),
		);
		expect(await screen.findByText("conflict")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByLabelText("name")).toHaveValue("Other Corp"),
		);
		expect(screen.getByRole("textbox", { name: "colorHex" })).toHaveValue(
			"#16a34a",
		);
		expect(api.get).toHaveBeenCalledTimes(2);
		expect(api.toastSuccess).not.toHaveBeenCalled();
	});

	it("shows why a confirmation refused the logo and falls back to the saved one", async () => {
		api.get.mockResolvedValue(savedBrand(4));
		api.fetch.mockResolvedValue({
			outcome: "fetched",
			website: "https://example.com",
			token: TOKEN,
			logoUrl: SIGNED_LOGO,
			colors: [],
		});
		api.update.mockResolvedValue({
			outcome: "logoRejected",
			code: "unsupported",
		});
		renderCard();

		const user = await fetchFrom("example.com");
		await screen.findByText("fetched");
		await user.click(screen.getByRole("button", { name: "save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"logoError.unsupported",
		);
		expect(screen.getByRole("img", { name: "logoAlt" })).toHaveAttribute(
			"src",
			SAVED_LOGO,
		);
	});

	describe("an uploaded logo's local preview", () => {
		const BLOB_URL = "blob:https://example.com/uploaded-logo";
		const objectUrls = {
			create: URL.createObjectURL,
			revoke: URL.revokeObjectURL,
		};
		const revokeObjectURL = vi.fn();

		beforeEach(() => {
			URL.createObjectURL = vi.fn(() => BLOB_URL);
			URL.revokeObjectURL = revokeObjectURL;
			api.createLogoUploadUrl.mockResolvedValue({
				token: UPLOAD_TOKEN,
				signedUploadUrl: "https://storage.example.com/upload?sig=3",
				contentType: "image/png",
			});
		});

		afterEach(() => {
			URL.createObjectURL = objectUrls.create;
			URL.revokeObjectURL = objectUrls.revoke;
		});

		async function uploadLogo() {
			fireEvent.change(await screen.findByLabelText("uploadLogo"), {
				target: {
					files: [
						new File([new Uint8Array(64)], "logo.png", {
							type: "image/png",
						}),
					],
				},
			});
			await waitFor(() =>
				expect(
					screen.getByRole("img", { name: "logoAlt" }),
				).toHaveAttribute("src", BLOB_URL),
			);
			expect(revokeObjectURL).not.toHaveBeenCalled();
		}

		it("is released when Discard drops the upload", async () => {
			api.get.mockResolvedValue(savedBrand(2));
			renderCard();
			const user = userEvent.setup();

			await uploadLogo();
			await user.click(screen.getByRole("button", { name: "discard" }));

			expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(BLOB_URL);
			expect(
				screen.getByRole("img", { name: "logoAlt" }),
			).toHaveAttribute("src", SAVED_LOGO);
		});

		it("is released when a save refuses the uploaded logo", async () => {
			api.get.mockResolvedValue(savedBrand(2));
			api.update.mockResolvedValue({
				outcome: "logoRejected",
				code: "unsupported",
			});
			renderCard();
			const user = userEvent.setup();

			await uploadLogo();
			const save = screen.getByRole("button", { name: "save" });
			await waitFor(() => expect(save).toBeEnabled());
			await user.click(save);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"logoError.unsupported",
			);
			expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith(BLOB_URL);
		});
	});

	it("shows a reader the brand without any control that changes it", async () => {
		api.get.mockResolvedValue(savedBrand(2));
		renderCard({ canEdit: false });

		expect(await screen.findByLabelText("name")).toBeDisabled();
		expect(screen.getByLabelText("website")).toBeDisabled();
		expect(
			screen.getByRole("textbox", { name: "colorHex" }),
		).toBeDisabled();
		expect(screen.getByText("readOnly")).toBeInTheDocument();
		for (const name of ["fetch", "uploadLogo", "removeLogo", "save"]) {
			expect(
				screen.queryByRole("button", { name }),
			).not.toBeInTheDocument();
		}
	});

	it("has no axe violations — editable, after a failed fetch, and read-only", async () => {
		api.get.mockResolvedValue(savedBrand(2));
		api.fetch.mockResolvedValue({
			outcome: "failed",
			code: "blocked",
			colors: [],
		});
		const editable = renderCard();
		await screen.findByLabelText("name");
		expect(await axe(editable.container)).toHaveNoViolations();

		await fetchFrom("localhost");
		const alert = await screen.findByRole("alert");
		expect(within(alert).getByText("failure.blocked")).toBeInTheDocument();
		expect(await axe(editable.container)).toHaveNoViolations();
		editable.unmount();

		const readOnly = renderCard({ canEdit: false });
		await screen.findByLabelText("name");
		expect(await axe(readOnly.container)).toHaveNoViolations();
	});
});
