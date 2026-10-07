"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { LockIcon } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { LocalSetupRoute } from "../../lib/instructions-repository-sync";
import { AgentSignInSection } from "./AgentSignInSection";
import { ApiKeyAlternative, type KeyFact } from "./ApiKeyAlternative";
import { COPIED_RESET_MS } from "./CommandBlock";
import { GitCredentialsHelp } from "./GitCredentialsHelp";
import { gatewayUrl } from "./lib/agent-sign-in";
import { useCliDiscovery } from "./lib/use-cli-discovery";
import { useTransientValue } from "./lib/use-transient-value";
import {
	buildStarterInstruction,
	StarterInstruction,
} from "./StarterInstruction";

export type { LocalSetupRoute };

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/*                                                                             */
/* Every user-visible sentence lives here rather than inline in the JSX, so the */
/* wording that needs product sign-off is reviewable in one place. Same         */
/* treatment as `AnthropicCapabilityBanner`, whose approved sentences are       */
/* hoisted for the same reason. The steps' own copy lives with the steps.       */
/* -------------------------------------------------------------------------- */

const DIALOG_TITLE = "Connect your coding tool";

const DIALOG_DESCRIPTION =
	"Sign in from your coding tool, and it can read this project's context while you work.";

/** The coding-instructions purpose sets up one thing, so it says so. */
const INSTRUCTIONS_DIALOG_DESCRIPTION =
	"Your tool will load this project's coding instructions and stay in sync.";

/**
 * Nothing above the footer holds a credential, so a reader can share the dialog
 * or commit what they copy from it. Not said once a key has been minted: the
 * configuration under it holds one.
 */
const NO_KEYS_NOTE = "No keys inside — safe to share or commit";

const COPIED_ANNOUNCEMENT = {
	configuration: "Configuration copied to the clipboard.",
	instruction: "Starter instruction copied to the clipboard.",
} as const;

const COPY_FAILED_ANNOUNCEMENT =
	"Copying failed. Select the text and copy it manually.";

/** Read out when a dismissal is disarmed, so the blocked key press is not silent. */
const DISMISSAL_BLOCKED_ANNOUNCEMENT =
	"The key has not been copied yet, so the dialog stayed open. Copy it, or choose Done to close and discard the key.";

const DONE_LABEL = "Done";

/**
 * Which entry point opened this dialog.
 *
 * - `"project"`: full project context from the project-level prompt/checklist.
 *   Claude Code and Codex connect over MCP, and the one pasted sentence names
 *   the project.
 * - `"coding-instructions"`: the Coding Instructions tab. Claude Code and Codex
 *   run the one-line setup the deployment serves; the gateway's handshake
 *   already tells the connected tool what to load, so there is no sentence to
 *   paste.
 *
 * The mint, the scopes and the configuration are identical either way.
 */
export type ConnectCliPurpose = "project" | "coding-instructions";

/* -------------------------------------------------------------------------- */
/* Minting parameters                                                          */
/* -------------------------------------------------------------------------- */

/**
 * The scopes the minted key carries — read-only, and no picker.
 *
 * NOT the procedure's `["mcp:read", "mcp:write"]` default. `scopeSatisfied` in
 * `@saas/mcp/lib/gateway/platform-tools` short-circuits on `mcp:write` and
 * returns true for EVERY tool, writes included, so the default pair is a
 * full-access grant wearing a two-item list. Handing that out from a banner is
 * out of this feature's scope; `mcp:read` satisfies exactly the tools whose
 * `kind` is `"read"`, which is what the reader is promised above.
 */
const ISSUED_KEY_SCOPES = ["mcp:read"] as const;

/**
 * The coding-instructions purpose also offers the CLI route, whose REST
 * routes require the exact `instructions:read` scope (`requireScope` in the
 * v1 middleware matches by name; the gateway's umbrella reading of
 * `mcp:read` does not apply there). A key minted for that purpose carries
 * it, so the CLI a CI job runs works with the key it just created.
 *
 * `instructions:write` is the one non-read scope this dialog ever mints, and
 * it is here because the CLI it configures now has `fabric instructions push`
 * and the MCP gateway has `fabric_propose_project_instruction_change`. Both
 * open a PROPOSAL: a suggestion held for review, published by nobody but a
 * person with edit rights in the tab.
 *
 * Publishing is not reachable from this scope at all, which is what makes the
 * disclosure below true for EVERY person who mints a key here. A mode gated on
 * the minter's own permissions would have made "nothing is published until
 * somebody approves" a half-truth for anyone holding `INSTRUCTION_CREATE`, and
 * the sentence a person reads before creating a credential has to hold whoever
 * they are. The key therefore stays within what a reader can already do in the
 * browser, which is also why `READ_ONLY_ORG_API_KEY_SCOPES` accepts it and a
 * viewer's mint is not clamped. The "Can" card says so before the key is
 * created.
 *
 * Publishing directly is a SEPARATE authority, `instructions:publish`, which
 * this dialog never mints and must not start minting. It is the scope behind
 * `fabric instructions push --publish` and `POST
 * /projects/:id/instructions/versions`, it is absent from
 * `READ_ONLY_ORG_API_KEY_SCOPES`, and a key carrying it is created
 * deliberately in the organization's API-key settings, where its own
 * disclosure says it publishes with no review. Adding it here would make the
 * promise above false for every key this one button has ever issued.
 */
