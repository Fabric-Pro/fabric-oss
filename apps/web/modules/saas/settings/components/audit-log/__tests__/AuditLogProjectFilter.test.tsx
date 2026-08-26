/**
 * Tests for AuditLogProjectFilter — the org-context combobox for
 * narrowing audit events to a single project.
 *
 * Mirrors the shape of AuditLogActorFilter — fetches via
 * `orpcClient.audit.searchProjects`, selecting emits the project id +
 * name upward.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const searchProjectsMock = vi.fn();

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		audit: {
			searchProjects: (...args: unknown[]) => searchProjectsMock(...args),
		},
	},
}));

import { AuditLogProjectFilter } from "../AuditLogProjectFilter";

function renderFilter(
	props: Partial<React.ComponentProps<typeof AuditLogProjectFilter>> = {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onSelect = vi.fn();
	const utils = render(
		<QueryClientProvider client={client}>
			<AuditLogProjectFilter
				organizationId="org-1"
				onSelect={onSelect}
				{...props}
			/>
		</QueryClientProvider>,
	);
	return { ...utils, onSelect };
}

const PROJECTS = [
	{ id: "proj-1", name: "Alpha", icon: null },
	{ id: "proj-2", name: "Beta", icon: null },
];

beforeEach(() => {
	searchProjectsMock.mockReset();
	searchProjectsMock.mockResolvedValue({ projects: PROJECTS });
});

describe("AuditLogProjectFilter", () => {
	it("renders the trigger with the default placeholder when nothing selected", () => {
		renderFilter();
		expect(
			screen.getByText("settings.auditLog.projectFilter.placeholder"),
		).toBeInTheDocument();
	});

	it("opens and renders projects on click", async () => {
		renderFilter();
		fireEvent.click(screen.getByRole("combobox"));
		await waitFor(() => {
			expect(screen.getByText("Alpha")).toBeInTheDocument();
			expect(screen.getByText("Beta")).toBeInTheDocument();
		});
		// Server query was invoked with the org id.
		expect(searchProjectsMock).toHaveBeenCalled();
		const call = searchProjectsMock.mock.calls[0]?.[0] as {
			organizationId: string;
		};
		expect(call.organizationId).toBe("org-1");
	});

	it("selects a project and emits id + name", async () => {
		const { onSelect } = renderFilter();
		fireEvent.click(screen.getByRole("combobox"));
		await waitFor(() =>
			expect(screen.getByText("Alpha")).toBeInTheDocument(),
		);
		fireEvent.click(screen.getByText("Alpha"));
		expect(onSelect).toHaveBeenCalledTimes(1);
		expect(onSelect).toHaveBeenCalledWith({
			id: "proj-1",
			name: "Alpha",
		});
	});

	it("renders the clear button when a project is selected and calls onSelect(null) on click", () => {
		const { onSelect } = renderFilter({ selectedProjectId: "proj-1" });
		const clear = screen.getByRole("button", {
			name: "settings.auditLog.projectFilter.clear",
		});
		fireEvent.click(clear);
		expect(onSelect).toHaveBeenCalledWith(null);
	});
});
