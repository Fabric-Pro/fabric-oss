/**
 * The Living Memory repository-sync configure dialog (design 2026-09-23
 * §5.1, §7.2, Fizzy #2657):
 *  - the integration select renders only when more than one ACTIVE
 *    integration exists, and the branch input seeds from the chosen
 *    integration's defaultBranch;
 *  - the paths chips editor validates each addition client-side, mirroring
 *    the server's `paths.ts` rules, with inline errors;
 *  - submit calls `configure` then `syncNow`;
 *  - a server error code renders inline, and `configure`'s
 *    `REPOSITORY_CHANGE_REQUIRES_DISCONNECT` names the repository change it
 *    refuses.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

const { configureMock, syncNowMock } = vi.hoisted(() => ({
	configureMock: vi.fn(),
	syncNowMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-query-utils", () => ({
	orpc: {
		projects: {
			contexts: {
				repositorySync: {
					configure: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) =>
								configureMock(input),
						}),
					},
					syncNow: {
						mutationOptions: () => ({
							mutationFn: (input: unknown) => syncNowMock(input),
						}),
					},
				},
			},
		},
	},
}));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: vi.fn(), info: vi.fn() },
}));

vi.mock("next-intl", () => {
	function makeT(namespace: string) {
		const t = (key: string, values?: Record<string, unknown>) =>
			values
				? `${namespace}.${key}${JSON.stringify(values)}`
				: `${namespace}.${key}`;
		return t;
	}
	return {
		useTranslations: (namespace: string) => makeT(namespace),
	};
});

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { toast } from "sonner";
import { ConfigureContextRepositorySyncDialog } from "../ConfigureContextRepositorySyncDialog";

function wrap(ui: React.ReactElement) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<QueryClientProvider client={client}>{ui}</QueryClientProvider>,
	);
}

const NS = "projects.contexts.livingMemory.repositorySync";

const ONE_INTEGRATION = [
	{
		id: "int_1",
		provider: "GITHUB",
		repositoryOwner: "example-org",
		repositoryName: "memory",
		defaultBranch: "main",
		status: "ACTIVE",
	},
];

const TWO_INTEGRATIONS = [
	...ONE_INTEGRATION,
	{
		id: "int_2",
		provider: "GITLAB",
		repositoryOwner: "example-org",
		repositoryName: "other",
		defaultBranch: "trunk",
		status: "ACTIVE",
	},
];

function renderDialog(
	overrides: Partial<
		React.ComponentProps<typeof ConfigureContextRepositorySyncDialog>
	> = {},
) {
	const onOpenChange = vi.fn();
	const onSaved = vi.fn();
	wrap(
		<ConfigureContextRepositorySyncDialog
			projectId="proj_1"
			organizationId="org_1"
			open={true}
			onOpenChange={onOpenChange}
			integrations={ONE_INTEGRATION}
			current={null}
			onSaved={onSaved}
			{...overrides}
		/>,
	);
	return { onOpenChange, onSaved };
}

async function addPath(user: ReturnType<typeof userEvent.setup>, path: string) {
	const input = screen.getByLabelText(`${NS}.configureDialog.pathsLabel`);
	await user.clear(input);
	if (path !== "") {
		await user.type(input, path);
	}
	await user.click(screen.getByText(`${NS}.configureDialog.addPath`));
}

describe("ConfigureContextRepositorySyncDialog — integration select", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("hides the select and shows the single repository as text when only one integration is ACTIVE", () => {
		renderDialog({ integrations: ONE_INTEGRATION });
		expect(
			screen.queryByLabelText(`${NS}.configureDialog.repositoryLabel`),
		).not.toBeInTheDocument();
		expect(screen.getByText("example-org/memory")).toBeInTheDocument();
	});

	it("shows the select when more than one integration is ACTIVE, and seeds the branch from the chosen one", async () => {
		const user = userEvent.setup();
		renderDialog({ integrations: TWO_INTEGRATIONS });
		const select = screen.getByLabelText(
			`${NS}.configureDialog.repositoryLabel`,
		) as HTMLSelectElement;
		expect(select).toBeInTheDocument();
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.branchLabel`,
				) as HTMLInputElement
			).value,
		).toBe("main");

		await user.selectOptions(select, "int_2");
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.branchLabel`,
				) as HTMLInputElement
			).value,
		).toBe("trunk");
	});

	it("never offers an integration that isn't ACTIVE", () => {
		renderDialog({
			integrations: [
				...TWO_INTEGRATIONS,
				{
					id: "int_3",
					provider: "GITHUB",
					repositoryOwner: "example-org",
					repositoryName: "revoked",
					defaultBranch: "main",
					status: "REVOKED",
				},
			],
		});
		expect(screen.queryByText(/revoked/)).not.toBeInTheDocument();
	});
});

describe("ConfigureContextRepositorySyncDialog — paths chips validation", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("adds a valid path as a chip and clears the input", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs/guides");
		const chips = screen.getByTestId("context-sync-paths-chips");
		expect(within(chips).getByText("docs/guides")).toBeInTheDocument();
		expect(
			(
				screen.getByLabelText(
					`${NS}.configureDialog.pathsLabel`,
				) as HTMLInputElement
			).value,
		).toBe("");
	});

	it("removes a chip via its remove button", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		const chips = screen.getByTestId("context-sync-paths-chips");
		await user.click(
			within(chips).getByLabelText(
				`${NS}.configureDialog.removePath${JSON.stringify({ path: "docs" })}`,
			),
		);
		expect(within(chips).queryByText("docs")).not.toBeInTheDocument();
	});

	it("rejects a trailing slash inline, without adding a chip", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs/");
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: "docs/" })}`,
			),
		).toBeInTheDocument();
		expect(
			within(screen.getByTestId("context-sync-paths-chips")).queryByText(
				"docs/",
			),
		).not.toBeInTheDocument();
	});

	it("rejects a backslash inline", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs\\guides");
		expect(
			screen.getByText(
				`${NS}.pathErrors.INVALID_PATH${JSON.stringify({ path: "docs\\guides" })}`,
			),
		).toBeInTheDocument();
	});

	it("rejects an excluded basename (CLAUDE.md), case-insensitively", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs/claude.md");
		expect(
			screen.getByText(
				`${NS}.pathErrors.EXCLUDED_PATH${JSON.stringify({ path: "docs/claude.md" })}`,
			),
		).toBeInTheDocument();
	});

	it("rejects a path that overlaps one already selected", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await addPath(user, "docs/guides");
		expect(
			screen.getByText(
				`${NS}.pathErrors.PATH_PREFIX_OVERLAP${JSON.stringify({
					path: "docs/guides",
					withPath: "docs",
				})}`,
			),
		).toBeInTheDocument();
		const chips = screen.getByTestId("context-sync-paths-chips");
		expect(
			within(chips).queryByText("docs/guides"),
		).not.toBeInTheDocument();
	});

	it("only allows the whole-repository selection alone", async () => {
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await addPath(user, "");
		expect(
			screen.getByText(
				`${NS}.pathErrors.PATH_PREFIX_OVERLAP${JSON.stringify({
					path: "",
					withPath: "docs",
				})}`,
			),
		).toBeInTheDocument();
	});

	it("keeps Save disabled until at least one path is selected", async () => {
		const user = userEvent.setup();
		renderDialog();
		const submit = screen.getByText(`${NS}.configureDialog.submit`);
		expect(submit.closest("button")).toBeDisabled();
		await addPath(user, "docs");
		expect(submit.closest("button")).toBeEnabled();
	});
});

describe("ConfigureContextRepositorySyncDialog — submit", () => {
	beforeEach(() => {
		configureMock.mockReset();
		syncNowMock.mockReset();
	});

	it("calls configure then syncNow, then reports success and closes", async () => {
		configureMock.mockResolvedValue({ syncId: "sync_1", generation: 1 });
		syncNowMock.mockResolvedValue({ started: true });
		const user = userEvent.setup();
		const { onOpenChange, onSaved } = renderDialog();

		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		await waitFor(() =>
			expect(configureMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
				repositoryIntegrationId: "int_1",
				ref: "main",
				paths: ["docs"],
			}),
		);
		await waitFor(() =>
			expect(syncNowMock).toHaveBeenCalledWith({
				projectId: "proj_1",
				organizationId: "org_1",
			}),
		);
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
		expect(toast.success).toHaveBeenCalledWith(
			`${NS}.syncNowResult.started`,
		);
	});

	it("renders a server error code inline, attached to the branch field, and does not start syncNow", async () => {
		configureMock.mockRejectedValue({
			message: "server message",
			data: { code: "BRANCH_NOT_FOUND" },
		});
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		expect(
			await screen.findByText(
				`${NS}.configureDialog.errors.BRANCH_NOT_FOUND${JSON.stringify({
					path: "",
					withPath: "",
					managedCount: 0,
				})}`,
			),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText(`${NS}.configureDialog.branchLabel`),
		).toHaveAttribute("aria-invalid", "true");
		expect(syncNowMock).not.toHaveBeenCalled();
	});

	it("names the disconnect-first requirement for REPOSITORY_CHANGE_REQUIRES_DISCONNECT", async () => {
		configureMock.mockRejectedValue({
			message: "server message",
			data: {
				code: "REPOSITORY_CHANGE_REQUIRES_DISCONNECT",
				managedCount: 5,
			},
		});
		const user = userEvent.setup();
		renderDialog();
		await addPath(user, "docs");
		await user.click(screen.getByText(`${NS}.configureDialog.submit`));

		expect(
			await screen.findByText(
				`${NS}.configureDialog.errors.REPOSITORY_CHANGE_REQUIRES_DISCONNECT${JSON.stringify(
					{ path: "", withPath: "", managedCount: 5 },
				)}`,
			),
		).toBeInTheDocument();
		expect(syncNowMock).not.toHaveBeenCalled();
	});
});