const ISSUED_KEY_SCOPES_FOR_INSTRUCTIONS = [
	"mcp:read",
	"instructions:read",
	"instructions:write",
] as const;

type IssuedKeyScope = (typeof ISSUED_KEY_SCOPES_FOR_INSTRUCTIONS)[number];

function issuedKeyScopes(purpose: ConnectCliPurpose): IssuedKeyScope[] {
	return purpose === "coding-instructions"
		? [...ISSUED_KEY_SCOPES_FOR_INSTRUCTIONS]
		: [...ISSUED_KEY_SCOPES];
}

/**
 * The name the key is stored under.
 *
 * Its job is to be recognisable months later in the organization's API keys
 * table by someone who was not the person who clicked: it says what the key is
 * for and where it came from, so an unfamiliar row is not a mystery to
 * investigate before it can safely be revoked.
 */
const ISSUED_KEY_NAME = "Coding CLI (created from the connect prompt)";

/**
 * How long the key lives, in days.
 *
 * Bounded rather than perpetual because this key is minted from a prompt, in
 * one click, by someone who may never think about it again — the population
 * least likely to retire a credential by hand. 90 days is the common
 * rotation period, long enough that it is not a weekly interruption and short
 * enough that an abandoned key stops being a live credential within a quarter.
 * The procedure caps `expiresInDays` at 365.
 */
const ISSUED_KEY_EXPIRY_DAYS = 90;

/**
 * What the key grants, said before anything is minted (R27): who it acts as,
 * what it can do and when it stops. The second card is corrected for the one
 * purpose whose key can write something — a coding-instructions key carries
 * `instructions:write`, so "it cannot change anything" would be false for it.
 * What that scope actually reaches is the proposal path, a suggestion somebody
 * with edit rights approves or rejects in the tab, and the card says exactly
 * that rather than downgrading the promise to a vague one.
 */
function keyFactsFor(purpose: ConnectCliPurpose): KeyFact[] {
	return [
		{
			label: "Acts as",
			value: "You, in every project of this organization you can read",
		},
		{
			label: "Can",
			value:
				purpose === "coding-instructions"
					? "Read, and suggest instruction changes for an editor to approve"
					: "Read only. It cannot change anything",
		},
		{
			label: "Expires",
			value: `In ${ISSUED_KEY_EXPIRY_DAYS} days, or when revoked`,
		},
	];
}

/**
 * Build the client configuration with the secret already inlined.
 *
 * An http-type MCP server entry carrying the key as a bearer header: the shape
 * Claude Code, Cursor and VS Code all accept, and the shape the gateway
 * actually authenticates. It names the project's own gateway URL like every
 * other entry, so a connection made with the key reaches this project alone.
 */
function buildMcpConfiguration(
	origin: string,
	projectId: string,
	rawKey: string,
): string {
	return JSON.stringify(
		{
			mcpServers: {
				fabric: {
					type: "http",
					url: gatewayUrl(origin, projectId),
					headers: {
						Authorization: `Bearer ${rawKey}`,
					},
				},
			},
		},
		null,
		2,
	);
}

type CopyTarget = "configuration" | "instruction";

