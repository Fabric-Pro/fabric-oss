/**
 * `ProjectRecipientBrandCard` and the `RecipientBrandFields` it shares with
 * the Glossy Align-first panel (Fizzy #2589): the party a project's Glossy
 * editions are prepared for.
 *
 * Pinned here: a website fetch proposes a logo and colors that the editor
 * confirms by saving; any failure — an answered code or the thrown rate
 * limit — leaves manual entry in place; a manual upload goes through the
 * signed URL; a confirmation that lost the version race reloads and says so,
 * while a newer version read in the background never replaces unsaved
 * edits; and non-editors read without controls. Since Fizzy #2946 the server's
 * recipient `canEdit` narrows the project rule (a project guest editor reads
 * with the reason), and the picker and its pre-check use the shared upload
 * vocabulary.
 *
 * `@tanstack/react-query` is real rather than mocked, so the fetch, the
 * upload and the confirmation all run through the components' own hooks.
 * `next-intl` is the global key-echo mock, so copy is asserted by key.
 */

import {
	BRAND_ASSET_MAX_BYTES,
	brandAssetAcceptAttribute,
} from "@repo/utils/brand-assets";
import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
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
	proposalArtifactGate = false,
	canEdit = true,
}: {
	gate?: boolean;
	/** `PROPOSAL_ARTIFACT` (Fizzy #2801), the second gate the card answers to. */
	proposalArtifactGate?: boolean;
	canEdit?: boolean;
} = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	const view = render(
		<FeatureFlagProvider
			value={flags({
				GLOSSY_EDITION: gate,
				PROPOSAL_ARTIFACT: proposalArtifactGate,
			})}
		>
			<QueryClientProvider client={client}>
				<ProjectRecipientBrandCard
					projectId={PROJECT_ID}
					canEdit={canEdit}
				/>
			</QueryClientProvider>
		</FeatureFlagProvider>,
	);
	return { ...view, client };
}

