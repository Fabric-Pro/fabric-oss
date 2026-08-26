/**
 * Component tests for `AzureDevOpsPatRepoPicker` (Task Group 2 of the
 * Azure DevOps code-repository spec).
 *
 * Spec:
 * - fabric/specs/2026-05-27-azure-devops-code-repository/spec.md §3.8, §5.2, §9.2
 * - fabric/specs/2026-05-27-azure-devops-code-repository/tasks.md Task 2.2
 *
 * Scope (per tasks.md 2.2):
 *   (a) connect step renders a labeled `type="password"` PAT + org inputs.
 *   (b) invalid-PAT (401/403 → BAD_REQUEST) renders an inline error + retry.
 *   (c) grouped multi-select + local filter.
 *   (d) `onConfirm` emits the selected repos + creds; with a `projectId`,
 *       `repositoryIntegrations.connect` is called once per selected repo.
 *   (e) keyboard (Enter/Space) selects a repo row.
 *   (f) `aria-label`s present on the checkbox controls.
 */

import { render, screen, waitFor, within } from "@testing-library/react";
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
	if (typeof Element.prototype.hasPointerCapture === "undefined") {
		Element.prototype.hasPointerCapture = () => false;
	}
	if (typeof Element.prototype.scrollIntoView === "undefined") {
		Element.prototype.scrollIntoView = () => undefined;
	}
});

// ── Module mocks ─────────────────────────────────────────────────────────
const { listReposMock, connectMock } = vi.hoisted(() => ({
	listReposMock: vi.fn(),
	connectMock: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: {
			azureDevOps: {
				listRepos: (input: unknown) => listReposMock(input),
			},
			repositoryIntegrations: {
				connect: (input: unknown) => connectMock(input),
			},
		},
	},
}));

import {
	AzureDevOpsPatRepoPicker,
	type AzureDevOpsRepo,
} from "../AzureDevOpsPatRepoPicker";

// ── Fixtures ─────────────────────────────────────────────────────────────

function makeRepo(
	name: string,
	projectName: string,
	overrides: Partial<AzureDevOpsRepo> = {},
): AzureDevOpsRepo {
	const url = `https://dev.azure.com/acme/${projectName}/_git/${name}`;
	return {
		name,
		projectName,
		fullName: url,
		htmlUrl: url,
		defaultBranch: "main",
		isPrivate: true,
		language: null,
		...overrides,
	};
}

const GROUPED_RESULT = {
	configured: true,
	organization: "acme",
	error: null,
	groups: [
		{
			owner: "Platform",
			repos: [makeRepo("api", "Platform"), makeRepo("web", "Platform")],
		},
		{
			owner: "Mobile",
			repos: [makeRepo("ios", "Mobile")],
		},
	],
};

/** Drive the connect step: fill org + PAT, click Connect. */
async function connectWith(
	user: ReturnType<typeof userEvent.setup>,
	{ org = "acme", pat = "ado-pat-123" }: { org?: string; pat?: string } = {},
) {
	await user.type(
		screen.getByLabelText(/organization or repository url/i),
		org,
	);
	await user.type(screen.getByLabelText(/personal access token/i), pat);
	await user.click(screen.getByRole("button", { name: /^connect$/i }));
}

