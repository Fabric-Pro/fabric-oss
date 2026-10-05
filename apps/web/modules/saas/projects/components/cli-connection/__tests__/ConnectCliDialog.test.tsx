/**
 * Tests for `ConnectCliDialog` — the one place an API key is minted, and the
 * dialog that holds the only copy of it (Fizzy #2457, U7; Fizzy #2878). The
 * steps for each tool are pinned in `ConnectCliDialog.steps.test.tsx`.
 *
 * What is pinned here, and why each one is load-bearing:
 *
 *   1. Opening mints nothing. A curious click must leave no credential behind
 *      (R30), so the create control is the only thing that reaches the API, and
 *      before it is pressed there is no configuration on screen at all — not
 *      even one with a stand-in for the key.
 *   2. The scopes are exactly `["mcp:read"]` and there is no picker (R8).
 *      `scopeSatisfied` short-circuits on `mcp:write` and returns true for
 *      EVERY tool, so the procedure's default pair is a full-access grant. A
 *      test that only asserted "some scopes were sent" would let that back in.
 *   3. The organization id is the one passed in, never the session's active
 *      organization — those legitimately differ, and minting against the wrong
 *      tenant is silent when it happens.
 *   4. The configuration names `/api/mcp-gateway` and never the alternate
 *      `/mcp` host (R20), which answers an organization key with a successful
 *      connection and an empty tool list — a failure with nothing to read.
 *   5. The secret survives the caller's eligibility flipping to false. That
 *      flip really happens: the readiness query refetches after any successful
 *      mutation, so minting turns the caller's own gate off. If the view were
 *      inside that gated subtree it would unmount holding the only copy of a
 *      secret the server stores as a hash.
 *   6. A failed issuance leaves the view open (same reason inverted: closing on
 *      error throws away what the reader just read and makes them start over).
 *   7. Focus lands on the copy control when the configuration appears and
 *      returns to the invoking control on close (R31 / AE22).
 *   8. Once a key is minted and until its configuration has been copied,
 *      Escape, a click outside, the close button and the link out to settings
 *      are all disarmed, and the blocked dismissal is announced rather than
 *      silently swallowed. Closing destroys the only plaintext copy of the key
 *      — the server keeps a hash. "Done" stays a working exit: this is an
 *      accident guard, not a hostage situation. Copying anything else — the
 *      one-line setup, which carries no key — does not release it. And the
 *      "Copied" label going back to "Copy" does not re-arm it.
 *   9. Nothing here runs the starter instruction for the reader. Such a
 *      shortcut can only carry the prompt TEXT to a chat destination, never
 *      the configuration block, so it lands in a tool with no Fabric MCP
 *      server registered and fails with nothing to read.
 *
 * `@tanstack/react-query` is real rather than mocked: the mint path runs
 * mutate -> onSuccess -> state -> focus effect, and a stubbed `useMutation`
 * would let a broken pending or error branch pass.
 */

import { screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	clipboardWrite,
	configurationText,
	deferred,
	Host,
	installBrowserStubs,
	liveRegionText,
	mintKey,
	ORGANIZATION_ID,
	ORGANIZATION_SLUG,
	PROJECT_GATEWAY,
	PROJECT_NAME,
	RAW_KEY,
	renderHost,
	renderInstructions,
	renderWithQueryClient,
	setupLine,
	setupUser,
} from "./connect-dialog-harness";
import { createKeyMock } from "./connect-dialog-mocks";

vi.mock("@shared/lib/orpc-client", async () => {
	const { createKeyMock } = await import("./connect-dialog-mocks");
	return {
		orpcClient: {
			organizations: {
				apiKeys: {
					create: (input: unknown) => createKeyMock(input),
				},
			},
		},
	};
});

beforeEach(installBrowserStubs);

