import en from "@repo/i18n/translations/en.json";
import { openOAuthPopup } from "@shared/lib/oauth-popup";
import { orpcClient } from "@shared/lib/orpc-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// Radix Select needs these in jsdom.
beforeAll(() => {
	if (typeof globalThis.ResizeObserver === "undefined") {
		globalThis.ResizeObserver = class {
			observe(): void {}
			unobserve(): void {}
			disconnect(): void {}
		} as unknown as typeof ResizeObserver;
	}
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

function makeT(namespace: string) {
	return (key: string, values?: Record<string, unknown>) => {
		const raw = resolve(`${namespace}.${key}`);
		if (typeof raw !== "string") {
			throw new Error(`missing translation: ${namespace}.${key}`);
		}
		let out = raw;
		for (const [name, value] of Object.entries(values ?? {})) {
			out = out.replaceAll(`{${name}}`, String(value));
		}
		return out;
	};
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => makeT(namespace),
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

const m = vi.hoisted(() => ({
	push: vi.fn(),
	preview: vi.fn(),
	create: vi.fn(),
	existingSetup: vi.fn(),
	importStart: vi.fn(),
	syncGet: vi.fn(),
	configure: vi.fn(),
	memoryConfigure: vi.fn(),
	memorySyncNow: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	searchParams: new URLSearchParams(),
}));

vi.mock("next/navigation", () => ({
	useRouter: () => ({ push: m.push }),
	useSearchParams: () => m.searchParams,
}));
vi.mock("sonner", () => ({
	toast: { success: m.toastSuccess, error: m.toastError },
}));
vi.mock("@shared/lib/oauth-popup", () => ({
	openOAuthPopup: vi.fn(),
	POPUP_BLOCKED_MESSAGE: "Popups are blocked.",
}));
vi.mock("../wizard/GitHubRepoPicker", () => ({
	GitHubRepoPicker: () => null,
}));
vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			previewRepositoryImport: {
				mutationOptions: () => ({ mutationFn: m.preview }),
			},
		},
	},
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			create: m.create,
			existingSetup: { start: m.existingSetup },
			repositoryImport: { start: m.importStart },
			instructions: {
				repositorySync: { get: m.syncGet, configure: m.configure },
			},
			contexts: {
				repositorySync: {
					configure: m.memoryConfigure,
					syncNow: m.memorySyncNow,
				},
			},
		},
		workflows: { integrations: { save: vi.fn() } },
		integrations: { github: { start: vi.fn() } },
	},
}));

import { NewProjectStart } from "../NewProjectStart";
import {
	parseMemoryFolders,
	parseTechStack,
	RepositoryImportForm,
} from "../RepositoryImportForm";

const PRODUCT_URL = "https://github.com/example-org/booking-app";
const INSTRUCTIONS_URL = "https://github.com/example-org/ai-rules";

function wrap(node: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={client}>{node}</QueryClientProvider>,
	);
}

function renderForm() {
	return wrap(
		<RepositoryImportForm
			organizationId="org_1"
			projectsBasePath="/app/example-org/projects"
		/>,
	);
}

async function readProduct(user: ReturnType<typeof userEvent.setup>) {
	await user.type(
		screen.getByLabelText("GitHub repository"),
		"example-org/booking-app",
	);
	await user.click(screen.getByRole("button", { name: "Read" }));
	await screen.findByLabelText("Project title");
}

