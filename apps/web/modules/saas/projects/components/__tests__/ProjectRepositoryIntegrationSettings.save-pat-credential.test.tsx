/**
 * "Connect with a token (PAT)" with the credential manager on: a GitHub
 * token is saved there by default ("Save in the credential manager", with an
 * optional name), and when the person already saved a token for the same
 * account the form asks: "Use it" connects with `credentialId`, "Save as new"
 * sends `saveCredential.saveAsNew`. With the flag off the form is unchanged.
 */

import en from "@repo/i18n/translations/en.json";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({
	credentialManager: false,
	list: vi.fn(),
	connect: vi.fn(),
}));

function resolve(path: string): unknown {
	return path.split(".").reduce<unknown>((node, key) => {
		if (node && typeof node === "object") {
			return (node as Record<string, unknown>)[key];
		}
		return undefined;
	}, en);
}

vi.mock("next-intl", () => ({
	useTranslations: (namespace: string) => {
		const t = (key: string, values?: Record<string, unknown>) => {
			const raw = resolve(`${namespace}.${key}`);
			let out = typeof raw === "string" ? raw : key;
			for (const [name, value] of Object.entries(values ?? {})) {
				out = out.replaceAll(`{${name}}`, String(value));
			}
			return out;
		};
		t.raw = (key: string) => key;
		t.has = () => false;
		return t;
	},
	useLocale: () => "en",
	NextIntlClientProvider: ({ children }: { children: ReactNode }) => children,
}));

vi.mock("@saas/shared/components/FeatureFlagProvider", () => ({
	useFeatureFlag: (key: string) =>
		key === "CREDENTIAL_MANAGER" ? m.credentialManager : false,
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			repositoryIntegrations: {
				list: (...a: unknown[]) => m.list(...a),
				connect: (...a: unknown[]) => m.connect(...a),
				updateBranch: vi.fn().mockResolvedValue({}),
			},
			github: {
				listRepos: vi.fn().mockResolvedValue({ groups: [] }),
			},
			gitlab: {
				listRepos: vi.fn().mockResolvedValue({ groups: [] }),
			},
			ragSettings: { update: vi.fn().mockResolvedValue({}) },
		},
		integrations: {
			github: {
				status: vi.fn().mockResolvedValue({ connected: false }),
				start: vi.fn(),
			},
			gitlab: {
				status: vi.fn().mockResolvedValue({ connected: false }),
			},
		},
	},
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			get: { queryKey: () => ["projects", "get"] },
			ragSettings: {
				get: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["rag-settings", opts?.input],
						queryFn: async () => ({
							settings: { codeSearchMode: "OFF" },
						}),
					}),
				},
			},
		},
		agents: {
			codeIndex: {
				status: {
					queryOptions: (opts: { input: unknown }) => ({
						queryKey: ["code-index-status", opts?.input],
						queryFn: async () => ({
							status: "MISSING",
							indexedAt: null,
							filesIndexed: 0,
							chunksCreated: 0,
							error: null,
						}),
					}),
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { error: vi.fn(), success: vi.fn(), info: vi.fn() },
}));

import { toast } from "sonner";
import { ProjectRepositoryIntegrationSettings } from "../ProjectRepositoryIntegrationSettings";

const project = {
	id: "proj-1",
	organizationId: "org-1",
	canEditSettings: true,
	repositoryUrl: null,
	repositoryOwner: null,
	repositoryName: null,
	repositoryIntegrations: [],
} as unknown as React.ComponentProps<
	typeof ProjectRepositoryIntegrationSettings
>["project"];

const REPO_URL = "https://github.com/example-org/booking-app";
const TOKEN = "ghp_example";

function renderSettings() {
	const queryClient = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	render(
		<QueryClientProvider client={queryClient}>
			<ProjectRepositoryIntegrationSettings
				project={project}
				currentUserId="user-1"
			/>
		</QueryClientProvider>,
	);
}

async function openPatForm(user: ReturnType<typeof userEvent.setup>) {
	const [addButton] = await screen.findAllByRole("button", {
		name: /add repository/i,
	});
	await user.click(addButton);
	await user.click(
		await screen.findByRole("button", {
			name: "Connect with a token (PAT)",
		}),
	);
	await user.type(
		screen.getByPlaceholderText(/dev\.azure\.com\/org\/project\/_git/),
		REPO_URL,
	);
	await user.type(
		screen.getByPlaceholderText("Paste your token here"),
		TOKEN,
	);
}