describe("ConnectCliDialog — minting", () => {
	it("mints nothing when the dialog is merely opened, and shows no configuration or stand-in key", async () => {
		const user = setupUser();
		renderHost();

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);

		expect(
			await screen.findByRole("button", { name: /create key/i }),
		).toBeInTheDocument();
		expect(createKeyMock).not.toHaveBeenCalled();
		expect(
			screen.queryByTestId("connect-cli-configuration"),
		).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain("YOUR_API_KEY");
		expect(document.body.textContent).not.toContain("Authorization");
	});

	it("mints a key on the create control and renders the configuration with the gateway endpoint and the returned secret", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await mintKey(user);

		expect(createKeyMock).toHaveBeenCalledTimes(1);
		const rendered = configurationText();
		expect(rendered).toContain(PROJECT_GATEWAY);
		expect(rendered).toContain(RAW_KEY);
		expect(rendered).toContain(`Bearer ${RAW_KEY}`);
		expect(rendered).toContain('"type": "http"');
	});

	it("sends exactly the read-only scope, the identifying name and the bounded expiry, and offers no scope picker", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		expect(within(dialog).queryAllByRole("checkbox")).toHaveLength(0);
		expect(
			within(dialog).queryByText(/mcp:write/i),
		).not.toBeInTheDocument();
		expect(
			within(dialog).queryByText(/permissions/i),
		).not.toBeInTheDocument();

		await user.click(
			within(dialog).getByRole("button", { name: /create key/i }),
		);

		await waitFor(() => expect(createKeyMock).toHaveBeenCalledTimes(1));
		const input = createKeyMock.mock.calls[0][0] as {
			scopes: string[];
			name: string;
			expiresInDays: number;
		};
		expect(input.scopes).toEqual(["mcp:read"]);
		expect(input.name).toBe("Coding CLI (created from the connect prompt)");
		expect(input.expiresInDays).toBe(90);
	});

	it("mints against the project's host organization", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await mintKey(user);

		expect(createKeyMock.mock.calls[0][0]).toMatchObject({
			organizationId: ORGANIZATION_ID,
		});
	});

	it("fires onKeyIssued exactly once, on a successful mint only — never on open, never on a failed one", async () => {
		const onKeyIssued = vi.fn();
		const user = setupUser();
		renderHost({ startOpen: true, onKeyIssued });

		expect(onKeyIssued).not.toHaveBeenCalled();

		createKeyMock.mockRejectedValueOnce(new Error("boom"));
		await user.click(
			await screen.findByRole("button", { name: /create key/i }),
		);
		await screen.findByText(/the key could not be created/i);
		expect(onKeyIssued).not.toHaveBeenCalled();

		await user.click(screen.getByRole("button", { name: /create key/i }));
		await waitFor(() => expect(configurationText()).toContain(RAW_KEY));

		expect(onKeyIssued).toHaveBeenCalledTimes(1);
	});

	it("mints a key the CLI can use in CI: the exact instructions scope alongside the gateway's", async () => {
		const user = setupUser();
		renderInstructions();
		await user.click(
			await screen.findByRole("button", { name: /create key/i }),
		);
		await waitFor(() => expect(createKeyMock).toHaveBeenCalledTimes(1));
		const input = createKeyMock.mock.calls[0][0] as { scopes: string[] };
		// The v1 routes behind `fabric instructions` match the scope by
		// name, so the gateway's umbrella scope alone would be refused.
		// `instructions:write` joined them when `fabric instructions push` and
		// the gateway's proposal tool landed (Fizzy #2539): it reaches the
		// PROPOSAL path only, which is what a reader can already do in the
		// Coding Instructions tab, and publishing is refused per call against
		// a permission this key's holder may not have.
		expect(input.scopes).toEqual([
			"mcp:read",
			"instructions:read",
			"instructions:write",
		]);

		// The scope this dialog must NEVER mint. `instructions:publish`
		// publishes a version with nobody in between, which would make the
		// "Can" card — changes go "for an editor to approve" — false
		// for every key this one button has ever issued. It is granted
		// deliberately in the organization's API-key settings instead, and a
		// read-only role cannot hold it at all.
		expect(input.scopes).not.toContain("instructions:publish");

		// And every one of them has to be grantable to a read-only role, or a
		// viewer who presses the one button this dialog offers is refused with
		// FORBIDDEN having chosen nothing. Restated from
		// `READ_ONLY_ORG_API_KEY_SCOPES` rather than imported, because the
		// point is that the two agree.
		const viewerGrantable = new Set([
			"mcp:read",
			"projects:read",
			"agents:read",
			"agents:stream",
			"orgs:read",
			"features:read",
			"workspaces:read",
			"workflows:read",
			"frames:read",
			"instructions:read",
			"instructions:write",
			"chats:read",
			"system_health:read",
			"status_updates:read",
		]);
		for (const scope of input.scopes) {
			expect(viewerGrantable.has(scope)).toBe(true);
		}
	});
});