beforeEach(() => {
	vi.clearAllMocks();
	m.searchParams = new URLSearchParams();
	m.preview.mockResolvedValue({
		repository: {
			owner: "example-org",
			name: "booking-app",
			htmlUrl: PRODUCT_URL,
			defaultBranch: "main",
		},
		name: "booking-app",
		description: "A booking app for small studios.",
		descriptionGenerated: true,
		techStack: ["TypeScript", "React"],
		projectPhase: "DEVELOPMENT_EXECUTION",
		aiFileCount: 3,
	});
	m.create.mockResolvedValue({
		project: { id: "p1", name: "Booking" },
	});
	m.existingSetup.mockResolvedValue({ status: "SCANNING" });
	m.importStart.mockResolvedValue({ run: null });
	m.syncGet.mockResolvedValue({
		availableIntegrations: [
			{
				id: "int-product",
				provider: "GITHUB",
				repositoryOwner: "example-org",
				repositoryName: "booking-app",
				defaultBranch: "main",
			},
			{
				id: "int-rules",
				provider: "GITHUB",
				repositoryOwner: "Example-Org",
				repositoryName: "ai-rules",
				defaultBranch: "trunk",
			},
			{
				id: "int-api",
				provider: "GITHUB",
				repositoryOwner: "example-org",
				repositoryName: "booking-api",
				defaultBranch: "main",
			},
			{
				id: "int-handbook",
				provider: "GITHUB",
				repositoryOwner: "example-org",
				repositoryName: "handbook",
				defaultBranch: "main",
			},
		],
	});
	m.configure.mockResolvedValue({});
	m.memoryConfigure.mockResolvedValue({});
	m.memorySyncNow.mockResolvedValue({ started: true });
});

describe("parseMemoryFolders", () => {
	it("splits on commas without the slashes around each folder", () => {
		expect(parseMemoryFolders(" docs, /adr/ ,docs")).toEqual([
			"docs",
			"adr",
		]);
	});

	it("is the whole repository when no folder is typed", () => {
		expect(parseMemoryFolders("  ")).toEqual([""]);
	});
});

describe("other code repositories and Living Memory", () => {
	const API_URL = "https://github.com/example-org/booking-api";
	const HANDBOOK_URL = "https://github.com/example-org/handbook";

	async function addCodeRepository(
		user: ReturnType<typeof userEvent.setup>,
		value: string,
	) {
		const group = screen.getByRole("group", {
			name: "Other code repositories",
		});
		await user.type(
			within(group).getByLabelText("GitHub repository"),
			value,
		);
		await user.click(within(group).getByRole("button", { name: "Add" }));
	}

	it("connects more code repositories with the product and reads them as code", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await addCodeRepository(user, "example-org/booking-api");
		expect(screen.getByText("example-org/booking-api")).toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		const started = m.existingSetup.mock.calls[0]?.[0];
		expect(started.repoUrls).toEqual([PRODUCT_URL, API_URL]);
		expect(started.repoRoles).toBeUndefined();
		// The import still reads the product repository.
		expect(m.importStart.mock.calls[0]?.[0]).toEqual({
			projectId: "p1",
			organizationId: "org_1",
			repositoryIntegrationId: "int-product",
		});
		expect(m.memoryConfigure).not.toHaveBeenCalled();
	});

	it("says which repositories the connection could not connect", async () => {
		m.existingSetup.mockResolvedValue({
			status: "SCANNING",
			skippedRepos: ["GitHub: example-org/booking-app"],
		});
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		expect(m.toastError).toHaveBeenCalledWith(
			expect.stringContaining("GitHub: example-org/booking-app"),
		);
	});

	it("refuses a code repository listed twice", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await addCodeRepository(user, "example-org/booking-app");

		expect(
			screen.getByText("This repository is already listed."),
		).toBeInTheDocument();
	});

	it("syncs a documentation repository's folders into Living Memory and marks it for the analysis", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(
			screen.getByRole("checkbox", {
				name: "Keep documentation from a repository in Living Memory",
			}),
		);
		const group = screen.getByRole("group", {
			name: "Living Memory repository",
		});
		await user.type(
			within(group).getByLabelText("GitHub repository"),
			"example-org/handbook",
		);
		await user.type(within(group).getByLabelText("Folders"), "docs, adr/");
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		expect(m.existingSetup.mock.calls[0]?.[0]).toMatchObject({
			repoUrls: [PRODUCT_URL, HANDBOOK_URL],
			repoRoles: { [HANDBOOK_URL]: "knowledge" },
		});
		expect(m.memoryConfigure.mock.calls[0]?.[0]).toEqual({
			projectId: "p1",
			organizationId: "org_1",
			repositoryIntegrationId: "int-handbook",
			ref: "main",
			paths: ["docs", "adr"],
		});
		expect(m.memorySyncNow).toHaveBeenCalledWith({
			projectId: "p1",
			organizationId: "org_1",
		});
		expect(m.importStart.mock.calls[0]?.[0]).toMatchObject({
			repositoryIntegrationId: "int-product",
		});
	});

	it("keeps the product repository's own docs in Living Memory without connecting it twice", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(
			screen.getByRole("checkbox", {
				name: "Keep documentation from a repository in Living Memory",
			}),
		);
		const group = screen.getByRole("group", {
			name: "Living Memory repository",
		});
		await user.type(
			within(group).getByLabelText("GitHub repository"),
			"example-org/booking-app",
		);
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		const started = m.existingSetup.mock.calls[0]?.[0];
		expect(started.repoUrls).toEqual([PRODUCT_URL]);
		expect(started.repoRoles).toBeUndefined();
		expect(m.memoryConfigure.mock.calls[0]?.[0]).toMatchObject({
			repositoryIntegrationId: "int-product",
			paths: [""],
		});
	});

	it("refuses the instructions repository as the Living Memory repository", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(
			screen.getByRole("checkbox", {
				name: "My coding instructions live in a separate repository",
			}),
		);
		const instructions = screen.getByRole("group", {
			name: "Coding instructions repository",
		});
		await user.type(
			within(instructions).getByLabelText("GitHub repository"),
			"example-org/ai-rules",
		);
		await user.click(
			screen.getByRole("checkbox", {
				name: "Keep documentation from a repository in Living Memory",
			}),
		);
		const memory = screen.getByRole("group", {
			name: "Living Memory repository",
		});
		await user.type(
			within(memory).getByLabelText("GitHub repository"),
			"example-org/ai-rules",
		);
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		expect(
			await screen.findByText(
				"Choose a repository other than the coding instructions repository.",
			),
		).toBeInTheDocument();
		expect(m.create).not.toHaveBeenCalled();
	});
});

