/**
 * `OrganizationBrandKitForm` — the organization Brand kit (Fizzy #2589, R31):
 * accent colors and brand guidance, editable by admins and owners, read-only
 * for everyone else, and absent while the `GLOSSY_EDITION` gate is off.
 *
 * `@tanstack/react-query` is real rather than mocked, so the load, the save
 * and the refusal before submit all run through the component's own hooks.
 * `next-intl` is the global key-echo mock, so copy is asserted by key.
 */

import {
	FEATURE_FLAG_REGISTRY,
	type FeatureFlagKey,
} from "@repo/utils/feature-flag-registry";
import { FeatureFlagProvider } from "@saas/shared/components/FeatureFlagProvider";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { axe } from "vitest-axe";
import * as axeMatchers from "vitest-axe/matchers";

expect.extend(axeMatchers);

const state = vi.hoisted(() => ({
	role: "admin" as string | null,
	getMock: vi.fn(),
	updateMock: vi.fn(),
	toastSuccess: vi.fn(),
	toastError: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		organizations: {
			brandKit: {
				get: (input: unknown) => state.getMock(input),
				update: (input: unknown) => state.updateMock(input),
			},
		},
	},
}));

vi.mock("@saas/organizations/hooks/use-active-organization", () => ({
	useActiveOrganization: () => ({
		activeOrganization: { id: "org-1", name: "Example Org" },
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

function flags(overrides: Partial<Record<FeatureFlagKey, boolean>>) {
	const values = Object.fromEntries(
		Object.keys(FEATURE_FLAG_REGISTRY).map((key) => [key, false]),
	) as Record<FeatureFlagKey, boolean>;
	return { ...values, ...overrides };
}

function renderForm({ gate = true }: { gate?: boolean } = {}) {
	const client = new QueryClient({
		defaultOptions: {
			queries: { retry: false },
			mutations: { retry: false },
		},
	});
	return render(
		<FeatureFlagProvider value={flags({ GLOSSY_EDITION: gate })}>
			<QueryClientProvider client={client}>
				<OrganizationBrandKitForm />
			</QueryClientProvider>
		</FeatureFlagProvider>,
	);
}

const SAVED_KIT = {
	accentColors: ["#1a73e8"],
	guidance: "Plain, confident language.",
	updatedAt: new Date("2026-09-01T10:00:00.000Z"),
};

beforeEach(() => {
	vi.clearAllMocks();
	state.role = "admin";
	state.getMock.mockResolvedValue({ brandKit: SAVED_KIT });
	state.updateMock.mockImplementation(
		async (input: { accentColors: string[]; guidance: string | null }) => ({
			brandKit: {
				accentColors: input.accentColors,
				guidance: input.guidance,
				updatedAt: new Date("2026-09-02T10:00:00.000Z"),
			},
		}),
	);
});

describe("OrganizationBrandKitForm", () => {
	it("renders nothing and loads nothing while the Glossy gate is off", () => {
		const { container } = renderForm({ gate: false });

		expect(container).toBeEmptyDOMElement();
		expect(state.getMock).not.toHaveBeenCalled();
	});

	it("loads the saved accents and guidance", async () => {
		renderForm();

		expect(
			await screen.findByRole("textbox", { name: "accentHex" }),
		).toHaveValue("#1a73e8");
		expect(screen.getByLabelText("guidance")).toHaveValue(
			"Plain, confident language.",
		);
		expect(state.getMock).toHaveBeenCalledWith({ organizationId: "org-1" });
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

	it("saves valid accents, normalized, with the guidance", async () => {
		const user = userEvent.setup();
		renderForm();

		const accent = await screen.findByRole("textbox", {
			name: "accentHex",
		});
		await user.clear(accent);
		// Short form and upper case are accepted and normalized for the wire.
		await user.type(accent, "#ABC");
		await user.click(screen.getByRole("button", { name: "addAccent" }));
		const accents = screen.getAllByRole("textbox", { name: "accentHex" });
		await user.type(accents[1] as HTMLElement, "#0d9488");

		await user.click(screen.getByRole("button", { name: "save" }));

		await waitFor(() => expect(state.updateMock).toHaveBeenCalledTimes(1));
		expect(state.updateMock).toHaveBeenCalledWith({
			organizationId: "org-1",
			accentColors: ["#aabbcc", "#0d9488"],
			guidance: "Plain, confident language.",
		});
		await waitFor(() =>
			expect(state.toastSuccess).toHaveBeenCalledWith("saved"),
		);
	});

	it("offers no more than three accents", async () => {
		const user = userEvent.setup();
		renderForm();

		await screen.findByRole("textbox", { name: "accentHex" });
		await user.click(screen.getByRole("button", { name: "addAccent" }));
		await user.click(screen.getByRole("button", { name: "addAccent" }));

		expect(
			screen.getAllByRole("textbox", { name: "accentHex" }),
		).toHaveLength(3);
		expect(
			screen.queryByRole("button", { name: "addAccent" }),
		).not.toBeInTheDocument();
	});

	it("shows a member read-only fields and no save", async () => {
		state.role = "member";
		renderForm();

		expect(
			await screen.findByRole("textbox", { name: "accentHex" }),
		).toBeDisabled();
		expect(screen.getByLabelText("guidance")).toBeDisabled();
		expect(screen.getByText("readOnly")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "save" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "addAccent" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "removeAccent" }),
		).not.toBeInTheDocument();
	});

	it("has no axe violations for an admin", async () => {
		const { container } = renderForm();
		await screen.findByRole("textbox", { name: "accentHex" });

		expect(await axe(container)).toHaveNoViolations();
	});

	it("has no axe violations read-only, or with an invalid entry flagged", async () => {
		const user = userEvent.setup();
		const { container, unmount } = renderForm();
		const accent = await screen.findByRole("textbox", {
			name: "accentHex",
		});
		await user.clear(accent);
		await user.type(accent, "not-a-color");
		expect(await axe(container)).toHaveNoViolations();
		unmount();

		state.role = "member";
		const readOnly = renderForm();
		await screen.findByRole("textbox", { name: "accentHex" });
		expect(await axe(readOnly.container)).toHaveNoViolations();
	});
});