describe("ConnectCliDialog — what the key grants", () => {
	it("states three facts in sentence case, before anything is minted", async () => {
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		const labels = within(dialog)
			.getAllByRole("term")
			.map((term) => term.textContent);

		expect(labels).toEqual(["Acts as", "Can", "Expires"]);
		for (const term of within(dialog).getAllByRole("term")) {
			expect(term).not.toHaveClass("uppercase");
		}
	});

	it("says it acts as the reader across the organization, for a bounded time", async () => {
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");

		expect(
			within(dialog).getByText(
				/in every project of this organization you can read/i,
			),
		).toBeInTheDocument();
		expect(
			within(dialog).getByText(/in 90 days, or when revoked/i),
		).toBeInTheDocument();
	});

	it("keeps the read-only promise for the project purpose", async () => {
		renderHost({ startOpen: true });

		expect(
			await screen.findByText(/read only\. it cannot change anything/i),
		).toBeInTheDocument();
		expect(screen.queryByText(/suggest instruction changes/i)).toBeNull();
	});

	// The card is read BEFORE the key exists and it is the only thing that says
	// what the key may do. A key that can propose a change must not be
	// introduced as read-only.
	it("tells a coding-instructions reader that the key can suggest a change, and that a person approves it", async () => {
		renderInstructions({ kind: "upload" });

		expect(
			await screen.findByText(
				/suggest instruction changes for an editor to approve/i,
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/it cannot change anything/i)).toBeNull();
	});

	it("puts the facts above the create control, and the password note beside it", async () => {
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		const facts = within(dialog).getByText("Acts as");
		const createButton = within(dialog).getByRole("button", {
			name: /create key/i,
		});

		expect(
			facts.compareDocumentPosition(createButton) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			within(dialog).getByText(/treat the key like a password/i),
		).toBeInTheDocument();
	});

	it("keeps the API key behind a closed 'CI or headless?' row", async () => {
		renderInstructions();

		const details = await screen.findByTestId(
			"connect-cli-key-alternative",
		);
		expect(details).not.toHaveAttribute("open");
		expect(
			within(details).getByText("CI or headless? Use an API key"),
		).toBeInTheDocument();
	});
});