describe("parseTechStack", () => {
	it("splits on commas, dropping blanks and repeats", () => {
		expect(parseTechStack(" React, ,Vite,React ")).toEqual([
			"React",
			"Vite",
		]);
	});
});

describe("RepositoryImportForm", () => {
	it("fills the project from the preview and creates it as edited", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		expect(m.preview.mock.calls[0]?.[0]).toMatchObject({
			organizationId: "org_1",
			owner: "example-org",
			repo: "booking-app",
		});
		expect(screen.getByLabelText("Project title")).toHaveValue(
			"booking-app",
		);
		expect(screen.getByLabelText("Description")).toHaveValue(
			"A booking app for small studios.",
		);
		expect(screen.getByLabelText("Tech stack")).toHaveValue(
			"TypeScript, React",
		);
		expect(screen.getByText(/offers to move them/)).toBeInTheDocument();

		const title = screen.getByLabelText("Project title");
		await user.clear(title);
		await user.type(title, "Booking");
		await user.type(screen.getByLabelText("Tech stack"), ", Vite");
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		expect(m.create.mock.calls[0]?.[0]).toMatchObject({
			name: "Booking",
			description: "A booking app for small studios.",
			techStack: ["TypeScript", "React", "Vite"],
			organizationId: "org_1",
			projectPhase: "DEVELOPMENT_EXECUTION",
			repositoryUrl: PRODUCT_URL,
			repositoryOwner: "example-org",
			repositoryName: "booking-app",
			defaultBranch: "main",
		});
		expect(
			m.create.mock.calls[0]?.[0].expectedDevelopmentStartDate,
		).toBeUndefined();
		expect(m.existingSetup.mock.calls[0]?.[0]).toMatchObject({
			projectId: "p1",
			repoUrls: [PRODUCT_URL],
		});
		expect(m.existingSetup.mock.calls[0]?.[0]).not.toHaveProperty(
			"repoTags",
		);
		expect(m.syncGet).not.toHaveBeenCalled();
		expect(m.configure).not.toHaveBeenCalled();
		expect(m.importStart.mock.calls[0]?.[0]).toEqual({
			projectId: "p1",
			organizationId: "org_1",
		});
		expect(m.push).toHaveBeenCalledWith(
			"/app/example-org/projects/p1?tab=overview",
		);
	});

	it("connects a separate instructions repository before the import starts", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(
			screen.getByRole("checkbox", {
				name: "My coding instructions live in a separate repository",
			}),
		);
		const group = screen.getByRole("group", {
			name: "Coding instructions repository",
		});
		expect(group).toBeInTheDocument();
		expect(
			screen.getByText(/does not offer to move them/),
		).toBeInTheDocument();
		const [, instructionsField] =
			screen.getAllByLabelText("GitHub repository");
		await user.type(
			instructionsField as HTMLElement,
			"https://github.com/example-org/ai-rules.git",
		);
		await user.type(screen.getByLabelText("Folder"), "projects/booking/");
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		expect(m.existingSetup.mock.calls[0]?.[0]).toMatchObject({
			repoUrls: [PRODUCT_URL, INSTRUCTIONS_URL],
			repoTags: { [INSTRUCTIONS_URL]: "instructions" },
		});
		expect(m.configure.mock.calls[0]?.[0]).toEqual({
			projectId: "p1",
			repositoryIntegrationId: "int-rules",
			// No branch typed: the connected repository's default branch.
			ref: "trunk",
			rootPath: "projects/booking",
		});
		// The import reads the product repository, not the one connected
		// after it.
		expect(m.importStart.mock.calls[0]?.[0]).toEqual({
			projectId: "p1",
			organizationId: "org_1",
			repositoryIntegrationId: "int-product",
		});
		expect(m.configure.mock.invocationCallOrder[0]).toBeLessThan(
			m.importStart.mock.invocationCallOrder[0] as number,
		);
	});

	it("refuses the product repository as its own instructions repository", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(
			screen.getByRole("checkbox", {
				name: "My coding instructions live in a separate repository",
			}),
		);
		const [, instructionsField] =
			screen.getAllByLabelText("GitHub repository");
		await user.type(
			instructionsField as HTMLElement,
			"Example-Org/booking-app",
		);
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Choose a repository other than the product repository",
		);
		expect(instructionsField).toHaveAttribute("aria-invalid", "true");
		expect(m.create).not.toHaveBeenCalled();
	});

	it("keeps the project when the instructions sync cannot be saved", async () => {
		m.configure.mockRejectedValue(new Error("nope"));
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);
		await user.click(
			screen.getByRole("checkbox", {
				name: "My coding instructions live in a separate repository",
			}),
		);
		const [, instructionsField] =
			screen.getAllByLabelText("GitHub repository");
		await user.type(
			instructionsField as HTMLElement,
			"example-org/ai-rules",
		);
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.push).toHaveBeenCalled());
		expect(m.toastError).toHaveBeenCalledWith(
			expect.stringContaining("its sync was not saved"),
		);
		expect(m.importStart).toHaveBeenCalledWith(
			expect.objectContaining({ repositoryIntegrationId: "int-product" }),
		);
	});

	it("says what format a typed repository needs", async () => {
		const user = userEvent.setup();
		renderForm();
		await user.type(screen.getByLabelText("GitHub repository"), "nope");
		await user.click(screen.getByRole("button", { name: "Read" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Enter a GitHub repository as owner/name",
		);
		expect(m.preview).not.toHaveBeenCalled();
	});

	it("reads the repository again when the GitHub sign-in popup reports success", async () => {
		m.preview.mockRejectedValueOnce(
			Object.assign(new Error("Connect GitHub to import."), {
				data: { code: "GITHUB_NOT_CONNECTED" },
			}),
		);
		const popup = { location: { href: "" }, close: vi.fn() };
		vi.mocked(openOAuthPopup).mockReturnValue(popup as unknown as Window);
		vi.mocked(orpcClient.integrations.github.start).mockResolvedValue({
			authorizationUrl: "https://github.com/login/oauth/authorize?x=1",
		} as never);
		const user = userEvent.setup();
		renderForm();
		await user.type(
			screen.getByLabelText("GitHub repository"),
			"example-org/booking-app",
		);
		await user.click(screen.getByRole("button", { name: "Read" }));
		await user.click(
			await screen.findByRole("button", { name: "Sign in with GitHub" }),
		);
		await waitFor(() =>
			expect(popup.location.href).toContain("github.com/login"),
		);

		// What the GitHub OAuth callback page posts to its opener.
		act(() => {
			window.dispatchEvent(
				new MessageEvent("message", {
					data: { type: "github_oauth_success", success: true },
					origin: window.location.origin,
				}),
			);
		});

		expect(await screen.findByLabelText("Project title")).toHaveValue(
			"booking-app",
		);
		expect(m.preview).toHaveBeenCalledTimes(2);
	});
});

