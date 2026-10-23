/**
 * `OrganizationBrandKitForm` — the organization Brand kit (Fizzy #2589,
 * extended in Fizzy #2946): the proposer brand (primary and accent colors,
 * fonts with optional files, cover image, website with its fetch status) and
 * the brand guidance, editable by admins and owners, read-only for everyone
 * else, and absent while both rollout gates are off.
 *
 * `@tanstack/react-query` is real rather than mocked, so the load, the
 * uploads, the save, the site fetch and the polling all run through the
 * component's own hooks. `next-intl` is the global key-echo mock, so copy is
 * asserted by key.
 */

import { ORPCError } from "@orpc/client";
import { brandAssetAcceptAttribute } from "@repo/utils/brand-assets";
import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { BRAND_FETCH_POLL_MS } from "@saas/shared/lib/brand-fetch-polling";
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
import {
	afterEach,
	beforeEach,
	describe,
	expect,
	it,
	type MockInstance,
	onTestFinished,
	vi,
} from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const state = vi.hoisted(() => ({
	role: "admin" as string | null,
	getMock: vi.fn(),
	updateMock: vi.fn(),
	uploadUrlMock: vi.fn(),
	fetchSiteMock: vi.fn(),
	brandColorGetMock: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			brandKit: {
				get: (input: unknown) => state.getMock(input),
				update: (input: unknown) => state.updateMock(input),
				createAssetUploadUrl: (input: unknown) =>
					state.uploadUrlMock(input),
				fetchSite: (input: unknown) => state.fetchSiteMock(input),
			},
			brandColor: {
				get: (input: unknown) => state.brandColorGetMock(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: {
			id: "org-1",
			name: "Example Org",
			// The named dashboard theme color: Glossy's alone, never the
			// kit's primary.
			metadata: { brandColor: "violet" },
		},
		activeOrganizationUserRole: state.role,
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => state.toastSuccess(...args),
		error: (...args: unknown[]) => state.toastError(...args),
	},
}));

import { OrganizationBrandKitForm } from "../OrganizationBrandKitForm";

const KIB = 1024;
const MIB = 1024 * 1024;
const UPLOAD_URL = "https://storage.example.com/upload?sig=1";
const HERO_URL = "https://storage.example.com/hero.png?sig=read";
const BRAND_KIT_KEY = ["organizationBrandKit", "org-1"];

function flags(overrides: Partial<Record<FeatureFlagKey, boolean>>) {
	const values = Object.fromEntries(
		Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>;
	return { ...values, ...overrides };
}

function renderForm({
	glossy = true,
	proposal = false,
}: {
	glossy?: boolean;
	proposal?: boolean;
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
				GLOSSY_EDITION: glossy,
				PROPOSAL_ARTIFACT: proposal,
			})}
		>
			<QueryClientProvider client={client}>
				<OrganizationBrandKitForm />
			</QueryClientProvider>
		</FeatureFlagProvider>,
	);
	return { ...view, client };
}

type Kit = {
	accentColors: string[];
	guidance: string | null;
	updatedAt: Date | null;
	primaryColor: string | null;
	displayFontFamily: string | null;
	bodyFontFamily: string | null;
	hasDisplayFontFile: boolean;
	hasBodyFontFile: boolean;
	heroUrl: string | null;
	website: string | null;
	version: number;
	siteFetch: null | {
		website: string;
		status: "RUNNING" | "SUCCEEDED" | "FAILED";
		failureCode: string | null;
		requestedAt: Date;
		fetchedAt: Date | null;
		resultWebsite: string | null;
		primaryColor: string | null;
		accentColors: string[];
	};
};

function savedKit(overrides: Partial<Kit> = {}): Kit {
	return {
		accentColors: ["#1a73e8"],
		guidance: "Plain, confident language.",
		updatedAt: new Date("2026-09-01T10:00:00.000Z"),
		primaryColor: null,
		displayFontFamily: "Example Serif",
		bodyFontFamily: null,
		hasDisplayFontFile: true,
		hasBodyFontFile: false,
		heroUrl: HERO_URL,
		website: "https://example.com",
		version: 4,
		siteFetch: null,
		...overrides,
	};
}

/** Every field the form sends, as the untouched saved kit would send it. */
function unchangedPayload(overrides: Record<string, unknown> = {}) {
	return {
		organizationId: "org-1",
		expectedVersion: 4,
		accentColors: ["#1a73e8"],
		guidance: "Plain, confident language.",
		primaryColor: null,
		displayFontFamily: "Example Serif",
		bodyFontFamily: null,
		website: "https://example.com",
		assets: {
			hero: { action: "keep" },
			displayFont: { action: "keep" },
			bodyFont: { action: "keep" },
		},
		...overrides,
	};
}