describe("ConnectCliDialog — after the key exists", () => {
	it("removes the create control, keeps the facts in place, and shows the shown-once notice", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		await mintKey(user);

		expect(
			screen.queryByRole("button", { name: /create key/i }),
		).not.toBeInTheDocument();
		expect(screen.getByText("Acts as")).toBeInTheDocument();
		expect(screen.getByText(/shown once/i)).toBeInTheDocument();
		expect(
			screen.queryByText(/treat the key like a password/i),
		).not.toBeInTheDocument();
	});

	it("opens the row on its own, so the guard is never hiding behind a closed one", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		expect(
			screen.getByTestId("connect-cli-key-alternative"),
		).not.toHaveAttribute("open");

		await mintKey(user);

		expect(
			screen.getByTestId("connect-cli-key-alternative"),
		).toHaveAttribute("open");
	});

	it("warns that the key is shown once and names where it can be revoked", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);

		expect(screen.getByText(/shown once/i)).toBeInTheDocument();
		expect(
			screen.getByText(/cannot be retrieved afterwards/i),
		).toBeInTheDocument();
		// The revocation page is named in prose from the moment the key
		// exists — that half of the promise never depends on copying.
		expect(screen.getByText(/api keys settings page/i)).toBeInTheDocument();

		// The LINK is withheld until the configuration has been copied,
		// because following it is a client-side navigation that unmounts the
		// only holder of the plaintext key (Fizzy #2457, finding #6).
		expect(
			screen.queryByRole("link", { name: /api keys settings/i }),
		).not.toBeInTheDocument();
		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);

		expect(
			await screen.findByRole("link", { name: /api keys settings/i }),
		).toHaveAttribute(
			"href",
			`/app/${ORGANIZATION_SLUG}/settings/api-keys`,
		);
	});

	it("copies the configuration, reads 'Copied', and announces it", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);

		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);

		expect(clipboardWrite).toHaveBeenCalledWith(configurationText());
		expect(
			await screen.findByRole("button", { name: /^copied$/i }),
		).toBeInTheDocument();
		await waitFor(() =>
			expect(liveRegionText()).toMatch(/copied to the clipboard/i),
		);
		// Exactly one live region for every copy control — not zero, and not a
		// second one appearing per state change.
		expect(document.querySelectorAll('[aria-live="polite"]')).toHaveLength(
			1,
		);
	});

	it("goes back to 'Copy' after a moment without re-arming the dismissal guard", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);
		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);
		await screen.findByRole("button", { name: /^copied$/i });

		// The label comes back by itself, about 1.8 s later.
		expect(
			await screen.findByRole(
				"button",
				{ name: /copy configuration/i },
				{ timeout: 4000 },
			),
		).toBeInTheDocument();

		// The key was taken, so there is nothing left for the guard to protect.
		await user.keyboard("{Escape}");
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	}, 10_000);

	it("never names the alternate /mcp host", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);

		const rendered = configurationText();
		const origin = window.location.origin;
		expect(rendered).not.toContain(`${origin}/mcp"`);
		expect(rendered).not.toMatch(/"url":\s*"[^"]*\/mcp"/);
		expect(rendered).toContain(PROJECT_GATEWAY);
	});

	it("puts initial focus on the copy control once the configuration carries a key", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);

		await waitFor(() =>
			expect(
				screen.getByRole("button", { name: /copy configuration/i }),
			).toHaveFocus(),
		);
	});

	it("hides the 'no keys inside' sentence, which would be false now", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		expect(
			screen.getByText("No keys inside — safe to share or commit"),
		).toBeInTheDocument();

		await mintKey(user);

		expect(
			screen.queryByText("No keys inside — safe to share or commit"),
		).not.toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /^done$/i }),
		).toBeInTheDocument();
	});

	it("brings the sentence back when the dialog is closed and opened again", async () => {
		const user = setupUser();
		renderHost();
		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);
		await mintKey(user);
		await user.click(screen.getByRole("button", { name: /^done$/i }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);

		expect(
			await screen.findByText("No keys inside — safe to share or commit"),
		).toBeInTheDocument();
	});
});

describe("ConnectCliDialog — the starter instruction (project purpose)", () => {
	it("names the project in one copyable sentence", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		const instruction = await screen.findByTestId(
			"connect-cli-starter-instruction",
		);
		expect(instruction).toHaveTextContent(PROJECT_NAME);
		// One sentence: a single terminating period, and no line breaks.
		const text = instruction.textContent ?? "";
		expect(text.match(/\./g) ?? []).toHaveLength(1);
		expect(text).not.toContain("\n");

		await user.click(
			screen.getByRole("button", { name: /copy instruction/i }),
		);
		expect(clipboardWrite).toHaveBeenCalledWith(text);
		expect(
			await screen.findByRole("button", { name: /^copied$/i }),
		).toBeInTheDocument();
	});

	it("renders the original project-context sentence, byte-for-byte, when no purpose is given", async () => {
		renderHost({ startOpen: true });

		const instruction = await screen.findByTestId(
			"connect-cli-starter-instruction",
		);
		expect(instruction).toHaveTextContent(
			`Use the Fabric MCP server to load the context for the project "${PROJECT_NAME}" and help me work on it.`,
		);
	});

	it("offers copying and no shortcut that would run the instruction somewhere unconfigured", async () => {
		renderHost({ startOpen: true });

		// REPLACES an assertion that this section offered a "Run" control
		// (Fizzy #2457, finding #11): that control opened a chat destination
		// with the prompt TEXT and nothing else, so every destination it opened
		// started a conversation with a tool that had no Fabric MCP server.
		const dialog = await screen.findByRole("dialog");
		expect(
			await within(dialog).findByRole("button", {
				name: /copy instruction/i,
			}),
		).toBeInTheDocument();
		expect(
			within(dialog).queryByRole("button", { name: /^run$/i }),
		).not.toBeInTheDocument();
		// Nor any link out to a chat destination.
		for (const link of within(dialog).queryAllByRole("link")) {
			expect(link).toHaveAttribute("href", expect.stringMatching(/^\//));
		}
	});

	it("says the sentence has to be sent in the tool that was just connected", async () => {
		renderHost({ startOpen: true });

		expect(
			await screen.findByText(/send it in the tool you just connected/i),
		).toBeInTheDocument();
	});

	it("is not shown for coding instructions, whose handshake tells the connected tool what to load", async () => {
		renderInstructions();

		await screen.findByRole("dialog");
		expect(
			screen.queryByTestId("connect-cli-starter-instruction"),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /copy instruction/i }),
		).not.toBeInTheDocument();
		expect(screen.queryByText(/then say this to your tool/i)).toBeNull();
	});

	/**
	 * A copy still pending when the mint lands resolves into a view the mint has
	 * already reset: it must not put "Copied" or an announcement beside the real
	 * secret, and above all must not touch the guard.
	 */
	it("discards a copy that resolves after a mint has already landed", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		const { promise, resolve } = deferred<void>();
		clipboardWrite.mockReturnValueOnce(promise);

		await user.click(
			await screen.findByRole("button", { name: /copy instruction/i }),
		);
		// The clipboard write above is still pending — mint anyway.
		await mintKey(user);

		resolve();
		await waitFor(() => expect(clipboardWrite).toHaveResolvedTimes(1));

		expect(
			screen.queryByRole("button", { name: /^copied$/i }),
		).not.toBeInTheDocument();
		expect(liveRegionText()).toBe("");
		// The guard is armed: the stale write must not have set `keyCopied`
		// for the real secret that is now on screen uncopied.
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});
});