describe("RepositoryImportForm — phase", () => {
	function phaseTrigger() {
		return screen.getByRole("combobox", {
			name: "Where is this project now?",
		});
	}

	it("proposes development for a code repository", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);
		expect(phaseTrigger()).toHaveTextContent("Development / Execution");
		expect(
			screen.queryByLabelText("When is development expected to start?"),
		).not.toBeInTheDocument();
	});

	it("proposes planning for a docs repository and asks when development starts", async () => {
		m.preview.mockResolvedValueOnce({
			...(await m.preview.getMockImplementation()?.()),
			projectPhase: "DISCOVERY_PLANNING",
		});
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);
		expect(phaseTrigger()).toHaveTextContent("Discovery / Planning");

		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Choose when development is expected to start.",
		);
		expect(m.create).not.toHaveBeenCalled();

		await user.type(
			screen.getByLabelText("When is development expected to start?"),
			"2999-01-15",
		);
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);
		await waitFor(() => expect(m.create).toHaveBeenCalled());
		const sent = m.create.mock.calls[0]?.[0];
		expect(sent.projectPhase).toBe("DISCOVERY_PLANNING");
		expect(sent.expectedDevelopmentStartDate).toEqual(
			new Date("2999-01-15"),
		);
	});

	it("requires a phase when the preview proposes none", async () => {
		m.preview.mockResolvedValueOnce({
			...(await m.preview.getMockImplementation()?.()),
			projectPhase: null,
		});
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);
		expect(phaseTrigger()).toHaveTextContent("Choose a phase");

		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"Choose which phase this project is in.",
		);
		expect(phaseTrigger()).toHaveAttribute("aria-invalid", "true");
		expect(m.create).not.toHaveBeenCalled();
	});

	it("keeps the person's choice over the proposal", async () => {
		const user = userEvent.setup();
		renderForm();
		await readProduct(user);

		await user.click(phaseTrigger());
		await user.click(
			await screen.findByRole("option", { name: "Discovery / Planning" }),
		);
		await user.type(
			screen.getByLabelText("When is development expected to start?"),
			"2999-03-01",
		);
		await user.click(
			screen.getByRole("button", { name: "Create project" }),
		);

		await waitFor(() => expect(m.create).toHaveBeenCalled());
		expect(m.create.mock.calls[0]?.[0]).toMatchObject({
			projectPhase: "DISCOVERY_PLANNING",
			expectedDevelopmentStartDate: new Date("2999-03-01"),
		});
	});
});