describe("AzureDevOpsPatRepoPicker", () => {
	beforeEach(() => {
		listReposMock.mockReset();
		connectMock.mockReset();
	});

	// ── (a) connect step renders labeled password PAT + org inputs ──────
	it("renders the connect step with a labeled type=password PAT input and an org input", () => {
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		const orgInput = screen.getByLabelText(
			/organization or repository url/i,
		);
		expect(orgInput).toBeInTheDocument();

		const patInput = screen.getByLabelText(/personal access token/i);
		expect(patInput).toBeInTheDocument();
		expect(patInput).toHaveAttribute("type", "password");
	});

	// ── (b) invalid PAT (401/403) → inline error + retry ────────────────
	it("shows an invalid-PAT error when listRepos rejects, then retries", async () => {
		listReposMock
			.mockRejectedValueOnce(
				new Error("Invalid PAT or insufficient permissions"),
			)
			.mockResolvedValueOnce(GROUPED_RESULT);

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		await connectWith(user);

		// Inline destructive message renders + we stay on the connect step.
		expect(
			await screen.findByText(/invalid pat or insufficient permissions/i),
		).toBeInTheDocument();
		expect(
			screen.getByLabelText(/personal access token/i),
		).toBeInTheDocument();

		// Retry: click Connect again → success → repo list renders. The
		// per-repo selection checkbox is a unique, stable signal that the list
		// step mounted ("Platform" appears both as the group header and as each
		// repo's project subtitle, so it is intentionally not unique).
		await user.click(screen.getByRole("button", { name: /^connect$/i }));

		expect(await screen.findByLabelText("Select api")).toBeInTheDocument();
		expect(listReposMock).toHaveBeenCalledTimes(2);
	});

	// ── (c) grouped multi-select + local filter ─────────────────────────
	it("renders grouped repos and filters them locally", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		await connectWith(user);

		// Both project groups render as headers; the first group is
		// auto-expanded so its repos' selection checkboxes are present.
		expect(
			await screen.findByRole("button", { name: /^platform/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^mobile/i }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("Select api")).toBeInTheDocument();
		expect(screen.getByLabelText("Select web")).toBeInTheDocument();

		// Local filter narrows the expanded group to the matching repo only.
		await user.type(
			screen.getByPlaceholderText(/filter repositories/i),
			"api",
		);
		expect(screen.getByLabelText("Select api")).toBeInTheDocument();
		expect(screen.queryByLabelText("Select web")).not.toBeInTheDocument();
		// "Mobile"'s only repo (ios) no longer matches → its group header
		// disappears from the filtered list.
		expect(
			screen.queryByRole("button", { name: /^mobile/i }),
		).not.toBeInTheDocument();
	});

	// ── (d) onConfirm emits repos + creds; connect called per repo ──────
	it("creates one integration per selected repo and emits onConfirm without creds (projectId present)", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);
		connectMock.mockResolvedValue({
			integration: { id: "int_1" },
			success: true,
		});
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={onOpenChange}
				projectId="proj_1"
				organizationId={null}
				onConfirm={onConfirm}
			/>,
		);

		await connectWith(user, { org: "acme", pat: "ado-pat-xyz" });

		// Select two repos in the auto-expanded "Platform" group.
		await user.click(await screen.findByLabelText("Select api"));
		await user.click(screen.getByLabelText("Select web"));

		await user.click(screen.getByRole("button", { name: /add 2 repos/i }));

		// One connect call per selected repo, with the canonical URL + creds.
		await waitFor(() => {
			expect(connectMock).toHaveBeenCalledTimes(2);
		});
		expect(connectMock).toHaveBeenCalledWith(
			expect.objectContaining({
				projectId: "proj_1",
				provider: "AZURE_DEVOPS",
				authMethod: "PAT",
				repositoryName: "api",
				repositoryUrl: "https://dev.azure.com/acme/Platform/_git/api",
				azureOrganization: "acme",
				pat: "ado-pat-xyz",
			}),
		);

		// onConfirm emits the selected repos only — the picker already connected
		// them, so no creds go back to the wizard; dialog closes.
		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});
		const [repos, creds] = onConfirm.mock.calls[0];
		expect(repos.map((r: AzureDevOpsRepo) => r.name).sort()).toEqual([
			"api",
			"web",
		]);
		expect(creds).toBeUndefined();
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("treats CONFLICT (already connected) as a non-fatal success and completes confirm", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);
		connectMock.mockRejectedValueOnce({
			code: "CONFLICT",
			message: "Repository is already connected",
		});
		const onConfirm = vi.fn();
		const onOpenChange = vi.fn();

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={onOpenChange}
				onConfirm={onConfirm}
				projectId="proj_1"
			/>,
		);

		await connectWith(user);
		await user.click(await screen.findByLabelText("Select api"));
		await user.click(screen.getByRole("button", { name: /add 1 repo/i }));

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});
		const [emittedRepos] = onConfirm.mock.calls[0];
		expect(emittedRepos.map((r: AzureDevOpsRepo) => r.name)).toEqual([
			"api",
		]);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("does NOT call connect when no projectId is present (defers to the wizard)", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);
		const onConfirm = vi.fn();

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={onConfirm}
			/>,
		);

		await connectWith(user);
		await user.click(await screen.findByLabelText("Select api"));
		await user.click(screen.getByRole("button", { name: /add 1 repo/i }));

		await waitFor(() => {
			expect(onConfirm).toHaveBeenCalledTimes(1);
		});
		expect(connectMock).not.toHaveBeenCalled();
		const [repos, creds] = onConfirm.mock.calls[0];
		expect(repos).toHaveLength(1);
		expect(repos[0].name).toBe("api");
		expect(creds.azureOrganization).toBe("acme");
	});

	// ── (e) keyboard (Enter/Space) selects a repo row ───────────────────
	it("selects a repo row via keyboard (Space)", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);
		const onConfirm = vi.fn();

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={onConfirm}
			/>,
		);

		await connectWith(user);
		await screen.findByText("api");

		// The repo row exposes role="button" + aria-pressed; focus it and press
		// Space to toggle selection (keyboard parity with the GitHub picker).
		const rows = screen.getAllByRole("button", { pressed: false });
		const apiRow = rows.find((row) => within(row).queryByText("api"));
		expect(apiRow).toBeDefined();
		(apiRow as HTMLElement).focus();
		await user.keyboard(" ");

		// Footer flips to "Add 1 Repo" once the row is selected via keyboard.
		expect(
			await screen.findByRole("button", { name: /add 1 repo/i }),
		).toBeInTheDocument();
	});

	// ── (f) aria-labels present on checkbox controls ────────────────────
	it("exposes aria-labels on the per-repo selection checkboxes", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		await connectWith(user);

		expect(await screen.findByLabelText("Select api")).toBeInTheDocument();
		expect(screen.getByLabelText("Select web")).toBeInTheDocument();
	});

	// ── org-parse error (no projectId path) ─────────────────────────────
	it("shows an org-parse error for a URL with no extractable organization", async () => {
		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		await connectWith(user, { org: "https://example.com/not-ado" });

		expect(
			await screen.findByText(
				/enter an organization or a dev\.azure\.com repo url/i,
			),
		).toBeInTheDocument();
		expect(listReposMock).not.toHaveBeenCalled();
	});

	it("binds error reason when connecting a repository fails", async () => {
		listReposMock.mockResolvedValue(GROUPED_RESULT);
		connectMock.mockRejectedValue(new Error("Invalid token permissions"));

		const user = userEvent.setup();
		render(
			<AzureDevOpsPatRepoPicker
				open
				projectId="p1"
				onOpenChange={vi.fn()}
				onConfirm={vi.fn()}
			/>,
		);

		await connectWith(user);
		await user.click(await screen.findByText("api"));
		await user.click(screen.getByRole("button", { name: /add 1 repo/i }));

		expect(
			await screen.findByText(
				/Could not connect: api \(Invalid token permissions\)/i,
			),
		).toBeInTheDocument();
	});
});
