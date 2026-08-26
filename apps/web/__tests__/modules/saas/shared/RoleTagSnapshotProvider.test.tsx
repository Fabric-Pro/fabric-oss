import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	RoleTagSnapshotProvider,
	useRoleTagSnapshot,
} from "@saas/shared/components/RoleTagSnapshotProvider";

function Probe() {
	const snapshot = useRoleTagSnapshot();
	return <span data-testid="snapshot">{String(snapshot)}</span>;
}

describe("RoleTagSnapshotProvider", () => {
	it.each([
		[false, "false"],
		[true, "true"],
		[null, "null"],
	])("delivers %s to consumers", (value, expected) => {
		render(
			<RoleTagSnapshotProvider value={value}>
				<Probe />
			</RoleTagSnapshotProvider>,
		);
		expect(screen.getByTestId("snapshot")).toHaveTextContent(expected);
	});

	it("returns null outside a provider rather than throwing", () => {
		render(<Probe />);
		expect(screen.getByTestId("snapshot")).toHaveTextContent("null");
	});
});