function fileOf(name: string, type: string, size: number): File {
	const file = new File([new Uint8Array(16)], name, { type });
	// The caps are checked against the declared size; no need to allocate it.
	Object.defineProperty(file, "size", { value: size });
	return file;
}

function pick(label: string, file: File) {
	fireEvent.change(screen.getByLabelText(label), {
		target: { files: [file] },
	});
}

let fetchSpy: MockInstance<typeof fetch>;

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "admin";
	state.getMock.mockResolvedValue({ brandKit: savedKit() });
	state.updateMock.mockImplementation(
		async (input: {
			accentColors: string[];
			guidance: string | null;
			primaryColor: string | null;
			displayFontFamily: string | null;
			bodyFontFamily: string | null;
			website: string | null;
		}) => ({
			outcome: "applied",
			brandKit: savedKit({
				accentColors: input.accentColors,
				guidance: input.guidance,
				primaryColor: input.primaryColor,
				displayFontFamily: input.displayFontFamily,
				bodyFontFamily: input.bodyFontFamily,
				website: input.website,
				updatedAt: new Date("2026-09-02T10:00:00.000Z"),
				version: 5,
			}),
		}),
	);
	state.uploadUrlMock.mockResolvedValue({
		token: "upload-token-1",
		signedUploadUrl: UPLOAD_URL,
	});
	state.fetchSiteMock.mockResolvedValue({ attempt: null });
	fetchSpy = vi
		.spyOn(globalThis, "fetch")
		.mockResolvedValue(new Response(null, { status: 200 }));
});

afterEach(() => {
	fetchSpy.mockRestore();
	vi.useRealTimers();
});