/**
 * The dialog holds the ONLY plaintext copy of the key: the server stores a
 * hash, so a close is destruction, not a cancel. Every incidental dismissal is
 * therefore disarmed while the configuration is on screen uncopied, leaving a
 * deliberate "Done" as the one exit (Fizzy #2457, finding #6).
 *
 * The guards are gated on the configuration having been COPIED rather than on
 * a key merely existing — once a copy is safely out of the browser there is
 * nothing left to lose, and a modal that still refuses Escape at that point is
 * a trap with no remaining purpose.
 */
describe("ConnectCliDialog — holding the only copy of the key", () => {
	async function mintUncopied() {
		const user = setupUser();
		renderHost({ startOpen: true });
		await mintKey(user);
		await waitFor(() => expect(configurationText()).toContain(RAW_KEY));
		return user;
	}

	it("does not close on Escape, and does not clear the key, while the configuration is uncopied", async () => {
		const user = await mintUncopied();

		await user.keyboard("{Escape}");

		// Still open, and still holding the same secret — not re-minted.
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(configurationText()).toContain(RAW_KEY);
		expect(createKeyMock).toHaveBeenCalledTimes(1);
	});

	it("announces the blocked dismissal rather than swallowing the key press", async () => {
		const user = await mintUncopied();

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(liveRegionText()).toMatch(/has not been copied yet/i),
		);
		// And the same thing is on screen for a reader who is not using
		// assistive technology, described by the control that lifts it.
		const note = screen.getByTestId("connect-cli-dismissal-note");
		expect(note).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: /copy configuration/i }),
		).toHaveAttribute("aria-describedby", note.id);
		expect(
			screen.getAllByTestId("connect-cli-dismissal-note"),
		).toHaveLength(1);
	});

	it("withholds the close button while the configuration is uncopied and restores it afterwards", async () => {
		const user = await mintUncopied();

		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).queryByRole("button", { name: /^close$/i }),
		).not.toBeInTheDocument();

		await user.click(
			within(dialog).getByRole("button", { name: /copy configuration/i }),
		);

		expect(
			await within(dialog).findByRole("button", { name: /^close$/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-dismissal-note"),
		).not.toBeInTheDocument();
	});

	it("closes on Escape once the configuration has been copied", async () => {
		const user = await mintUncopied();

		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);
		await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	/**
	 * Regression for a review finding on the stale-copy fix: `handleOpenChange`
	 * resets `keyCopied` to `false` on close, but a `copy()` call that was
	 * still in flight when Done was clicked used to write `keyCopied = true`
	 * anyway once its clipboard write resolved — after the reset, and after a
	 * brand-new key had been minted on reopen. That stale write must not
	 * disarm the guard for a secret the pending copy never actually touched.
	 */
	it("discards a real-key copy that resolves after Done has already closed and reset the dialog", async () => {
		const user = setupUser();
		renderHost();

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);
		await mintKey(user);

		const { promise, resolve } = deferred<void>();
		clipboardWrite.mockReturnValueOnce(promise);
		await user.click(
			screen.getByRole("button", { name: /copy configuration/i }),
		);
		// Done is the deliberate exit and works even on an uncopied secret —
		// it does not wait for the pending clipboard write below.
		await user.click(screen.getByRole("button", { name: /^done$/i }));
		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// The stale copy resolves only now, after the close has already reset.
		resolve();
		await waitFor(() => expect(clipboardWrite).toHaveResolvedTimes(1));

		// Reopen and mint a brand-new key.
		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);
		await mintKey(user);

		// The guard is armed for the NEW uncopied secret: the stale resolve
		// above must not have set `keyCopied` for it.
		const dialog = screen.getByRole("dialog");
		expect(
			within(dialog).queryByRole("button", { name: /^close$/i }),
		).not.toBeInTheDocument();
		await user.keyboard("{Escape}");
		expect(screen.getByRole("dialog")).toBeInTheDocument();
	});

	it("still closes on Escape before any key has been minted", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });
		await screen.findByRole("dialog");

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(createKeyMock).not.toHaveBeenCalled();
	});

	it("does not arm the guard on a coding-instructions dialog that never mints a key", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();

		await user.keyboard("{Escape}");

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
	});

	it("shows a working close button before any key has been minted", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		const dialog = await screen.findByRole("dialog");
		// Nothing to guard yet: the close (X) button is offered, unlike the
		// uncopied-secret state where it is withheld.
		await user.click(
			within(dialog).getByRole("button", { name: /^close$/i }),
		);

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		expect(createKeyMock).not.toHaveBeenCalled();
	});

	it("closes on Done and clears the key, leaving nothing to reopen onto", async () => {
		const user = setupUser();
		renderHost();

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);
		await mintKey(user);

		// Done is the deliberate exit, and it works even uncopied: the guards
		// prevent an accident, they do not hold the reader hostage.
		await user.click(screen.getByRole("button", { name: /^done$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);

		// Reopening comes back to the pre-mint state: the secret is gone from
		// the client and nothing was refetched to bring it back.
		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);

		expect(
			await screen.findByRole("button", { name: /create key/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByTestId("connect-cli-configuration"),
		).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain(RAW_KEY);
		expect(createKeyMock).toHaveBeenCalledTimes(1);
	});

	it("keeps copying the setup line separate from copying the key: the guard stays armed", async () => {
		const user = setupUser();
		renderInstructions();
		await setupLine();
		await mintKey(user);

		await user.click(
			screen.getByRole("button", { name: "Copy the setup line" }),
		);
		await waitFor(() => expect(clipboardWrite).toHaveBeenCalledTimes(1));
		await user.keyboard("{Escape}");

		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(
			screen.getByTestId("connect-cli-dismissal-note"),
		).toBeInTheDocument();
	});
});

