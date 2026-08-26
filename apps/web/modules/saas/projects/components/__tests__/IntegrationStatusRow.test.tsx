import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { IntegrationStatusRow } from "../ProjectRepositoryIntegrationSettings";

const baseIntegration = {
	id: "int-1",
	status: "TOKEN_EXPIRED",
	provider: "GITHUB",
	repositoryOwner: "acme",
	repositoryName: "app",
};

function renderRow(
	overrides: Partial<React.ComponentProps<typeof IntegrationStatusRow>> = {},
) {
	const onReconnect = vi.fn();
	const onEdit = vi.fn();
	const onDisconnect = vi.fn();
	render(
		<QueryClientProvider client={new QueryClient()}>
			<IntegrationStatusRow
				integration={baseIntegration}
				projectId="proj-1"
				organizationId={null}
				canManageIntegrations
				onReconnect={onReconnect}
				onEdit={onEdit}
				onDisconnect={onDisconnect}
				isDisconnecting={false}
				{...overrides}
			/>
		</QueryClientProvider>,
	);
	return { onReconnect, onEdit, onDisconnect };
}

async function openMenu() {
	const user = userEvent.setup({ pointerEventsCheck: 0 });
	await user.click(screen.getByRole("button", { name: /manage acme\/app/i }));
	return user;
}

describe("IntegrationStatusRow actions menu", () => {
	it("renders no menu trigger when the user cannot manage integrations", () => {
		renderRow({ canManageIntegrations: false });
		expect(
			screen.queryByRole("button", { name: /manage acme\/app/i }),
		).toBeNull();
	});

	it("shows Reconnect, Edit branch, and Disconnect for a GitHub row", async () => {
		renderRow();
		await openMenu();
		expect(
			screen.getByRole("menuitem", { name: /reconnect/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /edit branch/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /disconnect/i }),
		).toBeInTheDocument();
	});

	it("hides Reconnect for an Azure DevOps row (Edit + Disconnect remain)", async () => {
		renderRow({
			integration: { ...baseIntegration, provider: "AZURE_DEVOPS" },
		});
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /reconnect/i }),
		).toBeNull();
		expect(
			screen.getByRole("menuitem", { name: /edit branch/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /disconnect/i }),
		).toBeInTheDocument();
	});

	it("hides Reconnect and Edit for a legacy row (Disconnect only)", async () => {
		renderRow({ isLegacy: true });
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /reconnect/i }),
		).toBeNull();
		expect(
			screen.queryByRole("menuitem", { name: /edit branch/i }),
		).toBeNull();
		expect(
			screen.getByRole("menuitem", { name: /disconnect/i }),
		).toBeInTheDocument();
	});

	it("hides Reconnect and Edit when the branch is unknown (Disconnect only)", async () => {
		// branchKnown=false models a project-payload fallback row (rendered before
		// the canonical list resolves, or if it fails) that lacks defaultBranch.
		renderRow({ branchKnown: false });
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /reconnect/i }),
		).toBeNull();
		expect(
			screen.queryByRole("menuitem", { name: /edit branch/i }),
		).toBeNull();
		expect(
			screen.getByRole("menuitem", { name: /disconnect/i }),
		).toBeInTheDocument();
	});

	it("invokes the callbacks for each action", async () => {
		const { onReconnect, onEdit, onDisconnect } = renderRow();
		const user = await openMenu();
		await user.click(screen.getByRole("menuitem", { name: /reconnect/i }));
		expect(onReconnect).toHaveBeenCalledTimes(1);

		await user.click(
			screen.getByRole("button", { name: /manage acme\/app/i }),
		);
		await user.click(
			screen.getByRole("menuitem", { name: /edit branch/i }),
		);
		expect(onEdit).toHaveBeenCalledTimes(1);

		await openMenu();
		await user.click(screen.getByRole("menuitem", { name: /disconnect/i }));
		expect(onDisconnect).toHaveBeenCalledTimes(1);
	});

	it("shows 'Index codebase' in menu when codeIndex is canonical null", async () => {
		renderRow({
			featureCodeIndexingEnabled: true,
			integration: { ...baseIntegration, codeIndex: null },
		});
		await openMenu();
		expect(
			screen.getByRole("menuitem", { name: /index codebase/i }),
		).toBeInTheDocument();
	});

	it("shows 'Full re-index' in menu when codeIndex is undefined (fallback row)", async () => {
		renderRow({
			featureCodeIndexingEnabled: true,
			integration: { ...baseIntegration, codeIndex: undefined },
		});
		await openMenu();
		expect(
			screen.getByRole("menuitem", { name: /full re-index/i }),
		).toBeInTheDocument();
	});

	it("shows 'Full re-index' in menu when status is unavailable", async () => {
		renderRow({
			featureCodeIndexingEnabled: true,
			statusUnavailable: true,
			integration: { ...baseIntegration, codeIndex: null },
		});
		await openMenu();
		expect(
			screen.getByRole("menuitem", { name: /full re-index/i }),
		).toBeInTheDocument();
	});

	it("shows 'Full re-index' in menu when project carries a legacy index record", async () => {
		renderRow({
			featureCodeIndexingEnabled: true,
			hasLegacyIndexRecord: true,
			integration: { ...baseIntegration, codeIndex: null },
		});
		await openMenu();
		expect(
			screen.getByRole("menuitem", { name: /full re-index/i }),
		).toBeInTheDocument();
	});
});

