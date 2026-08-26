/**
 * The sync failure is a banner, and the raw provider body is NOT in it.
 *
 * Before this, the failure was one inline `<span>` in the freshness line. That
 * was fine while the error was short; once the clients started reporting the
 * real cause, the same line carried a classified explanation plus GitHub's raw
 * JSON and became the least readable thing on the screen.
 *
 * So the assertions here are about the SPLIT: the readable sentence is on
 * screen, the raw body is not until asked for, and the failing source is named
 * — which is the only thing that tells a multi-repo project which repo broke.
 *
 * next-intl is globally key-mocked in vitest.setup.ts (labels === keys).
 */

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { NAVIGATE_TO_SETTINGS_TAB_EVENT } from "../../../settings-tab-navigation";
import { SyncFailureBanner } from "../SyncFailureBanner";

const RAW =
	'{"message":"Resource not accessible by integration","status":"403"}';

const PROJECT_ID = "proj-1";

const failure = (overrides: Record<string, unknown> = {}) =>
	({
		tone: "warning" as const,
		total: false,
		failedCount: 1,
		sourceCount: 4,
		error: "GitHub authenticated the credential but refused this resource.",
		errorDetail: RAW,
		sourceLabel: "example-org/example-repo",
		reconnectFixes: false,
		...overrides,
	}) as never;

describe("SyncFailureBanner", () => {
	it("is a banner, not a line of text", () => {
		render(
			<SyncFailureBanner failure={failure()} projectId={PROJECT_ID} />,
		);

		expect(screen.getByRole("alert")).toBeInTheDocument();
	});

	it("shows the readable sentence and names the failing source", () => {
		render(
			<SyncFailureBanner failure={failure()} projectId={PROJECT_ID} />,
		);

		expect(
			screen.getByText(
				"GitHub authenticated the credential but refused this resource.",
			),
		).toBeInTheDocument();
		// Which repo broke — the whole point on a project with several connected.
		expect(
			screen.getByText("example-org/example-repo"),
		).toBeInTheDocument();
	});

	it("keeps the raw provider body OUT of the banner body", () => {
		// The regression this guards: the raw JSON inlined into the sentence.
		render(
			<SyncFailureBanner failure={failure()} projectId={PROJECT_ID} />,
		);

		expect(screen.queryByText(RAW)).not.toBeInTheDocument();
		expect(screen.getByText("showRawError")).toBeInTheDocument();
	});

	it("reveals the raw body on hover", async () => {
		const user = userEvent.setup();
		render(
			<SyncFailureBanner failure={failure()} projectId={PROJECT_ID} />,
		);

		await user.hover(screen.getByText("showRawError"));

		expect(await screen.findAllByText(RAW)).not.toHaveLength(0);
	});

	it("offers no raw-error control when there is nothing raw to show", () => {
		// Our own failures (no token, unreachable host) have no provider body;
		// a control that opens an empty tooltip is worse than no control.
		render(
			<SyncFailureBanner
				failure={failure({ errorDetail: null })}
				projectId={PROJECT_ID}
			/>,
		);

		expect(screen.queryByText("showRawError")).not.toBeInTheDocument();
	});

	it("uses the error title only when EVERY source failed", () => {
		render(
			<SyncFailureBanner
				failure={failure({ total: true, tone: "error" })}
				projectId={PROJECT_ID}
			/>,
		);

		expect(screen.getByText("sourceErrorTitle")).toBeInTheDocument();
		expect(
			screen.queryByText("sourcePartialErrorTitle"),
		).not.toBeInTheDocument();
	});

	it("reaches the raw body by keyboard, not hover alone", () => {
		// A hover-only affordance hides the debugging detail from anyone not
		// using a mouse. The trigger is a real button so focus opens it too.
		render(
			<SyncFailureBanner failure={failure()} projectId={PROJECT_ID} />,
		);

		expect(
			screen.getByRole("button", { name: "showRawError" }),
		).toBeInTheDocument();
	});
});

// ----------------------------------------------------------------------------
// Reconnect link (card #2383)
// ----------------------------------------------------------------------------

describe("SyncFailureBanner — reconnect link", () => {
	it("offers no reconnect link when reconnectFixes is false (e.g. PERMISSION_MISSING)", () => {
		render(
			<SyncFailureBanner
				failure={failure({ reconnectFixes: false })}
				projectId={PROJECT_ID}
			/>,
		);

		expect(
			screen.queryByRole("button", { name: "reconnectCta" }),
		).not.toBeInTheDocument();
	});

	it("renders a reconnect link when reconnectFixes is true (e.g. CREDENTIAL_REJECTED)", () => {
		render(
			<SyncFailureBanner
				failure={failure({ reconnectFixes: true })}
				projectId={PROJECT_ID}
			/>,
		);

		expect(
			screen.getByRole("button", { name: "reconnectCta" }),
		).toBeInTheDocument();
	});

	it("navigates to the project's Settings ▸ Development tab on click", async () => {
		const user = userEvent.setup();
		const received: CustomEvent[] = [];
		const handler = (event: Event) => {
			received.push(event as CustomEvent);
		};
		window.addEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);

		try {
			render(
				<SyncFailureBanner
					failure={failure({ reconnectFixes: true })}
					projectId={PROJECT_ID}
				/>,
			);

			await user.click(
				screen.getByRole("button", { name: "reconnectCta" }),
			);

			expect(
				sessionStorage.getItem(
					`fabric-project-settings-tab-${PROJECT_ID}`,
				),
			).toBe("development");
			expect(received).toHaveLength(1);
			expect(received[0].detail).toEqual({
				projectId: PROJECT_ID,
				settingsTab: "development",
			});
		} finally {
			window.removeEventListener(NAVIGATE_TO_SETTINGS_TAB_EVENT, handler);
		}
	});
});