describe("NewProjectStart", () => {
	function renderStart() {
		return wrap(
			<NewProjectStart
				organizationId="org_1"
				projectsBasePath="/app/example-org/projects"
			>
				<p>scratch form</p>
			</NewProjectStart>,
		);
	}

	it("opens on the from-scratch form and switches to the import", async () => {
		const user = userEvent.setup();
		renderStart();
		const choice = screen.getByRole("radiogroup", {
			name: "How do you want to start?",
		});
		expect(choice).toBeInTheDocument();
		expect(
			screen.getByRole("radio", { name: /Start from scratch/ }),
		).toBeChecked();
		expect(screen.getByText("scratch form")).toBeInTheDocument();

		await user.click(
			screen.getByRole("radio", { name: /Import from a repository/ }),
		);
		expect(screen.queryByText("scratch form")).not.toBeInTheDocument();
		expect(screen.getByLabelText("GitHub repository")).toBeInTheDocument();
		// One page heading above the choice, whichever way the user starts.
		expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
		expect(
			screen.getByRole("heading", { name: "New project" }),
		).toBeInTheDocument();
	});

	it("returns from a GitHub sign-in on the import, reading the repository", async () => {
		m.searchParams = new URLSearchParams("import=example-org/booking-app");
		renderStart();
		expect(
			screen.getByRole("radio", { name: /Import from a repository/ }),
		).toBeChecked();
		expect(await screen.findByLabelText("Project title")).toHaveValue(
			"booking-app",
		);
		expect(m.preview).toHaveBeenCalledTimes(1);
	});
});
