/**
 * The credential manager's "Add credential" dialog with a GitHub token the
 * server refuses (`checkGitHubTokenForSave`): a classic token short of a
 * scope keeps the form open with each required scope marked ✓ or ✗, and a
 * fine-grained token is saved only after "I've granted these" is ticked.
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const m = vi.hoisted(() => ({ create: vi.fn(), toastError: vi.fn() }));

vi.mock("sonner", () => ({
	toast: { success: vi.fn(), error: m.toastError, info: vi.fn() },
}));
vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({ isOrganizationAdmin: false }),
}));
vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		credentialManager: { create: (input: unknown) => m.create(input) },
	},
}));

import { AddCredentialDialog } from "../AddCredentialDialog";

function refusal(message: string, data: Record<string, unknown>) {
	return Object.assign(new Error(message), { code: "BAD_REQUEST", data });
}

const MISSING = refusal("This token is missing: workflow, admin:org.", {
	reason: "GITHUB_TOKEN_MISSING_SCOPES",
	tokenType: "classic",
	required: ["repo", "workflow", "admin:org"],
	missing: ["workflow", "admin:org"],
});

const CONFIRM = refusal("Confirm the permissions.", {
	reason: "GITHUB_TOKEN_CONFIRM_PERMISSIONS",
	tokenType: "fine-grained",
	permissions: [
		{ name: "Contents", access: "write" },
		{ name: "Metadata", access: "read" },
	],
	canListRepositories: true,
});

async function openAndFill() {
	const user = userEvent.setup();
	const onCreated = vi.fn();
	const client = new QueryClient();
	render(
		<QueryClientProvider client={client}>
			<AddCredentialDialog organizationId="org-1" onCreated={onCreated} />
		</QueryClientProvider>,
	);
	await user.click(screen.getByRole("button", { name: "Add credential" }));
	await user.type(screen.getByLabelText("Name"), "Full Fabric");
	await user.type(screen.getByLabelText("Token"), "ghp_example_value");
	return { user, onCreated };
}

beforeEach(() => {
	m.create.mockReset();
	m.toastError.mockReset();
});

describe("AddCredentialDialog: GitHub token check", () => {
	it("lists each required scope with ✓ or ✗ and keeps the form open", async () => {
		m.create.mockRejectedValue(MISSING);
		const { user, onCreated } = await openAndFill();
		await user.click(screen.getByRole("button", { name: "Save" }));

		const scopes = await screen.findByRole("list", {
			name: "Required scopes",
		});
		const items = within(scopes).getAllByRole("listitem");
		expect(items.map((li) => li.textContent)).toEqual([
			"repogranted",
			"workflowmissing",
			"admin:orgmissing",
		]);
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(m.toastError).not.toHaveBeenCalled();
		expect(onCreated).not.toHaveBeenCalled();

		// A new token clears the old answer.
		await user.type(screen.getByLabelText("Token"), "x");
		expect(
			screen.queryByRole("list", { name: "Required scopes" }),
		).not.toBeInTheDocument();
	});

	it("saves a fine-grained token only after its permissions are confirmed", async () => {
		m.create.mockRejectedValueOnce(CONFIRM).mockResolvedValueOnce({
			credential: { id: "cred-1", label: "Full Fabric" },
		});
		const { user, onCreated } = await openAndFill();
		await user.click(screen.getByRole("button", { name: "Save" }));

		expect(
			await screen.findByText(/can't be checked before use/),
		).toBeInTheDocument();
		expect(
			screen.getByRole("list", { name: "Repository permissions" }),
		).toHaveTextContent("ContentsRead and write");
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();

		await user.click(
			screen.getByRole("checkbox", { name: "I've granted these" }),
		);
		expect(save).toBeEnabled();
		await user.click(save);

		await vi.waitFor(() =>
			expect(onCreated).toHaveBeenCalledWith({
				id: "cred-1",
				label: "Full Fabric",
			}),
		);
		expect(m.create).toHaveBeenLastCalledWith(
			expect.objectContaining({ confirmFineGrainedPermissions: true }),
		);
	});

	it("shows any other refusal as a toast, as before", async () => {
		m.create.mockRejectedValue(new Error("GitHub rejected this token."));
		const { user } = await openAndFill();
		await user.click(screen.getByRole("button", { name: "Save" }));
		await vi.waitFor(() =>
			expect(m.toastError).toHaveBeenCalledWith(
				"Could not save the credential",
				{ description: "GitHub rejected this token." },
			),
		);
	});
});