describe("OrganizationBrandKitForm", () => {
	describe("rollout gate", () => {
		it.each([
			{ name: "Glossy only", glossy: true, proposal: false },
			{ name: "Proposal artifact only", glossy: false, proposal: true },
		])("shows and loads the kit with $name on", async (gates) => {
			renderForm(gates);

			expect(
				await screen.findByRole("textbox", { name: "accentHex" }),
			).toHaveValue("#1a73e8");
			expect(state.getMock).toHaveBeenCalledWith({
				organizationId: "org-1",
			});
		});

		it("renders nothing and loads nothing while both gates are off", () => {
			const { container } = renderForm({
				glossy: false,
				proposal: false,
			});

			expect(container).toBeEmptyDOMElement();
			expect(state.getMock).not.toHaveBeenCalled();
		});
	});

	it("loads the saved kit into every field", async () => {
		renderForm();

		expect(
			await screen.findByRole("textbox", { name: "accentHex" }),
		).toHaveValue("#1a73e8");
		expect(screen.getByLabelText("displayFontFamily")).toHaveValue(
			"Example Serif",
		);
		expect(screen.getByLabelText("bodyFontFamily")).toHaveValue("");
		expect(screen.getByLabelText("website")).toHaveValue(
			"https://example.com",
		);
		expect(screen.getByLabelText("guidance")).toHaveValue(
			"Plain, confident language.",
		);
		expect(screen.getByRole("img", { name: "heroAlt" })).toHaveAttribute(
			"src",
			HERO_URL,
		);
		// A stored display font file, no body font file.
		expect(screen.getByText("fontFileStored")).toBeInTheDocument();
		expect(screen.getByText("noFontFile")).toBeInTheDocument();
		expect(screen.getByText("siteFetch.notFetched")).toBeInTheDocument();
		// The accept attributes are the shared vocabulary's.
		expect(screen.getByLabelText("uploadHero")).toHaveAttribute(
			"accept",
			brandAssetAcceptAttribute("hero"),
		);
		expect(screen.getByLabelText("uploadDisplayFont")).toHaveAttribute(
			"accept",
			brandAssetAcceptAttribute("font"),
		);
	});

	it("rejects an invalid hex before submit", async () => {
		const user = userEvent.setup();
		renderForm();

		const accent = await screen.findByRole("textbox", {
			name: "accentHex",
		});
		await user.clear(accent);
		await user.type(accent, "#12345g");

		// Flagged as typed, and wired to the field for assistive tech.
		expect(accent).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText("invalidColor")).toBeInTheDocument();

		await user.click(screen.getByRole("button", { name: "save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("fixColors");
		expect(state.updateMock).not.toHaveBeenCalled();
	});

	it("offers no more than three accents and one primary", async () => {
		const user = userEvent.setup();
		renderForm();

		await screen.findByRole("textbox", { name: "accentHex" });
		await user.click(screen.getByRole("button", { name: "addAccent" }));
		await user.click(screen.getByRole("button", { name: "addAccent" }));
		await user.click(screen.getByRole("button", { name: "addPrimary" }));

		expect(
			screen.getAllByRole("textbox", { name: "accentHex" }),
		).toHaveLength(3);
		expect(
			screen.queryByRole("button", { name: "addAccent" }),
		).not.toBeInTheDocument();
		expect(
			screen.getAllByRole("textbox", { name: "primaryHex" }),
		).toHaveLength(1);
		expect(
			screen.queryByRole("button", { name: "addPrimary" }),
		).not.toBeInTheDocument();
	});

	it("saves every edited field with the version it read and keep for untouched files", async () => {
		const user = userEvent.setup();
		renderForm();

		const accent = await screen.findByRole("textbox", {
			name: "accentHex",
		});
		await user.click(screen.getByRole("button", { name: "addPrimary" }));
		// Short form and upper case are accepted and normalized for the wire.
		await user.type(
			screen.getByRole("textbox", { name: "primaryHex" }),
			"#0A2540",
		);
		await user.clear(accent);
		await user.type(accent, "#ABC");
		await user.click(screen.getByRole("button", { name: "addAccent" }));
		const accents = screen.getAllByRole("textbox", { name: "accentHex" });
		await user.type(accents[1] as HTMLElement, "#0d9488");
		const display = screen.getByLabelText("displayFontFamily");
		await user.clear(display);
		await user.type(display, "Example  Display");
		await user.type(
			screen.getByLabelText("bodyFontFamily"),
			"Example Sans",
		);
		const guidance = screen.getByLabelText("guidance");
		await user.clear(guidance);
		await user.type(guidance, "Short sentences.");

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(state.updateMock).toHaveBeenCalledTimes(1));
		expect(state.updateMock).toHaveBeenCalledWith(
			unchangedPayload({
				primaryColor: "#0a2540",
				accentColors: ["#aabbcc", "#0d9488"],
				// Whitespace collapsed the way the theme writes it.
				displayFontFamily: "Example Display",
				bodyFontFamily: "Example Sans",
				guidance: "Short sentences.",
			}),
		);
		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith("saved"),
		);
		// The website did not change, so nothing is fetched.
		expect(state.fetchSiteMock).not.toHaveBeenCalled();
	});

	it("sends null for cleared fields and remove for a removed file", async () => {
		const user = userEvent.setup();
		renderForm();

		await screen.findByRole("textbox", { name: "accentHex" });
		await user.clear(screen.getByLabelText("guidance"));
		await user.clear(screen.getByLabelText("displayFontFamily"));
		await user.click(
			screen.getByRole("button", { name: "removeDisplayFont" }),
		);
		await user.clear(screen.getByLabelText("website"));
		await user.click(screen.getByRole("button", { name: "removeAccent" }));

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() =>
			expect(state.updateMock).toHaveBeenCalledWith(
				unchangedPayload({
					accentColors: [],
					guidance: null,
					displayFontFamily: null,
					website: null,
					assets: {
						hero: { action: "keep" },
						displayFont: { action: "remove" },
						bodyFont: { action: "keep" },
					},
				}),
			),
		);
		expect(state.fetchSiteMock).not.toHaveBeenCalled();
	});

	it("refuses a family name the theme cannot write, or a font file without one", async () => {
		const user = userEvent.setup();
		renderForm();

		await screen.findByRole("textbox", { name: "accentHex" });
		const display = screen.getByLabelText("displayFontFamily");
		await user.clear(display);
		await user.type(screen.getByLabelText("bodyFontFamily"), "Bad;Font");
		await user.click(screen.getByRole("button", { name: "save" }));

		expect(display).toHaveAttribute("aria-invalid", "true");
		expect(screen.getByText("fontFamilyRequired")).toBeInTheDocument();
		expect(screen.getByLabelText("bodyFontFamily")).toHaveAttribute(
			"aria-invalid",
			"true",
		);
		expect(screen.getByText("fontFamilyInvalid")).toBeInTheDocument();
		expect(screen.getByRole("alert")).toHaveTextContent("fixFields");
		expect(state.updateMock).not.toHaveBeenCalled();
	});

	it("never sends the organization's named theme color as the primary", async () => {
		const user = userEvent.setup();
		renderForm({ glossy: true, proposal: true });

		await screen.findByRole("textbox", { name: "accentHex" });
		// Nothing pre-fills the primary.
		expect(
			screen.queryByRole("textbox", { name: "primaryHex" }),
		).not.toBeInTheDocument();
		const guidance = screen.getByLabelText("guidance");
		await user.type(guidance, " More.");
		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(state.updateMock).toHaveBeenCalledTimes(1));
		expect(state.updateMock.mock.calls[0]?.[0]).toMatchObject({
			primaryColor: null,
		});
		expect(JSON.stringify(state.updateMock.mock.calls[0])).not.toContain(
			"violet",
		);
		expect(state.brandColorGetMock).not.toHaveBeenCalled();
	});

	it("shows a member the whole kit read-only, with no save, upload or fetch", async () => {
		state.role = "member";
		state.getMock.mockResolvedValue({
			brandKit: savedKit({ primaryColor: "#0a2540" }),
		});
		renderForm();

		expect(
			await screen.findByRole("textbox", { name: "accentHex" }),
		).toBeDisabled();
		expect(
			screen.getByRole("textbox", { name: "primaryHex" }),
		).toBeDisabled();
		expect(screen.getByLabelText("displayFontFamily")).toBeDisabled();
		expect(screen.getByLabelText("bodyFontFamily")).toBeDisabled();
		expect(screen.getByLabelText("website")).toBeDisabled();
		expect(screen.getByLabelText("guidance")).toBeDisabled();
		expect(screen.getByText("readOnly")).toBeInTheDocument();
		// The stored files are still shown.
		expect(screen.getByRole("img", { name: "heroAlt" })).toHaveAttribute(
			"src",
			HERO_URL,
		);
		expect(screen.getByText("fontFileStored")).toBeInTheDocument();
		for (const name of [
			"save",
			"addAccent",
			"removeAccent",
			"removePrimary",
			"uploadHero",
			"removeHero",
			"uploadDisplayFont",
			"removeDisplayFont",
			"uploadBodyFont",
			"siteFetch.fetchAgain",
		]) {
			expect(
				screen.queryByRole("button", { name }),
			).not.toBeInTheDocument();
		}
		expect(screen.queryByLabelText("uploadHero")).not.toBeInTheDocument();
	});

	describe("files", () => {
		it("uploads a woff2 through the signed URL and saves its token as replace, holding Save meanwhile", async () => {
			let finishSigning: (value: unknown) => void = () => {};
			state.uploadUrlMock.mockReturnValue(
				new Promise((resolve) => {
					finishSigning = resolve;
				}),
			);
			const user = userEvent.setup();
			renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			await user.type(
				screen.getByLabelText("bodyFontFamily"),
				"Example Sans",
			);
			const font = fileOf("example-sans.woff2", "", 40 * KIB);
			pick("uploadBodyFont", font);

			// Uploading: announced, and Save held.
			expect(
				await screen.findByText("uploading", { selector: "output" }),
			).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "save" })).toBeDisabled();
			// A file without a type is admitted by its extension.
			expect(state.uploadUrlMock).toHaveBeenCalledWith({
				organizationId: "org-1",
				kind: "bodyFont",
				contentType: "font/woff2",
				contentLength: 40 * KIB,
			});

			finishSigning({
				token: "font-token-1",
				signedUploadUrl: UPLOAD_URL,
			});

			await waitFor(() =>
				expect(fetchSpy).toHaveBeenCalledWith(
					UPLOAD_URL,
					expect.objectContaining({
						method: "PUT",
						body: font,
						headers: { "Content-Type": "font/woff2" },
					}),
				),
			);
			// Ready: the file's name, and Remove.
			expect(
				await screen.findByText("example-sans.woff2"),
			).toBeInTheDocument();
			expect(
				screen.getByRole("button", { name: "removeBodyFont" }),
			).toBeInTheDocument();

			const save = screen.getByRole("button", { name: "save" });
			await waitFor(() => expect(save).toBeEnabled());
			await user.click(save);

			await waitFor(() =>
				expect(state.updateMock).toHaveBeenCalledWith(
					unchangedPayload({
						bodyFontFamily: "Example Sans",
						assets: {
							hero: { action: "keep" },
							displayFont: { action: "keep" },
							bodyFont: {
								action: "replace",
								token: "font-token-1",
							},
						},
					}),
				),
			);
		});

		it.each([
			{
				name: "an .otf font",
				label: "uploadDisplayFont",
				file: () => fileOf("example.otf", "font/otf", 40 * KIB),
				message: "fontError.unsupported",
			},
			{
				name: "a 600 KiB font",
				label: "uploadBodyFont",
				file: () => fileOf("example.woff2", "font/woff2", 600 * KIB),
				message: "fontError.too_large",
			},
			{
				name: "a 12 MiB hero",
				label: "uploadHero",
				file: () => fileOf("cover.png", "image/png", 12 * MIB),
				message: "heroError.too_large",
			},
			{
				name: "an SVG hero",
				label: "uploadHero",
				file: () => fileOf("cover.svg", "image/svg+xml", 4 * KIB),
				message: "heroError.unsupported",
			},
		])(
			"refuses $name in the browser, before an upload is signed",
			async ({ label, file, message }) => {
				renderForm();
				await screen.findByRole("textbox", { name: "accentHex" });

				pick(label, file());

				expect(await screen.findByRole("alert")).toHaveTextContent(
					message,
				);
				expect(state.uploadUrlMock).not.toHaveBeenCalled();
				expect(fetchSpy).not.toHaveBeenCalled();
			},
		);

		it("shows the slot's message, with the same code copy, when the save refuses an upload", async () => {
			const user = userEvent.setup();
			state.updateMock.mockResolvedValueOnce({
				outcome: "assetRejected",
				kind: "hero",
				code: "unsupported",
			});
			renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			pick("uploadHero", fileOf("cover.png", "image/png", 200 * KIB));
			await screen.findByText("uploaded", { selector: "output" });

			await user.click(screen.getByRole("button", { name: "save" }));

			await waitFor(() =>
				expect(state.updateMock).toHaveBeenCalledWith(
					expect.objectContaining({
						assets: expect.objectContaining({
							hero: {
								action: "replace",
								token: "upload-token-1",
							},
						}),
					}),
				),
			);
			expect(await screen.findByRole("alert")).toHaveTextContent(
				"heroError.unsupported",
			);
			// The spent token is dropped: the stored hero shows again.
			expect(
				screen.getByRole("img", { name: "heroAlt" }),
			).toHaveAttribute("src", HERO_URL);
			expect(state.toastSuccess).not.toHaveBeenCalled();
		});

		it("shows the signer's refusal with the same code copy", async () => {
			state.uploadUrlMock.mockRejectedValue(
				new ORPCError("BAD_REQUEST", { data: { code: "too_large" } }),
			);
			renderForm();
			await screen.findByRole("textbox", { name: "accentHex" });

			pick(
				"uploadDisplayFont",
				fileOf("example.ttf", "font/ttf", 40 * KIB),
			);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"fontError.too_large",
			);
			expect(fetchSpy).not.toHaveBeenCalled();
		});

		it("gives up on a file the storage never answers, with the upload copy, and releases Save", async () => {
			const timeout = new AbortController();
			const timeoutSpy = vi
				.spyOn(AbortSignal, "timeout")
				.mockReturnValue(timeout.signal);
			onTestFinished(() => timeoutSpy.mockRestore());
			// The storage holds the request open until the signal gives up.
			fetchSpy.mockImplementation(
				(_url, init) =>
					new Promise((_resolve, reject) => {
						init?.signal?.addEventListener("abort", () =>
							reject(init.signal?.reason),
						);
					}),
			);
			const user = userEvent.setup();
			renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			await user.type(
				screen.getByLabelText("bodyFontFamily"),
				"Example Sans",
			);
			pick(
				"uploadBodyFont",
				fileOf("example-sans.woff2", "font/woff2", 40 * KIB),
			);

			await waitFor(() =>
				expect(fetchSpy).toHaveBeenCalledWith(
					UPLOAD_URL,
					expect.objectContaining({ signal: timeout.signal }),
				),
			);
			expect(timeoutSpy).toHaveBeenCalledWith(60_000);
			expect(screen.getByRole("button", { name: "save" })).toBeDisabled();

			timeout.abort(
				new DOMException("The operation timed out.", "TimeoutError"),
			);

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"fontError.uploadFailed",
			);
			await waitFor(() =>
				expect(
					screen.getByRole("button", { name: "save" }),
				).toBeEnabled(),
			);
		});
	});

	describe("the saved kit in the cache", () => {
		it("lands even when the form unmounts before the save answers", async () => {
			let finishSave: (value: unknown) => void = () => {};
			state.updateMock.mockReturnValueOnce(
				new Promise((resolve) => {
					finishSave = resolve;
				}),
			);
			const user = userEvent.setup();
			const { client, unmount } = renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			const guidance = screen.getByLabelText("guidance");
			await user.clear(guidance);
			await user.type(guidance, "Short sentences.");
			await user.click(screen.getByRole("button", { name: "save" }));
			await waitFor(() =>
				expect(state.updateMock).toHaveBeenCalledTimes(1),
			);

			unmount();
			finishSave({
				outcome: "applied",
				brandKit: savedKit({
					guidance: "Short sentences.",
					version: 5,
				}),
			});

			await waitFor(() =>
				expect(client.getQueryData(BRAND_KIT_KEY)).toMatchObject({
					guidance: "Short sentences.",
					version: 5,
				}),
			);
			// The toast and the draft's reset belong to the mounted form.
			expect(state.toastSuccess).not.toHaveBeenCalled();
		});

		it("is not overwritten by a read that was already in flight", async () => {
			const user = userEvent.setup();
			const { client } = renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			const guidance = screen.getByLabelText("guidance");
			await user.clear(guidance);
			await user.type(guidance, "Short sentences.");

			// A background read (a poll, a refocus) starts before the save
			// and answers after it, with the kit as it was.
			let finishRead: (value: unknown) => void = () => {};
			state.getMock.mockReturnValueOnce(
				new Promise((resolve) => {
					finishRead = resolve;
				}),
			);
			void client.refetchQueries({ queryKey: BRAND_KIT_KEY });
			await waitFor(() => expect(state.getMock).toHaveBeenCalledTimes(2));

			await user.click(screen.getByRole("button", { name: "save" }));
			await waitFor(() =>
				expect(state.toastSuccess).toHaveBeenCalledWith("saved"),
			);
			await act(async () => {
				finishRead({ brandKit: savedKit() });
				await new Promise((resolve) => setTimeout(resolve, 50));
			});

			expect(client.getQueryData(BRAND_KIT_KEY)).toMatchObject({
				guidance: "Short sentences.",
				version: 5,
			});
			expect(screen.getByLabelText("guidance")).toHaveValue(
				"Short sentences.",
			);
		});
	});

	it("marks the website when the server refuses it", async () => {
		const user = userEvent.setup();
		state.updateMock.mockRejectedValueOnce(
			new ORPCError("BAD_REQUEST", { data: { code: "invalidWebsite" } }),
		);
		renderForm();

		await screen.findByRole("textbox", { name: "accentHex" });
		const website = screen.getByLabelText("website");
		await user.clear(website);
		await user.type(website, "mailto:dev@example.com");
		await user.click(screen.getByRole("button", { name: "save" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"saveError.invalidWebsite",
		);
		expect(website).toHaveAttribute("aria-invalid", "true");
		expect(state.toastError).not.toHaveBeenCalled();
		expect(state.fetchSiteMock).not.toHaveBeenCalled();
	});

	describe("a save that someone else's save overtook", () => {
		it("says so with Reload, keeps the draft, and Reload reads the newer kit", async () => {
			const user = userEvent.setup();
			state.updateMock.mockRejectedValueOnce(
				new ORPCError("CONFLICT", {
					message: "Someone else changed the Brand kit.",
				}),
			);
			renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			const guidance = screen.getByLabelText("guidance");
			await user.clear(guidance);
			await user.type(guidance, "My unsaved edit.");
			await user.click(screen.getByRole("button", { name: "save" }));

			const alert = await screen.findByRole("alert");
			expect(alert).toHaveTextContent("conflict");
			expect(screen.getByLabelText("guidance")).toHaveValue(
				"My unsaved edit.",
			);
			expect(state.toastError).not.toHaveBeenCalled();

			state.getMock.mockResolvedValue({
				brandKit: savedKit({ guidance: "Their edit.", version: 5 }),
			});
			await user.click(
				within(alert).getByRole("button", { name: "reload" }),
			);

			await waitFor(() =>
				expect(screen.getByLabelText("guidance")).toHaveValue(
					"Their edit.",
				),
			);
			expect(screen.queryByText("conflict")).not.toBeInTheDocument();
		});

		it("keeps the draft and the notice when Reload cannot read the kit", async () => {
			const user = userEvent.setup();
			state.updateMock.mockRejectedValueOnce(new ORPCError("CONFLICT"));
			renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			const guidance = screen.getByLabelText("guidance");
			await user.clear(guidance);
			await user.type(guidance, "My unsaved edit.");
			await user.click(screen.getByRole("button", { name: "save" }));
			const alert = await screen.findByRole("alert");

			state.getMock.mockRejectedValue(new Error("Network down"));
			await user.click(
				within(alert).getByRole("button", { name: "reload" }),
			);

			// The kit's read retries once, about a second, before it fails.
			await waitFor(
				() =>
					expect(state.toastError).toHaveBeenCalledWith("loadFailed"),
				{ timeout: 3000 },
			);
			expect(screen.getByLabelText("guidance")).toHaveValue(
				"My unsaved edit.",
			);
			expect(screen.getByText("conflict")).toBeInTheDocument();
		});

		it("drops an earlier Fetch again's refusal once Reload reads the newer kit", async () => {
			const user = userEvent.setup();
			state.fetchSiteMock.mockRejectedValueOnce(
				new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down" }),
			);
			state.updateMock.mockRejectedValueOnce(new ORPCError("CONFLICT"));
			renderForm();

			await user.click(
				await screen.findByRole("button", {
					name: "siteFetch.fetchAgain",
				}),
			);
			expect(
				await screen.findByText("siteFetch.failed.rate_limited"),
			).toBeInTheDocument();
			const guidance = screen.getByLabelText("guidance");
			await user.clear(guidance);
			await user.type(guidance, "My unsaved edit.");
			await user.click(screen.getByRole("button", { name: "save" }));
			const alert = await screen.findByRole("alert");

			// Someone else's save, and a fetch that has since found colors.
			state.getMock.mockResolvedValue({
				brandKit: savedKit({
					guidance: "Their edit.",
					version: 5,
					siteFetch: {
						website: "https://example.com",
						status: "SUCCEEDED",
						failureCode: null,
						requestedAt: new Date(),
						fetchedAt: new Date(),
						resultWebsite: "https://example.com",
						primaryColor: "#0a2540",
						accentColors: [],
					},
				}),
			});
			await user.click(
				within(alert).getByRole("button", { name: "reload" }),
			);

			expect(
				await screen.findByText("siteFetch.found"),
			).toBeInTheDocument();
			expect(
				screen.queryByText("siteFetch.failed.rate_limited"),
			).not.toBeInTheDocument();
		});
	});

	describe("website fetch", () => {
		it("asks for an automatic fetch after a save that changed the website", async () => {
			const user = userEvent.setup();
			renderForm();

			await screen.findByRole("textbox", { name: "accentHex" });
			const website = screen.getByLabelText("website");
			await user.clear(website);
			await user.type(website, "https://example.org");
			await user.click(screen.getByRole("button", { name: "save" }));

			await waitFor(() =>
				expect(state.fetchSiteMock).toHaveBeenCalledWith({
					organizationId: "org-1",
					automatic: true,
				}),
			);
			expect(state.updateMock).toHaveBeenCalledWith(
				expect.objectContaining({ website: "https://example.org" }),
			);
		});

		it("polls while the stored website's fetch runs, then shows the colors it found", async () => {
			vi.useFakeTimers({ shouldAdvanceTime: true });
			state.getMock
				.mockResolvedValueOnce({
					brandKit: savedKit({
						siteFetch: {
							website: "https://example.com",
							status: "RUNNING",
							failureCode: null,
							requestedAt: new Date(),
							fetchedAt: null,
							resultWebsite: null,
							primaryColor: null,
							accentColors: [],
						},
					}),
				})
				.mockResolvedValue({
					brandKit: savedKit({
						siteFetch: {
							website: "https://example.com",
							status: "SUCCEEDED",
							failureCode: null,
							requestedAt: new Date(),
							fetchedAt: new Date(),
							resultWebsite: "https://example.com",
							primaryColor: "#0a2540",
							accentColors: ["#f59e0b"],
						},
					}),
				});
			renderForm();

			expect(
				await screen.findByText("siteFetch.running"),
			).toBeInTheDocument();
			expect(state.getMock).toHaveBeenCalledTimes(1);

			await vi.advanceTimersByTimeAsync(BRAND_FETCH_POLL_MS + 50);

			expect(
				await screen.findByText("siteFetch.found"),
			).toBeInTheDocument();
			expect(state.getMock).toHaveBeenCalledTimes(2);
			const found = screen.getAllByRole("textbox", {
				name: "siteFetch.foundHex",
			});
			expect(
				found.map((input) => (input as HTMLInputElement).value),
			).toEqual(["#0a2540", "#f59e0b"]);
			// Shown, never editable, and never copied into the kit's fields.
			for (const input of found) {
				expect(input).toBeDisabled();
			}
			expect(
				screen.queryByRole("textbox", { name: "primaryHex" }),
			).not.toBeInTheDocument();

			// Settled: no more polling.
			await vi.advanceTimersByTimeAsync(BRAND_FETCH_POLL_MS * 2);
			expect(state.getMock).toHaveBeenCalledTimes(2);
		});

		it.each([
			{ failureCode: "unreachable" },
			{ failureCode: "no_colors" },
			{ failureCode: "timed_out" },
		])(
			"shows a failed fetch's $failureCode copy and does not poll",
			async ({ failureCode }) => {
				vi.useFakeTimers({ shouldAdvanceTime: true });
				state.getMock.mockResolvedValue({
					brandKit: savedKit({
						siteFetch: {
							website: "https://example.com",
							status: "FAILED",
							failureCode,
							requestedAt: new Date(),
							fetchedAt: null,
							resultWebsite: null,
							primaryColor: null,
							accentColors: [],
						},
					}),
				});
				renderForm();

				expect(
					await screen.findByText(`siteFetch.failed.${failureCode}`),
				).toBeInTheDocument();
				await vi.advanceTimersByTimeAsync(BRAND_FETCH_POLL_MS * 2);
				expect(state.getMock).toHaveBeenCalledTimes(1);
			},
		);

		it("ignores an attempt and a result that belong to another website", async () => {
			state.getMock.mockResolvedValue({
				brandKit: savedKit({
					siteFetch: {
						website: "https://old.example.com",
						status: "SUCCEEDED",
						failureCode: null,
						requestedAt: new Date(),
						fetchedAt: new Date(),
						resultWebsite: "https://old.example.com",
						primaryColor: "#0a2540",
						accentColors: [],
					},
				}),
			});
			renderForm();

			expect(
				await screen.findByText("siteFetch.notFetched"),
			).toBeInTheDocument();
			expect(
				screen.queryByText("siteFetch.found"),
			).not.toBeInTheDocument();
		});

		it("fetches again on request, and says so when the limit refuses it", async () => {
			const user = userEvent.setup();
			state.fetchSiteMock.mockRejectedValueOnce(
				new ORPCError("TOO_MANY_REQUESTS", { message: "Slow down" }),
			);
			renderForm();

			await user.click(
				await screen.findByRole("button", {
					name: "siteFetch.fetchAgain",
				}),
			);

			await waitFor(() =>
				expect(state.fetchSiteMock).toHaveBeenCalledWith({
					organizationId: "org-1",
					automatic: false,
				}),
			);
			expect(
				await screen.findByText("siteFetch.failed.rate_limited"),
			).toBeInTheDocument();
		});
	});

	describe("accessibility", () => {
		it("has no axe violations for an admin", async () => {
			const { container } = renderForm();
			await screen.findByRole("textbox", { name: "accentHex" });

			expect(await axe(container)).toHaveNoViolations();
		});

		it("has no axe violations read-only, with found colors, or with errors flagged", async () => {
			const user = userEvent.setup();
			const { container, unmount } = renderForm();
			const accent = await screen.findByRole("textbox", {
				name: "accentHex",
			});
			await user.clear(accent);
			await user.type(accent, "not-a-color");
			await user.type(
				screen.getByLabelText("bodyFontFamily"),
				"Bad;Font",
			);
			pick("uploadHero", fileOf("cover.svg", "image/svg+xml", 4 * KIB));
			await user.click(screen.getByRole("button", { name: "save" }));
			expect(await axe(container)).toHaveNoViolations();
			unmount();

			state.role = "member";
			state.getMock.mockResolvedValue({
				brandKit: savedKit({
					siteFetch: {
						website: "https://example.com",
						status: "SUCCEEDED",
						failureCode: null,
						requestedAt: new Date(),
						fetchedAt: new Date(),
						resultWebsite: "https://example.com",
						primaryColor: "#0a2540",
						accentColors: ["#f59e0b"],
					},
				}),
			});
			const readOnly = renderForm();
			await screen.findByText("siteFetch.found");
			expect(await axe(readOnly.container)).toHaveNoViolations();
		});
	});
});