describe("ConnectCliDialog — resilience", () => {
	it("stays open and keeps the secret when the caller's eligibility flips to false", async () => {
		const user = setupUser();
		const { rerender } = renderWithQueryClient(<Host startOpen eligible />);

		await mintKey(user);

		// What the readiness refetch does to the caller after a successful
		// mutation: the opening control disappears out from under the dialog.
		rerender(<Host startOpen eligible={false} />);

		expect(
			screen.queryByText("Connect a coding tool"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		expect(configurationText()).toContain(RAW_KEY);
		// The secret is never refetched — there is nothing to refetch it from.
		expect(createKeyMock).toHaveBeenCalledTimes(1);
	});

	it("shows the safe fallback and stays open when issuance fails", async () => {
		createKeyMock.mockRejectedValueOnce(
			new Error("You are not a member of this organization"),
		);
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create key/i }),
		);

		expect(
			await screen.findByText(/the key could not be created/i),
		).toBeInTheDocument();
		expect(
			screen.getByText(/something went wrong creating the key/i),
		).toBeInTheDocument();
		expect(screen.getByRole("dialog")).toBeInTheDocument();
		// A failed mint never produced a real key.
		expect(
			screen.queryByTestId("connect-cli-configuration"),
		).not.toBeInTheDocument();
		// Still offered a retry rather than a dead end.
		expect(
			screen.getByRole("button", { name: /create key/i }),
		).toBeInTheDocument();
	});

	/**
	 * The raw message never reaches the DOM (Fizzy #2457): whatever the
	 * mutation's error carries — a Prisma message, a driver detail, an
	 * internal constraint name — this repo is public and none of it belongs in
	 * the UI. `CliConnectionNudge` states the same rule for its own error
	 * handler. The real error is still surfaced, but to `console.error`, not
	 * the page.
	 */
	it("never renders the raw server error message, and logs it instead", async () => {
		const consoleErrorSpy = vi
			.spyOn(console, "error")
			.mockImplementation(() => {});
		const internalMessage =
			'duplicate key value violates unique constraint "api_key_org_name_key"';
		createKeyMock.mockRejectedValueOnce(new Error(internalMessage));
		const user = setupUser();
		renderHost({ startOpen: true });

		await user.click(
			await screen.findByRole("button", { name: /create key/i }),
		);

		expect(
			await screen.findByText(/the key could not be created/i),
		).toBeInTheDocument();
		expect(screen.queryByText(internalMessage)).not.toBeInTheDocument();
		expect(document.body.textContent).not.toContain(internalMessage);
		expect(consoleErrorSpy).toHaveBeenCalledWith(
			expect.stringContaining("Failed to create the CLI connection key"),
			expect.objectContaining({ message: internalMessage }),
		);

		consoleErrorSpy.mockRestore();
	});
});