interface ConnectCliDialogProps {
	/** Controlled by the caller. This view never gates its own visibility. */
	open: boolean;
	onOpenChange: (open: boolean) => void;
	/**
	 * The organization that HOSTS the project on screen.
	 *
	 * Passed explicitly and never read from the session's active organization,
	 * which is a best-effort pointer and can legitimately name a different
	 * tenant than the project being viewed — minting there would issue a key
	 * against an organization the reader did not ask about.
	 */
	organizationId: string;
	/**
	 * That same organization's slug, used only to link its API keys settings.
	 * Optional: without it the page is named in prose instead of linked, which
	 * still satisfies "say where the key can be revoked".
	 */
	organizationSlug?: string;
	/** Named in the starter instruction so the tool opens on the right project. */
	projectName: string;
	/**
	 * Which entry point opened this dialog. Defaults to `"project"`, the
	 * original prompt/checklist wording, so every existing caller is unaffected.
	 */
	purpose?: ConnectCliPurpose;
	/**
	 * The project on screen. Every tool connects to this project's own gateway
	 * URL, so the sign-in is for it alone and asks for no organization or
	 * project, and the one-line setup names it as `--project`.
	 */
	projectId: string;
	/**
	 * Which one-line setup this project offers, if any — computed by
	 * `localSetupRouteFor` in `lib/instructions-repository-sync.ts` from the
	 * project's source-of-truth setting and (for a repository project) its
	 * sync configuration. `null`/`undefined` offers no line: the setting has
	 * not resolved yet, or a repository project has nothing configured for the
	 * CLI to find. Claude Code and Codex then connect over MCP.
	 */
	localSetup?: LocalSetupRoute | null;
	/**
	 * Fired once, after a key is successfully issued.
	 *
	 * The "key issued" funnel event belongs to whichever surface opened this
	 * view — the prompt and the checklist row record different origins — so the
	 * event is raised here and recorded there.
	 */
	onKeyIssued?: () => void;
}

/**
 * Connecting a coding tool, and the one place an API key is minted.
 *
 * A tile per tool is the whole dialog: each tile is a few numbered steps, and
 * the person approves the connection in the browser. The API key route stays,
 * collapsed, for CI and headless machines where nobody can approve a sign-in.
 *
 * A dialog, not an inline expansion, and it gates its own visibility on
 * nothing. That is structural, not cosmetic: the readiness query refetches
 * after any successful mutation, so minting a key flips the caller's own
 * eligibility to false. Rendered inside that gated subtree, this view would
 * unmount at the exact moment it holds the only copy of a secret that cannot be
 * fetched again. Callers must mount it OUTSIDE whatever they gate.
 *
 * The secret lives in component state and is never refetched, because there is
 * nothing to refetch it from: the server stores a hash. For that same reason,
 * once a key has been minted and until its configuration has been copied,
 * every incidental dismissal — Escape, a click outside, the close button, the
 * link out to settings — is disarmed, leaving "Done" as the one deliberate exit
 * (Fizzy #2457). Before a key exists nothing is guarded.
 */