// ----------------------------------------------------------------------------
// Pipeline sync health (card #2383)
// ----------------------------------------------------------------------------

describe("IntegrationStatusRow — pipeline sync health", () => {
	it("renders nothing when syncHealth is null (QA off, or never synced)", () => {
		renderRow({ syncHealth: null });
		expect(screen.queryByText(/pipeline sync/i)).toBeNull();
	});

	it("shows the failure sentence and a Reconnect button for a rejected credential (GitHub)", () => {
		renderRow({
			syncHealth: {
				lastFetchedAt: null,
				status: "FAILED",
				lastError:
					"GitHub rejected the credential as invalid or expired — reconnect the repository in Settings ▸ Development.",
				lastErrorKind: "CREDENTIAL_REJECTED",
			},
		});
		expect(screen.getByText(/pipeline sync failing/i)).toBeInTheDocument();
		expect(
			screen.getByText(/rejected the credential as invalid or expired/i),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /reconnect/i }),
		).toBeInTheDocument();
	});

	it("shows the failure sentence WITHOUT a Reconnect button for a missing permission", () => {
		renderRow({
			syncHealth: {
				lastFetchedAt: null,
				status: "FAILED",
				lastError:
					'GitHub authenticated the credential but refused this resource — it is missing the "Actions: read" permission.',
				lastErrorKind: "PERMISSION_MISSING",
			},
		});
		expect(screen.getByText(/pipeline sync failing/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
	});

	it("shows no Reconnect button for a rejected credential on Azure DevOps (no in-app reconnect flow)", () => {
		// reconnectFixes is true for CREDENTIAL_REJECTED, but ADO has no
		// `onReconnect` action on this page at all (canReconnect is GH/GL only).
		renderRow({
			integration: { ...baseIntegration, provider: "AZURE_DEVOPS" },
			syncHealth: {
				lastFetchedAt: null,
				status: "FAILED",
				lastError: "Azure DevOps rejected the credential.",
				lastErrorKind: "CREDENTIAL_REJECTED",
			},
		});
		expect(screen.getByText(/pipeline sync failing/i)).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
	});

	it("invokes onReconnect when the sync-health Reconnect button is clicked", async () => {
		const user = userEvent.setup();
		const { onReconnect } = renderRow({
			syncHealth: {
				lastFetchedAt: null,
				status: "FAILED",
				lastError: "GitHub rejected the credential.",
				lastErrorKind: "CREDENTIAL_REJECTED",
			},
		});
		await user.click(screen.getByRole("button", { name: /reconnect/i }));
		expect(onReconnect).toHaveBeenCalledTimes(1);
	});

	it("shows the last-succeeded note when the sync is healthy", () => {
		renderRow({
			syncHealth: {
				lastFetchedAt: new Date(Date.now() - 5 * 60_000),
				status: "SUCCESS",
				lastError: null,
				lastErrorKind: null,
			},
		});
		expect(
			screen.getByText(/pipeline sync last succeeded/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/pipeline sync failing/i)).toBeNull();
	});

	// A viewer legitimately SEES this row — the sync-health read is gated at
	// TEST_CASE_READ, a viewer-tier permission — but cannot perform a
	// reconnect. Offering them a button that walks an OAuth round trip and
	// ends at a mutation they cannot authorise is worse than offering none.
	it("shows the failure sentence but NO Reconnect button for a viewer who cannot manage integrations", () => {
		renderRow({
			canManageIntegrations: false,
			syncHealth: {
				lastFetchedAt: null,
				status: "FAILED",
				lastError: "GitHub rejected the credential.",
				lastErrorKind: "CREDENTIAL_REJECTED",
			},
		});
		// The diagnosis still renders — knowing the sync is broken is exactly
		// what a viewer should be able to see.
		expect(screen.getByText(/pipeline sync failing/i)).toBeInTheDocument();
		expect(
			screen.getByText(/rejected the credential/i),
		).toBeInTheDocument();
		// Only the action is suppressed.
		expect(screen.queryByRole("button", { name: /reconnect/i })).toBeNull();
	});

	it("renders nothing when the sync has never succeeded or failed (lastFetchedAt null, status null)", () => {
		renderRow({
			syncHealth: {
				lastFetchedAt: null,
				status: null,
				lastError: null,
				lastErrorKind: null,
			},
		});
		expect(screen.queryByText(/pipeline sync/i)).toBeNull();
	});
});