describe("ConnectCliDialog — the shell", () => {
	it("is titled for the coding tool, with the description for its purpose", async () => {
		const first = renderHost({ startOpen: true });
		expect(
			await screen.findByRole("heading", {
				name: "Connect your coding tool",
			}),
		).toBeInTheDocument();
		expect(
			screen.getByText(
				/it can read this project's context while you work/i,
			),
		).toBeInTheDocument();
		first.unmount();

		renderInstructions();
		expect(
			await screen.findByText(
				"Your tool will load this project's coding instructions and stay in sync.",
			),
		).toBeInTheDocument();
	});

	it("has one Done button and no Cancel, with or without a key", async () => {
		const user = setupUser();
		renderHost({ startOpen: true });

		expect(
			await screen.findByRole("button", { name: /^done$/i }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: /^cancel$/i }),
		).not.toBeInTheDocument();

		await mintKey(user);

		expect(screen.getAllByRole("button", { name: /^done$/i })).toHaveLength(
			1,
		);
		expect(
			screen.queryByRole("button", { name: /^cancel$/i }),
		).not.toBeInTheDocument();
	});

	it("puts initial focus on the tool picker when the dialog opens", async () => {
		// Opened from closed via the invoking control, as production does —
		// `startOpen` skips the real open transition Radix's own focus
		// handling runs through.
		const user = setupUser();
		renderHost();

		await user.click(
			screen.getByRole("button", { name: "Connect a coding tool" }),
		);

		await waitFor(() =>
			expect(
				screen.getByRole("tab", { name: "Claude Code" }),
			).toHaveFocus(),
		);
	});

	it("returns focus to the invoking control on close", async () => {
		const user = setupUser();
		renderHost();

		const opener = screen.getByRole("button", {
			name: "Connect a coding tool",
		});
		await user.click(opener);
		await screen.findByRole("dialog");

		await user.click(screen.getByRole("button", { name: /^done$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(opener).toHaveFocus());
	});

	it("returns focus to the invoking control after a key has been issued", async () => {
		const user = setupUser();
		renderHost();

		const opener = screen.getByRole("button", {
			name: "Connect a coding tool",
		});
		await user.click(opener);
		await mintKey(user);

		await user.click(screen.getByRole("button", { name: /^done$/i }));

		await waitFor(() =>
			expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
		);
		await waitFor(() => expect(opener).toHaveFocus());
	});

	it("gives every control an accessible name", async () => {
		renderInstructions();
		await setupLine();

		const dialog = await screen.findByRole("dialog");
		for (const button of within(dialog).getAllByRole("button")) {
			expect(button).toHaveAccessibleName();
		}
	});
});
