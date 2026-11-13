/**
 * Tests for `InstructionTemplateForm` — the organization's choice of the
 * project whose coding instructions its other projects can start from.
 *
 * Pinned here:
 *
 *   1. Only admins and owners see it: the server refuses everyone else for the
 *      read and the write, so nobody else is asked or shown a failure.
 *   2. Saving sends exactly the chosen project, and "No template" sends null.
 *   3. The picker offers the setting's own `candidates`, the projects the
 *      server accepts, and says which have nothing published yet.
 *   4. A template that is no longer a candidate is still shown by the name the
 *      setting returns, so the form never offers to clear it by accident.
 *   5. A refused save is worded by its code, never by the server's message.
 *
 * `@tanstack/react-query` is real, as in `AttachmentRetentionForm.test.tsx`.
 * Radix Select is replaced with a native `<select>`, as in
 * `AdoReviewInstructionFields.test.tsx`: jsdom cannot drive its pointer
 * events, and what is under test is the value the form saves.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	get: vi.fn(),
	update: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
	admin: true,
}));

vi.mock("next-intl", async () =>
	(await import("@saas/projects/__tests__/en-copy")).nextIntlMock(),
);

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			instructionTemplate: {
				get: (input: unknown) => mocks.get(input),
				update: (input: unknown) => mocks.update(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "org-1", slug: "example-org" },
		isOrganizationAdmin: mocks.admin,
	}),
}));

vi.mock("sonner", () => ({
	toast: {
		success: (...args: unknown[]) => mocks.toastSuccess(...args),
		error: (...args: unknown[]) => mocks.toastError(...args),
	},
}));

vi.mock("@ui/components/select", () => ({
	Select: ({
		value,
		onValueChange,
		children,
		disabled,
	}: {
		value: string;
		onValueChange: (value: string) => void;
		children: ReactNode;
		disabled?: boolean;
	}) => (
		<select
			aria-label="Template project"
			value={value}
			disabled={disabled}
			onChange={(event) => onValueChange(event.target.value)}
		>
			{children}
		</select>
	),
	SelectContent: ({ children }: { children: ReactNode }) => <>{children}</>,
	SelectItem: ({
		value,
		children,
	}: {
		value: string;
		children: ReactNode;
	}) => <option value={value}>{children}</option>,
	SelectTrigger: () => null,
	SelectValue: () => null,
}));

import { InstructionTemplateForm } from "@saas/organizations/components/InstructionTemplateForm";

const CANDIDATES = [
	{ id: "proj-a", name: "Example platform", published: true },
	{ id: "proj-b", name: "Example service", published: true },
	{ id: "proj-c", name: "Example tools", published: false },
];

function setting(
	template: { projectId: string; projectName: string } | null,
	candidates = CANDIDATES,
) {
	return {
		projectId: template?.projectId ?? null,
		projectName: template?.projectName ?? null,
		candidates,
	};
}

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	mocks.admin = true;
	mocks.get.mockResolvedValue(setting(null));
	mocks.update.mockImplementation(
		async (input: { projectId: string | null }) => ({
			success: true,
			projectId: input.projectId,
		}),
	);
});

describe("InstructionTemplateForm", () => {
	it("renders nothing and asks nothing for a member who is not an admin", () => {
		mocks.admin = false;
		const { container } = render(<InstructionTemplateForm />, { wrapper });

		expect(container).toBeEmptyDOMElement();
		expect(mocks.get).not.toHaveBeenCalled();
	});

	it("offers the projects the server accepts, marking those with nothing published", async () => {
		render(<InstructionTemplateForm />, { wrapper });

		await screen.findByLabelText("Template project");
		expect(
			screen.getAllByRole("option").map((option) => option.textContent),
		).toEqual([
			"No template",
			"Example platform",
			"Example service",
			"Example tools (nothing published yet)",
		]);
	});

	it("says so when no project can be the template", async () => {
		mocks.get.mockResolvedValue(setting(null, []));
		render(<InstructionTemplateForm />, { wrapper });

		expect(
			await screen.findByText(
				"No project in this organization uploads its coding instructions to Fabric yet.",
			),
		).toBeInTheDocument();
	});

	it("saves the chosen project as the template", async () => {
		render(<InstructionTemplateForm />, { wrapper });

		const select = await screen.findByLabelText("Template project");
		expect(select).toHaveValue("none");
		const save = screen.getByRole("button", { name: "Save" });
		expect(save).toBeDisabled();

		fireEvent.change(select, { target: { value: "proj-b" } });
		fireEvent.click(save);

		await waitFor(() =>
			expect(mocks.update).toHaveBeenCalledWith({
				organizationId: "org-1",
				projectId: "proj-b",
			}),
		);
		await waitFor(() =>
			expect(mocks.toastSuccess).toHaveBeenCalledWith(
				"The coding instructions template was saved",
			),
		);
	});

	it("words a refused save by its code, not by the server's message", async () => {
		mocks.update.mockRejectedValue(
			Object.assign(new Error("TEXT THAT MUST NOT BE SHOWN"), {
				code: "PRECONDITION_FAILED",
			}),
		);
		render(<InstructionTemplateForm />, { wrapper });

		const select = await screen.findByLabelText("Template project");
		fireEvent.change(select, { target: { value: "proj-a" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mocks.toastError).toHaveBeenCalledWith(
				"That project's coding instructions come from a repository now. Choose a project whose instructions are uploaded to Fabric.",
			),
		);
	});

	it("clears the template with No template", async () => {
		mocks.get.mockResolvedValue(
			setting({ projectId: "proj-a", projectName: "Example platform" }),
		);
		render(<InstructionTemplateForm />, { wrapper });

		const select = await screen.findByLabelText("Template project");
		await waitFor(() => expect(select).toHaveValue("proj-a"));
		fireEvent.change(select, { target: { value: "none" } });
		fireEvent.click(screen.getByRole("button", { name: "Save" }));

		await waitFor(() =>
			expect(mocks.update).toHaveBeenCalledWith({
				organizationId: "org-1",
				projectId: null,
			}),
		);
	});

	it("keeps a template that is no longer a candidate as a choice, by its name", async () => {
		mocks.get.mockResolvedValue(
			setting({
				projectId: "proj-hidden",
				projectName: "Example hidden project",
			}),
		);
		render(<InstructionTemplateForm />, { wrapper });

		const select = await screen.findByLabelText("Template project");
		await waitFor(() => expect(select).toHaveValue("proj-hidden"));
		expect(
			screen.getByRole("option", { name: "Example hidden project" }),
		).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("says when the setting cannot be loaded", async () => {
		mocks.get.mockRejectedValue(new Error("offline"));
		render(<InstructionTemplateForm />, { wrapper });

		// The form retries a failed read once, after react-query's 1 s delay.
		expect(
			await screen.findByText(
				"Failed to load the coding instructions template",
				undefined,
				{ timeout: 4000 },
			),
		).toBeInTheDocument();
	});
});