// ----------------------------------------------------------------------------
// Status verdict + lastError surfacing (Fizzy #2252)
// ----------------------------------------------------------------------------

describe("IntegrationStatusRow — repo-access verdict", () => {
	it("renders the No-access badge, the install-app/PAT hint, and the stored cause for REPO_UNAVAILABLE", () => {
		renderRow({
			integration: {
				...baseIntegration,
				status: "REPO_UNAVAILABLE",
				lastError:
					"GitHub authenticated the credentials but refused this repository — the app may not be installed on it.",
			},
		});
		expect(screen.getByText("No access")).toBeInTheDocument();
		expect(
			screen.getByText(/install the provider app on it/i),
		).toBeInTheDocument();
		// The row also shows WHY (the writer's own explanation), not just the
		// per-status category.
		expect(
			screen.getByText(
				/refused this repository — the app may not be installed/i,
			),
		).toBeInTheDocument();
	});

	it("renders no cause line when lastError is absent", () => {
		renderRow({ integration: { ...baseIntegration, status: "ACTIVE" } });
		expect(screen.getByText("Active")).toBeInTheDocument();
		expect(screen.queryByText(/refused this repository/i)).toBeNull();
	});

	it("does NOT offer Reconnect for a No-access row — reconnecting fixes nothing there", async () => {
		renderRow({
			integration: {
				...baseIntegration,
				status: "REPO_UNAVAILABLE",
				lastError:
					"GitHub authenticated the credentials but refused this repository.",
			},
		});
		await openMenu();
		expect(
			screen.queryByRole("menuitem", { name: /reconnect/i }),
		).toBeNull();
		expect(
			screen.getByRole("menuitem", { name: /edit branch/i }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("menuitem", { name: /disconnect/i }),
		).toBeInTheDocument();
	});

	it("offers the attach-PAT remedy on a No-access row and opens its dialog (AC5)", async () => {
		const user = userEvent.setup({ pointerEventsCheck: 0 });
		renderRow({
			integration: {
				...baseIntegration,
				status: "REPO_UNAVAILABLE",
				lastError: "GitHub authenticated the credentials but refused…",
			},
		});
		await openMenu();
		const item = screen.getByRole("menuitem", {
			name: /connect with a token/i,
		});
		await user.click(item);

		// The dialog is the no-disconnect remedy the hint points at.
		expect(
			screen.getByText(/personal access token/i, { selector: "label" }),
		).toBeInTheDocument();
	});
});