function savedBrand(
	version: number,
	brand: Partial<{
		name: string | null;
		website: string | null;
		colors: string[];
		logoUrl: string | null;
	}> = {},
	canEdit = true,
) {
	return {
		version,
		canEdit,
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
	api.get.mockResolvedValue({
		version: 0,
		canEdit: true,
		recipientBrand: null,
	});
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

	// Fizzy #2801: coordinated Proposals color their visuals from the
	// recipient brand, and its procedures accept either rollout gate, so the
	// card does too.
	it("renders and loads behind the Proposal artifact gate alone", async () => {
		api.get.mockResolvedValue(savedBrand(2));
		renderCard({ gate: false, proposalArtifactGate: true });

		await waitFor(() =>
			expect(screen.getByLabelText("name")).toHaveValue("Example Corp"),
		);
		expect(api.get).toHaveBeenCalledWith({ projectId: PROJECT_ID });
		// No Glossy cover exists for such an organization, so the card says
		// what the brand is used for there instead.
		expect(
			screen.getByText("recipientBrandDescription"),
		).toBeInTheDocument();
		expect(screen.queryByText("description")).not.toBeInTheDocument();
	});

	it("keeps the Glossy description when both gates are on", async () => {
		renderCard({ gate: true, proposalArtifactGate: true });

		expect(await screen.findByText("description")).toBeInTheDocument();
		expect(
			screen.queryByText("recipientBrandDescription"),
		).not.toBeInTheDocument();
	});

	it("can still be saved behind the Proposal artifact gate alone", async () => {
		const user = userEvent.setup();
		renderCard({ gate: false, proposalArtifactGate: true });

		await user.type(await screen.findByLabelText("name"), "Example Corp");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(api.update).toHaveBeenCalledWith(
				expect.objectContaining({
					projectId: PROJECT_ID,
					expectedVersion: 0,
					name: "Example Corp",
				}),
			),
		);
	});

	it("loads the saved recipient brand into the fields", async () => {
		api.get.mockResolvedValue(savedBrand(3));
		renderCard();

		await waitFor(() =>
			expect(screen.getByLabelText("name")).toHaveValue("Example Corp"),
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

	it("a failed fetch leaves manual logo and color entry", async () => {
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

	it("keeps unsaved edits through a newer version read in the background, and meets the conflict on save", async () => {
		api.get
			.mockResolvedValueOnce(savedBrand(1))
			.mockResolvedValue(savedBrand(2, { colors: ["#16a34a"] }));
		api.update.mockResolvedValue({ outcome: "conflict" });
		const { client } = renderCard();
		const user = userEvent.setup();

		const name = await screen.findByLabelText("name");
		await user.clear(name);
		await user.type(name, "My Corp");
		// Someone else confirmed a value meanwhile.
		await act(() =>
			client.invalidateQueries({
				queryKey: ["projectRecipientBrand", PROJECT_ID],
			}),
		);
		await waitFor(() => expect(api.get).toHaveBeenCalledTimes(2));
		expect(screen.getByLabelText("name")).toHaveValue("My Corp");
		expect(screen.getByRole("textbox", { name: "colorHex" })).toHaveValue(
			"#1a73e8",
		);

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(api.update).toHaveBeenCalledWith(
				expect.objectContaining({
					expectedVersion: 1,
					name: "My Corp",
				}),
			),
		);
		expect(await screen.findByText("conflict")).toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByLabelText("name")).toHaveValue("Example Corp"),
		);
		expect(screen.getByRole("textbox", { name: "colorHex" })).toHaveValue(
			"#16a34a",
		);
	});

	it("takes a newer version read in the background while the fields hold no edits", async () => {
		api.get
			.mockResolvedValueOnce(savedBrand(1))
			.mockResolvedValue(savedBrand(2, { name: "Other Corp" }));
		const { client } = renderCard();

		expect(await screen.findByLabelText("name")).toHaveValue(
			"Example Corp",
		);
		await act(() =>
			client.invalidateQueries({
				queryKey: ["projectRecipientBrand", PROJECT_ID],
			}),
		);

		await waitFor(() =>
			expect(screen.getByLabelText("name")).toHaveValue("Other Corp"),
		);
		expect(
			screen.queryByRole("button", { name: "discard" }),
		).not.toBeInTheDocument();
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

	// Fizzy #2946: only organization members write the recipient brand, so a
	// project guest with an editor role reads it, told why, and is never
	// offered a Save the server would refuse.
	it("shows a project guest editor the brand read-only with the reason", async () => {
		api.get.mockResolvedValue(savedBrand(2, {}, false));
		renderCard({ canEdit: true });

		expect(await screen.findByLabelText("name")).toBeDisabled();
		expect(screen.getByLabelText("website")).toBeDisabled();
		expect(screen.getByText("membersOnly")).toBeInTheDocument();
		// The project-editor line is for someone who cannot edit the project.
		expect(screen.queryByText("readOnly")).not.toBeInTheDocument();
		for (const name of ["fetch", "uploadLogo", "removeLogo", "save"]) {
			expect(
				screen.queryByRole("button", { name }),
			).not.toBeInTheDocument();
		}
		expect(api.update).not.toHaveBeenCalled();
	});

	it("gives a non-editor the project line, not the members-only one", async () => {
		api.get.mockResolvedValue(savedBrand(2, {}, false));
		renderCard({ canEdit: false });

		expect(await screen.findByText("readOnly")).toBeInTheDocument();
		expect(screen.queryByText("membersOnly")).not.toBeInTheDocument();
	});

	describe("the shared upload vocabulary (Fizzy #2946)", () => {
		it("offers the picker exactly the logo types and extensions the server signs", async () => {
			renderCard();

			expect(await screen.findByLabelText("uploadLogo")).toHaveAttribute(
				"accept",
				brandAssetAcceptAttribute("logo"),
			);
		});

		it("refuses a logo over the size limit before asking for an upload URL", async () => {
			renderCard();

			const file = new File([new Uint8Array(8)], "logo.png", {
				type: "image/png",
			});
			Object.defineProperty(file, "size", {
				value: BRAND_ASSET_MAX_BYTES.logo + 1,
			});
			fireEvent.change(await screen.findByLabelText("uploadLogo"), {
				target: { files: [file] },
			});

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"logoError.too_large",
			);
			expect(api.createLogoUploadUrl).not.toHaveBeenCalled();
		});

		it("signs a file that carries no type for the type its name says", async () => {
			api.createLogoUploadUrl.mockResolvedValue({
				token: UPLOAD_TOKEN,
				signedUploadUrl: "https://storage.example.com/upload?sig=3",
				contentType: "image/webp",
			});
			renderCard();

			fireEvent.change(await screen.findByLabelText("uploadLogo"), {
				target: {
					files: [new File([new Uint8Array(32)], "logo.webp")],
				},
			});

			await waitFor(() =>
				expect(api.createLogoUploadUrl).toHaveBeenCalledWith({
					projectId: PROJECT_ID,
					contentType: "image/webp",
					size: 32,
				}),
			);
		});
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
