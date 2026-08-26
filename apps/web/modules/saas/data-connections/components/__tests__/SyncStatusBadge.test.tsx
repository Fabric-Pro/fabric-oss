/**
 * Tests for SyncStatusBadge.
 *
 * The badge must expose a "Sync status: ..." prefix in its aria-label so
 * screen-reader users can disambiguate it from the neighbouring
 * `ProviderHealthBadge` ("... status: ..."). The label is overridable for
 * host components that already provide their own labelled region.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { SyncStatusBadge } from "../SyncStatusBadge";

describe("SyncStatusBadge", () => {
	it("renders an aria-label prefixed with `Sync status:`", () => {
		render(<SyncStatusBadge status="CONNECTED" />);
		const badge = screen.getByRole("status");
		expect(badge.getAttribute("aria-label")).toMatch(/^Sync status:/);
	});

	it("uses a different label per status", () => {
		const labels = new Set<string>();
		const statuses: Array<
			"PENDING" | "CONNECTED" | "SYNCING" | "ERROR" | "PAUSED" | "EXPIRED"
		> = ["PENDING", "CONNECTED", "SYNCING", "ERROR", "PAUSED", "EXPIRED"];
		for (const status of statuses) {
			const { unmount } = render(<SyncStatusBadge status={status} />);
			const aria = screen.getByRole("status").getAttribute("aria-label");
			expect(aria).toBeTruthy();
			if (aria) {
				labels.add(aria);
			}
			unmount();
		}
		expect(labels.size).toBe(statuses.length);
	});

	it("respects an explicit aria-label override", () => {
		render(
			<SyncStatusBadge
				status="ERROR"
				aria-label="Latest sync attempt failed"
			/>,
		);
		expect(screen.getByRole("status").getAttribute("aria-label")).toBe(
			"Latest sync attempt failed",
		);
	});
});
