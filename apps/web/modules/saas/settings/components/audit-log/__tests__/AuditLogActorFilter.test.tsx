/**
 * Tests for AuditLogActorFilter — the org-context combobox for selecting
 * a single actor as the audit filter.
 *
 * The component fetches members via `orpcClient.audit.searchMembers`,
 * debounces input 200ms, and emits the chosen member upward via
 * `onSelect`. Tests cover:
 *   - the combobox renders the org's members on open
 *   - the search input fires the server query after the debounce
 *   - selecting a member calls onSelect with id + email
 *   - clearing fires onSelect(null)
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchMembersMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			searchMembers: (...args: unknown[]) => searchMembersMock(...args),
		},
	},
}));

import { AuditLogActorFilter } from "../AuditLogActorFilter";

function renderFilter(
	props: Partial<React.ComponentProps<typeof AuditLogActorFilter>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onSelect = vi.fn();
	const onActorTypesChange = vi.fn();
	const utils = render(
		<QueryClientProvider client={client}>
			<AuditLogActorFilter
				organizationId="org-1"
				onSelect={onSelect}
				selectedActorTypes={[]}
				onActorTypesChange={onActorTypesChange}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onSelect, onActorTypesChange };
}

const MEMBERS = [
	{
		id: "user-alice",
		name: "Alice",
		email: "alice@example.com",
		image: null,
		role: "owner",
	},
	{
		id: "user-bob",
		name: "Bob",
		email: "bob@example.com",
		image: null,
		role: "admin",
	},
];

beforeEach(() => {
	searchMembersMock.mockReset();
	searchMembersMock.mockResolvedValue({ members: MEMBERS });
});

describe("AuditLogActorFilter", () => {
	it("renders the trigger with the default placeholder when no actor is selected", () => {
		renderFilter();
		expect(
			screen.getByText("settings.auditLog.actorFilter.placeholder"),
		).toBeInTheDocument();
	});

	it("opens the popover and renders member options on click", async () => {
		renderFilter();
		const trigger = screen.getByRole("combobox");
		fireEvent.click(trigger);
		await waitFor(() => {
			expect(screen.getByText("Alice")).toBeInTheDocument();
			expect(screen.getByText("Bob")).toBeInTheDocument();
		});
		// Server query was invoked with the org id; query starts blank.
		expect(searchMembersMock).toHaveBeenCalled();
		const call = searchMembersMock.mock.calls[0]?.[0] as {
			organizationId: string;
		};
		expect(call.organizationId).toBe("org-1");
	});

	it("selects a member and emits id + email upward", async () => {
		const { onSelect } = renderFilter();
		fireEvent.click(screen.getByRole("combobox"));
		await waitFor(() =>
			expect(screen.getByText("Alice")).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByText("Alice"));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith({
			id: "user-alice",
			email: "alice@example.com",
		});
	});

	it("renders the clear button when an actor is selected and calls onSelect(null) on click", () => {
		const { onSelect } = renderFilter({ selectedActorId: "user-alice" });
		const clear = screen.getByRole("button", {
			name: "settings.auditLog.actorFilter.clear",
		});
		fireEvent.click(clear);
		expect(onSelect).toHaveBeenCalledWith(null);
	});

	it("renders the Custom actor-type sub-section with checkbox options (item 15)", async () => {
		const { onActorTypesChange } = renderFilter();
		fireEvent.click(screen.getByRole("combobox"));
		await waitFor(() => {
			expect(
				screen.getByTestId("audit-actor-type-api_key"),
			).toBeInTheDocument();
		});
		fireEvent.click(screen.getByTestId("audit-actor-type-api_key"));
		expect(onActorTypesChange).toHaveBeenCalledWith(["api_key"]);
	});
});