export function ConnectCliDialog({
	open,
	onOpenChange,
	organizationId,
	organizationSlug,
	projectName,
	purpose = "project",
	projectId,
	localSetup = null,
	onKeyIssued,
}: ConnectCliDialogProps) {
	const [rawKey, setRawKey] = useState<string | null>(null);
	/** The most recent copy, for the second or so its control reads "Copied". */
	const [copied, raiseCopied, lowerCopied] =
		useTransientValue<CopyTarget>(COPIED_RESET_MS);
	/**
	 * Whether the CONFIGURATION specifically has reached the clipboard.
	 *
	 * Separate from `copied`, which names the most recent copy, is overwritten
	 * when the starter instruction is copied, and clears by itself — reading the
	 * guards off that would re-arm every dismissal behind the reader's back. This
	 * one latches on the first successful configuration copy and is only cleared
	 * when the view closes.
	 */
	const [keyCopied, setKeyCopied] = useState(false);
	const [announcement, setAnnouncement] = useState("");
	const [keyFlowOpen, setKeyFlowOpen] = useState(false);
	const [origin, setOrigin] = useState("");
	const initialFocusRef = useRef<HTMLButtonElement>(null);
	/**
	 * The control that opened this view, so focus can be handed back to it.
	 *
	 * Recorded rather than inferred, because Radix returns focus to its own
	 * `DialogTrigger` and this dialog deliberately has none: it is mounted
	 * outside the subtree its callers gate, and opened by a control that lives
	 * inside it. Without this the reader is dropped on `document.body` and has
	 * to tab back through the page to where they were.
	 */
	const invokerRef = useRef<HTMLElement | null>(null);
	/**
	 * Fences a `copy()` call to the mint/close it started under.
	 *
	 * `copy()` is async — it awaits `navigator.clipboard.writeText()` — so its
	 * continuation can resolve after either onSuccess (a copy still in flight
	 * when a mint lands) or a close (a real-key copy still in flight when the
	 * reader hits Done) has already reset the state it is about to write. Bumped
	 * in both of those places; `copy()` captures the generation before awaiting
	 * and discards its result if the generation has moved on, rather than
	 * writing `copied`/`announcement`/`keyCopied` into a view that has already
	 * moved past the copy it started for.
	 */
	const copyGenerationRef = useRef(0);

	/** The single source of truth for "does a real key exist yet". */
	const keyIssued = rawKey !== null;

	// Read on the client only, so the rendered URL cannot differ between the
	// server pass and hydration. Same approach as the API keys settings page.
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);

	const isInstructionsPurpose = purpose === "coding-instructions";
	const discovery = useCliDiscovery(open && isInstructionsPurpose);

	const createKeyMutation = useMutation({
		mutationFn: async () =>
			await orpcClient.organizations.apiKeys.create({
				organizationId,
				name: ISSUED_KEY_NAME,
				scopes: issuedKeyScopes(purpose),
				expiresInDays: ISSUED_KEY_EXPIRY_DAYS,
			}),
		onSuccess: (data) => {
			setRawKey(data.rawKey);
			// A "Copied" confirmation taken before this mint would otherwise sit
			// beside the real secret and could read as "you already copied this
			// one, it's safe to close".
			lowerCopied();
			setAnnouncement("");
			// Fences off a copy that is still in flight: if its
			// `navigator.clipboard.writeText()` resolves after this point, it
			// must not reinstate "Copied" beside the real key the lines above
			// just cleared.
			copyGenerationRef.current += 1;
			onKeyIssued?.();
		},
		onError: (error) => {
			// Never render a raw server message: this repo is public and such a
			// string can carry an internal detail (a driver error, a constraint
			// name) that has no business in UI. Same rule `CliConnectionNudge`
			// states for its own error handler — logged here instead so the
			// real error is not lost.
			console.error("Failed to create the CLI connection key", error);
		},
	});

	// Initial focus moves to the copy control the moment a key is minted: it is
	// the only thing in this view that must happen before the dialog closes, and
	// the secret is unrecoverable if it does not. `initialFocusRef` is attached
	// to the configuration's copy control, which exists only once a key does, so
	// before that this is a no-op and the dialog's own initial focus stands.
	useEffect(() => {
		initialFocusRef.current?.focus();
	}, [keyIssued]);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			// The secret is gone from the client as soon as this view closes,
			// which is the honest reflection of the warning it just showed.
			setRawKey(null);
			lowerCopied();
			setKeyCopied(false);
			setKeyFlowOpen(false);
			setAnnouncement("");
			createKeyMutation.reset();
			// Fences off a copy still in flight when Done (or a disarmed
			// dismissal, before any key exists) closes this view: were its
			// `navigator.clipboard.writeText()` to resolve after the reset
			// above, it must not set `keyCopied` for a key this close just
			// discarded, arming the dismissal guard for nothing — or, worse,
			// falsely satisfying it for whatever gets minted on the next open.
			copyGenerationRef.current += 1;
		}
		onOpenChange(nextOpen);
	};

	const copy = async (target: CopyTarget, value: string) => {
		// Captured before awaiting: a mint's `onSuccess` or a close's reset
		// bumps this ref, and either can land while `writeText()` below is
		// still pending. If it has moved on by the time this resolves, every
		// write below would be writing into a view this copy no longer
		// describes. Neither success nor failure below touches state once the
		// generation has moved.
		const generation = copyGenerationRef.current;
		try {
			await navigator.clipboard.writeText(value);
			if (generation !== copyGenerationRef.current) {
				return;
			}
			raiseCopied(target);
			// The configuration carries the key, so copying it is taking the key.
			// Gated on `keyIssued` all the same: the configuration is only ever
			// on screen once a key exists, and the guard must never be satisfied
			// by a copy that did not take one.
			if (target === "configuration" && keyIssued) {
				setKeyCopied(true);
			}
			setAnnouncement(COPIED_ANNOUNCEMENT[target]);
		} catch {
			if (generation !== copyGenerationRef.current) {
				return;
			}
			lowerCopied();
			setAnnouncement(COPY_FAILED_ANNOUNCEMENT);
		}
	};

	const configuration =
		rawKey === null ? "" : buildMcpConfiguration(origin, projectId, rawKey);
	const starterInstruction = buildStarterInstruction(projectName);

	/**
	 * A live credential is on screen that exists nowhere else.
	 *
	 * Gated on `keyCopied` and not on `keyIssued` alone: the loss this
	 * guards against is losing the ONLY copy, and once the reader has taken one
	 * there is nothing left to lose. Trapping them past that point would be a
	 * modal that refuses to close for no remaining reason — worse for keyboard
	 * users than the accident it was meant to prevent. False whenever
	 * `!keyIssued`.
	 */
	const uncopiedSecretOnScreen = keyIssued && !keyCopied;

	/**
	 * Disarm one incidental dismissal and say so.
	 *
	 * Escape, a click outside and a focus escape all reach a close through
	 * paths a reader can take by reflex. `Done` is left as the one exit,
	 * because it is the only one that cannot be pressed by accident.
	 */
	const guardDismissal = (event: { preventDefault: () => void }) => {
		if (!uncopiedSecretOnScreen) {
			return;
		}
		event.preventDefault();
		setAnnouncement(DISMISSAL_BLOCKED_ANNOUNCEMENT);
	};

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="sm:max-w-[600px]"
				// While the only copy of the key is on screen, the close (X)
				// button goes with the rest of the incidental exits: leaving it
				// would advertise a one-click way to destroy the secret right
				// next to the warning that says it cannot be retrieved.
				hideCloseButton={uncopiedSecretOnScreen}
				onEscapeKeyDown={guardDismissal}
				onPointerDownOutside={guardDismissal}
				onInteractOutside={guardDismissal}
				// Fires before the focus scope moves focus into the dialog, so
				// `activeElement` is still the control that opened it.
				onOpenAutoFocus={() => {
					invokerRef.current =
						document.activeElement instanceof HTMLElement
							? document.activeElement
							: null;
				}}
				onCloseAutoFocus={(event) => {
					const invoker = invokerRef.current;
					if (!invoker || !document.contains(invoker)) {
						// The opening control is gone — eligibility flipped
						// while the dialog was up, which is the ordinary case
						// after a key is issued. Leave Radix's own handling in
						// place rather than focusing a detached node.
						return;
					}
					event.preventDefault();
					invoker.focus();
				}}
			>
				<DialogHeader>
					<DialogTitle className="font-medium text-xl">
						{DIALOG_TITLE}
					</DialogTitle>
					<DialogDescription>
						{isInstructionsPurpose
							? INSTRUCTIONS_DIALOG_DESCRIPTION
							: DIALOG_DESCRIPTION}
					</DialogDescription>
				</DialogHeader>

				{/* One polite live region for every copy control. Kept mounted
				 * across state changes so assistive technology has something to
				 * observe rather than a node appearing mid-announcement. */}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>

				<div className="min-w-0 space-y-5">
					<AgentSignInSection
						announce={setAnnouncement}
						checkout={
							isInstructionsPurpose
								? { discovery, localSetup }
								: undefined
						}
						origin={origin}
						projectId={projectId}
						projectName={projectName}
					/>

					{isInstructionsPurpose ? null : (
						<StarterInstruction
							copied={copied === "instruction"}
							onCopy={() =>
								copy("instruction", starterInstruction)
							}
							sentence={starterInstruction}
						/>
					)}

					{/* The two things most people never need, one bordered
					 * group: git's own sign-in for a repository project, and the
					 * API-key route for CI and headless machines. */}
					<div className="divide-y divide-border overflow-hidden rounded-lg border border-border">
						{isInstructionsPurpose &&
						localSetup?.kind === "repository" ? (
							<GitCredentialsHelp
								announce={setAnnouncement}
								route={localSetup}
							/>
						) : null}
						<ApiKeyAlternative
							configuration={configuration}
							configurationCopied={copied === "configuration"}
							copyButtonRef={initialFocusRef}
							createFailed={createKeyMutation.error !== null}
							creating={createKeyMutation.isPending}
							facts={keyFactsFor(purpose)}
							keyCopied={keyCopied}
							keyIssued={keyIssued}
							onCopyConfiguration={() =>
								copy("configuration", configuration)
							}
							onCreate={() => createKeyMutation.mutate()}
							onOpenChange={setKeyFlowOpen}
							// Kept open while a key is on screen, so its
							// dismissal guard is never hiding behind a closed row.
							open={keyFlowOpen || keyIssued}
							organizationSlug={organizationSlug}
							repositorySetup={
								isInstructionsPurpose &&
								localSetup?.kind === "repository"
							}
							uncopiedSecretOnScreen={uncopiedSecretOnScreen}
						/>
					</div>
				</div>

				<DialogFooter className="-mx-6 -mb-6 flex-row items-center justify-between gap-4 border-t bg-muted/40 px-6 py-3.5 sm:justify-between sm:space-x-0">
					{keyIssued ? null : (
						<p
							className="flex min-w-0 flex-1 items-center gap-2 text-muted-foreground text-xs"
							data-testid="connect-cli-no-keys-note"
						>
							<LockIcon
								aria-hidden="true"
								className="size-3.5 shrink-0"
							/>
							<span>{NO_KEYS_NOTE}</span>
						</p>
					)}
					<Button
						autoLoading={false}
						className="ml-auto"
						onClick={() => handleOpenChange(false)}
					>
						{DONE_LABEL}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
