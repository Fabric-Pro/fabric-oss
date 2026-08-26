import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";

const { listMeetingReferences } = vi.hoisted(() => ({
	listMeetingReferences: vi.fn(),
}));

vi.mock("@shared/lib/orpc-client", () => ({
	orpcClient: {
		projects: { stories: { listMeetingReferences } },
	},
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationContext: () => ({ basePath: "/app/acme" }),
}));

import { StoryMeetingReferencesButton } from "../StoryMeetingReferencesButton";

function wrapper({ children }: { children: ReactNode }) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

function renderButton() {
	return render(
		<StoryMeetingReferencesButton
			storyId="s1"
			storyIdentifier="F-101"
			projectId="p1"
			organizationId="org1"
		/>,
		{ wrapper },
	);
}

const reference = {
	linkId: "l1",
	itemKey: "key-a",
	itemText: "Bob to ship the digest download",
	origin: "AUTO" as const,
	meetingSubject: "Weekly DSU",
	meetingDate: "2026-07-09T10:00:00.000Z",
	transcriptRef: "graph-tr-1",
	projectId: "p1",
};

describe("StoryMeetingReferencesButton", () => {
	it("renders nothing when the work item has no references", async () => {
		listMeetingReferences.mockResolvedValue({ references: [] });

		const { container } = renderButton();

		await waitFor(() => expect(listMeetingReferences).toHaveBeenCalled());
		// No dead chrome for projects that do not use meeting linking — this is
		// also the flag-off shape, since the procedure returns [] when it is off.
		expect(container).toBeEmptyDOMElement();
	});

	it("shows a count badge for the references it has", async () => {
		listMeetingReferences.mockResolvedValue({
			references: [reference, { ...reference, linkId: "l2" }],
		});

		renderButton();

		expect(
			await screen.findByRole("button", {
				name: "Referenced in 2 meetings",
			}),
		).toBeInTheDocument();
	});

	it("uses the singular for one reference", async () => {
		listMeetingReferences.mockResolvedValue({ references: [reference] });

		renderButton();

		expect(
			await screen.findByRole("button", {
				name: "Referenced in 1 meeting",
			}),
		).toBeInTheDocument();
	});

	it("lists the meeting name and the action item text (AC4)", async () => {
		listMeetingReferences.mockResolvedValue({ references: [reference] });

		renderButton();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Referenced in 1 meeting",
			}),
		);

		expect(
			await screen.findByText("Bob to ship the digest download"),
		).toBeInTheDocument();
		expect(screen.getByText(/Weekly DSU/)).toBeInTheDocument();
	});

	it("deep-links back to the action item in the digest (AC5)", async () => {
		listMeetingReferences.mockResolvedValue({ references: [reference] });

		renderButton();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Referenced in 1 meeting",
			}),
		);

		expect(
			await screen.findByRole("link", { name: "Open in meeting digest" }),
		).toHaveAttribute(
			"href",
			"/app/acme/projects/p1?tab=meeting-digest&meeting=graph-tr-1&actionItem=key-a",
		);
	});

	it("still renders a reference whose meeting has no subject or date", async () => {
		listMeetingReferences.mockResolvedValue({
			references: [
				{ ...reference, meetingSubject: null, meetingDate: null },
			],
		});

		renderButton();
		fireEvent.click(
			await screen.findByRole("button", {
				name: "Referenced in 1 meeting",
			}),
		);

		expect(await screen.findByText("Untitled meeting")).toBeInTheDocument();
	});
});

describe("freshness (DEF-2)", () => {
	it("reads live, not from the global stale cache", async () => {
		// Links are added and removed in the meeting digest — a different
		// surface — so this component never observes the mutation that should
		// invalidate it. Found in staging QA: after reviving a link, a work item
		// page that had been visited before showed no back-reference button at
		// all until a hard reload. Mirrors the getMeeting precedent (#1823).
		const { readFileSync } = await import("node:fs");
		const { resolve } = await import("node:path");
		const source = readFileSync(
			resolve(__dirname, "../StoryMeetingReferencesButton.tsx"),
			"utf8",
		);
		expect(source).toContain("staleTime: 0");
		expect(source).toContain('refetchOnMount: "always"');
	});
});