const connectBase = {
	projectId: "proj-1",
	organizationId: "org-1",
	provider: "GITHUB",
	authMethod: "PAT",
	repositoryUrl: REPO_URL,
	repositoryOwner: "example-org",
	repositoryName: "booking-app",
};

beforeEach(() => {
	vi.clearAllMocks();
	m.credentialManager = false;
	m.list.mockResolvedValue({ integrations: [] });
	m.connect.mockResolvedValue({
		integration: { id: "int-1" },
		success: true,
	});
});

describe("Connect with a token (PAT): save in the credential manager", () => {
	it("flag off: no checkbox, and the token is sent as before", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openPatForm(user);

		expect(
			screen.queryByLabelText("Save in the credential manager"),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /test & connect/i }),
		);

		await waitFor(() => expect(m.connect).toHaveBeenCalled());
		const sent = m.connect.mock.calls[0]?.[0];
		expect(sent).toMatchObject({ ...connectBase, pat: TOKEN });
		expect(sent.saveCredential).toBeUndefined();
	});

	it("flag on: ticked by default with a name field, and the token is saved", async () => {
		m.credentialManager = true;
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openPatForm(user);

		expect(
			screen.getByRole("checkbox", {
				name: "Save in the credential manager",
			}),
		).toBeChecked();
		const label = screen.getByLabelText("Credential name");
		expect(label).toHaveAttribute(
			"placeholder",
			"GitHub token · your GitHub login",
		);
		await user.type(label, "CI token");
		await user.click(
			screen.getByRole("button", { name: /test & connect/i }),
		);

		await waitFor(() => expect(m.connect).toHaveBeenCalled());
		expect(m.connect.mock.calls[0]?.[0]).toMatchObject({
			...connectBase,
			pat: TOKEN,
			saveCredential: { label: "CI token", saveAsNew: false },
		});
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("Repository connected!"),
		);
	});

	it("flag on, box cleared: the token is sent without saveCredential", async () => {
		m.credentialManager = true;
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openPatForm(user);
		await user.click(
			screen.getByRole("checkbox", {
				name: "Save in the credential manager",
			}),
		);
		await user.click(
			screen.getByRole("button", { name: /test & connect/i }),
		);

		await waitFor(() => expect(m.connect).toHaveBeenCalled());
		expect(m.connect.mock.calls[0]?.[0].saveCredential).toBeUndefined();
	});

	it("asks when the account's token is already saved; 'Use it' connects with credentialId", async () => {
		m.credentialManager = true;
		m.connect.mockResolvedValueOnce({
			existingCredential: {
				id: "cred-old",
				label: "Laptop token",
				externalAccountLogin: "example-dev",
			},
		});
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openPatForm(user);
		await user.click(
			screen.getByRole("button", { name: /test & connect/i }),
		);

		expect(
			await screen.findByText(
				"You already saved a token for example-dev as Laptop token. Use it?",
			),
		).toBeInTheDocument();
		expect(toast.success).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: "Use it" }));
		await waitFor(() => expect(m.connect).toHaveBeenCalledTimes(2));
		const second = m.connect.mock.calls[1]?.[0];
		expect(second).toMatchObject({
			...connectBase,
			credentialId: "cred-old",
		});
		expect(second.pat).toBeUndefined();
		expect(second.saveCredential).toBeUndefined();
		await waitFor(() =>
			expect(toast.success).toHaveBeenCalledWith("Repository connected!"),
		);
	});

	it("'Save as new' sends the token once more with saveAsNew", async () => {
		m.credentialManager = true;
		m.connect.mockResolvedValueOnce({
			existingCredential: {
				id: "cred-old",
				label: "Laptop token",
				externalAccountLogin: "example-dev",
			},
		});
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderSettings();
		await openPatForm(user);
		await user.click(
			screen.getByRole("button", { name: /test & connect/i }),
		);
		await user.click(
			await screen.findByRole("button", { name: "Save as new" }),
		);

		await waitFor(() => expect(m.connect).toHaveBeenCalledTimes(2));
		expect(m.connect.mock.calls[1]?.[0]).toMatchObject({
			...connectBase,
			pat: TOKEN,
			saveCredential: { saveAsNew: true },
		});
	});
});
