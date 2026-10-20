import { act, render, screen } from "@testing-library/react";
import { Suspense } from "react";
import { describe, expect, it, vi } from "vitest";

vi.mock("@saas/frames/components/FrameViewer", () => ({
	FrameViewer: ({
		frameId,
		organizationId,
	}: {
		frameId: string;
		organizationId?: string | null;
	}) => (
		<div data-testid="frame-viewer">
			{`${frameId}|${organizationId ?? "none"}`}
		</div>
	),
}));

vi.mock("@saas/organizations/hooks/use-organization-context", () => ({
	useOrganizationId: () => "org-1",
}));

import OrganizationFramePage from "../../../../app/(saas)/app/(organizations)/[organizationSlug]/frames/[frameId]/page";

describe("organization frame page route params", () => {
	it("reads frameId from the awaited params promise", async () => {
		// Arrange
		const params = Promise.resolve({ frameId: "frame-123" });

		// Act
		await act(async () => {
			render(
				<Suspense fallback={null}>
					<OrganizationFramePage params={params} />
				</Suspense>,
			);
		});

		// Assert
		expect((await screen.findByTestId("frame-viewer")).textContent).toBe(
			"frame-123|org-1",
		);
	});
});
