"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation } from "@tanstack/react-query";
import { Alert, AlertDescription, AlertTitle } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import {
	AlertTriangleIcon,
	CheckIcon,
	CopyIcon,
	KeyIcon,
	PlugIcon,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import {
	type LocalSetupRoute,
	quoteShellArgIfNeeded,
} from "../../lib/instructions-repository-sync";

export type { LocalSetupRoute };

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/*                                                                             */
/* Every user-visible sentence lives here rather than inline in the JSX, so the */
/* wording that needs product sign-off is reviewable in one place. Same         */
/* treatment as `AnthropicCapabilityBanner`, whose approved sentences are       */
/* hoisted for the same reason.                                                 */
/* -------------------------------------------------------------------------- */

const DIALOG_TITLE = "Connect Fabric to your coding tool";

const DIALOG_DESCRIPTION =
	"Create a key, connect your coding tool with it, and it can read this project's context while you work.";

/** Section 1 — what the key grants, said before anything is minted (R27). */
const DISCLOSURE_LABEL = "Before you create the key";

const DISCLOSURE_POINTS = [
	"The key authenticates as you. A tool holding it reads everything you can read in this organization — every project in it, not only this one.",
	"It is read-only: a tool holding it can read your work in Fabric, and cannot change it.",
	"It stays valid until you revoke it, or until it expires 90 days from now, whichever comes first.",
	"After you create a key, the configuration and any local setup commands below will contain a live credential. Treat it like a password: do not paste it into a shared document, a ticket or a chat.",
] as const;

/**
 * The same four points, with the second one corrected for the one purpose whose
 * key can write something.
 *
 * A coding-instructions key carries `instructions:write`, so "it is read-only"
 * would be false for it. What that scope actually reaches is the proposal
 * path — a suggestion somebody with edit rights approves or rejects in the tab
 * — and nothing else, so the replacement says exactly that rather than
 * downgrading the promise to a vague one.
 */
const INSTRUCTIONS_DISCLOSURE_POINTS = [
	DISCLOSURE_POINTS[0],
	"It reads your work in Fabric and cannot change it, with one exception: a tool holding it can SUGGEST a change to this project's coding instructions. Suggestions are held for review and nothing is published until somebody who can edit them approves it.",
	DISCLOSURE_POINTS[2],
	DISCLOSURE_POINTS[3],
] as const;

function disclosurePointsFor(purpose: ConnectCliPurpose): readonly string[] {
	return purpose === "coding-instructions"
		? INSTRUCTIONS_DISCLOSURE_POINTS
		: DISCLOSURE_POINTS;
}

const CREATE_KEY_LABEL = "Create the key";

const CREATE_KEY_PENDING_LABEL = "Creating the key…";

const ISSUE_ERROR_TITLE = "The key could not be created";

const ISSUE_ERROR_FALLBACK =
	"Something went wrong creating the key. Try again, or create one from the organization's API keys settings.";

/** Section 2 — the finished configuration. */
const CONFIGURATION_LABEL = "Your configuration";

const CONFIGURATION_INTRO =
	"Paste this into your coding tool's MCP configuration.";

/**
 * Stands in for a real key everywhere one is needed before the reader has
 * minted one: the configuration block below and the local-sync commands.
 * Shaped like an ordinary value rather than an obvious dummy, so a reader who
 * already holds a key can copy the template as-is and paste their own key
 * over the placeholder.
 */
const PLACEHOLDER_KEY = "YOUR_API_KEY";

/** Shown only while `PLACEHOLDER_KEY` is standing in for a real one. */
const PLACEHOLDER_KEY_NOTE =
	"YOUR_API_KEY stands in for a key you already hold, or the one you create above.";

const SHOWN_ONCE_TITLE = "Shown once";

const SHOWN_ONCE_BODY =
	"This is the only time the key is shown. Copy it now — it cannot be retrieved afterwards, and replacing it means creating another key.";

const REVOKE_LOCATION =
	"You can review this key, see when it was last used, or revoke it on the organization's API keys settings page.";

const REVOKE_LINK_LABEL = "API keys settings";

const COPY_CONFIGURATION_LABEL = "Copy configuration";

const COPY_INSTRUCTION_LABEL = "Copy instruction";

const COPIED_LABEL = "Copied";

const CONFIGURATION_COPIED_ANNOUNCEMENT =
	"Configuration copied to the clipboard.";

const INSTRUCTION_COPIED_ANNOUNCEMENT =
	"Starter instruction copied to the clipboard.";

const COPY_COMMANDS_LABEL = "Copy commands";

const COMMANDS_COPIED_ANNOUNCEMENT = "Commands copied to the clipboard.";

const COPY_FAILED_ANNOUNCEMENT =
	"Copying failed. Select the text and copy it manually.";

/**
 * Said while the configuration is on screen and has NOT been copied.
 *
 * The dialog holds the only plaintext copy of the key — the server keeps a hash
 * — so every incidental dismissal is disarmed until it has been copied. That
 * has to be stated rather than merely felt: a reader who presses Escape and
 * sees nothing happen must be told why, not left wondering whether the key
 * press registered.
 */
const UNCOPIED_DISMISSAL_NOTE =
	"Until you copy the key, Escape and clicking outside will not close this dialog, and the link to the settings page is held back — either would leave with the only copy of it. “Done” closes and discards the key whenever you choose.";

/** Read out when a dismissal is disarmed, so the blocked key press is not silent. */
const DISMISSAL_BLOCKED_ANNOUNCEMENT =
	"The key has not been copied yet, so the dialog stayed open. Copy it, or choose Done to close and discard the key.";

/** Section 3 — the starter instruction. */
const INSTRUCTION_LABEL = "Then say this to your tool";

/**
 * Why the sentence below is a sentence to copy and not a button to press.
 *
 * There is deliberately nothing here that opens a chat for the reader. A
 * destination opened from Fabric carries the prompt text and nothing else — not
 * the configuration block above — so it would start a conversation with a tool
 * that has no Fabric MCP server registered, and fail with no hint that the
 * configuration had to be pasted first (Fizzy #2457).
 */
const INSTRUCTION_INTRO =
	"Copy this sentence and send it in the tool you just configured. It only works there: the configuration above is what gives the tool access to this project.";

/**
 * The local-checkout route. Shown only when `localSetup` names one, and
 * shown FIRST when it does.
 *
 * Two variants, both driven by `localSetup: LocalSetupRoute`:
 *
 * - `{ kind: "upload" }` — this project's instructions are authored in
 *   Fabric. The CLI copies whatever is published into the checkout and
 *   installs a hook that can keep applying updates automatically
 *   (`--apply`), because Fabric is the only writer.
 * - `{ kind: "repository", … }` — this project's instructions arrive with
 *   `git pull`. The CLI never copies files here (a sync hook would be a
 *   second writer with no merge against the developer's own pulls), so the
 *   commands clone the repository and install a REPORT-ONLY hook: it says
 *   when the synced branch has newer published instructions than the
 *   checkout, and the developer's (or their agent's) `git pull` is what
 *   actually updates it. `--apply` is therefore never offered in this
 *   variant — automatic updates for repository checkouts are not available
 *   yet (`docs/guides/coding-instructions-cli.md`, "Repository-sourced
 *   projects").
 *
 * `localSetup: null` (settings still loading, or a repository project with
 * no repository configured yet) renders neither variant: the CLI would
 * refuse `init` for either case, and offering the command would send the
 * reader to a refusal.
 *
 * Two routes, not three steps. The files can reach the tool on disk (this
 * block) or live over MCP (the configuration plus the sentence below). Both
 * need the key this dialog just created; neither needs the other. The
 * checkout route leads, because it is the one to pick for Claude Code, and
 * the MCP route follows as the alternative.
 *
 * The sign-in line carries the key on purpose in both variants: the CLI
 * stores it in its own per-user config and the hook it installs never names
 * it, so this is the one place the key has to be typed — and copying this
 * block is copying the key, which is why it satisfies the dismissal guard
 * exactly as the configuration does.
 */
const ROUTES_INTRO =
	"Two ways to give your tool these instructions. Use either; choose the coding tool you use in the checkout below.";

const LOCAL_SYNC_LABEL = "Recommended: keep the files in your checkout";

const LOCAL_SYNC_INTRO =
	"Run these once in the checkout. The first installs or updates the CLI. The second signs it in with this key and this deployment URL; the CLI keeps both in its own profile, never in the repository, though like any command the line may remain in your shell history. FABRIC_BASE_URL overrides the profile URL when it is set. The third copies whatever is published into the checkout and configures the session-start behavior below. If nothing is published yet, the hook checks for the first version at future session starts. Both tools read the files directly, so the sentence further down is not needed.";

const LOCAL_SYNC_REPOSITORY_LABEL =
	"Recommended: work in a checkout of the repository";

/**
 * The repository variant's intro, replacing `LOCAL_SYNC_INTRO` for that
 * route. Names the branch the sync follows so the reader knows what the
 * session-start hook is comparing the checkout against.
 */
function localSyncRepositoryIntro(ref: string): string {
	return `Run these once. The first two clone the repository this project syncs from and enter the folder its instructions live in. The next installs or updates the CLI. The next signs it in with this key and this deployment URL; the CLI keeps both in its own profile, never in the repository, though like any command the line may remain in your shell history. The last installs a session-start hook that reports when ${ref} has newer published instructions than your checkout and never changes the checkout — git pull does that. Both tools read the files directly, so the sentence further down is not needed.`;
}

type LocalSetupTool = "claude-code" | "codex";

const LOCAL_SETUP_TOOL_LABEL = "Choose your coding tool";

const CODEX_HOOK_TRUST_NOTE =
	"After you start Codex for the first time, use /hooks to review and trust the project hook.";

const APPLY_UPDATES_CHECKBOX_ID = "connect-cli-apply-published-updates";

const APPLY_UPDATES_DESCRIPTION_ID =
	"connect-cli-apply-published-updates-description";

const APPLY_UPDATES_LABEL =
	"Automatically apply published updates at session start";

const APPLY_UPDATES_DESCRIPTION =
	"By default, session-start checks only report published changes and print a command to apply them. Select this option to update local instruction files automatically.";

/** The MCP route's heading when it follows the checkout route. */
const MCP_ROUTE_LABEL = "Or read them live over MCP";

function buildLocalSyncCommands(
	projectId: string,
	rawKey: string,
	baseUrl: string,
	automaticallyApplyUpdates: boolean,
	tool: LocalSetupTool,
): string {
	return [
		"npm install -g @fabricorg/cli",
		`fabric auth login --key ${rawKey} --base-url ${baseUrl}`,
		`fabric instructions init --project ${projectId} --tool ${tool}${
			automaticallyApplyUpdates ? " --apply" : ""
		}`,
	].join("\n");
}

/**
 * The repository variant's five lines: clone (with an explicit target
 * directory), enter the folder the instructions live in, install/update the
 * CLI, sign in, then `init` — never with `--apply` (see the doc comment above
 * `ROUTES_INTRO`). Every argument drawn from server-held data — the clone URL,
 * the directory, the root folder — is quoted with `quoteShellArgIfNeeded` and
 * both `git clone` and `cd` use a `--` option terminator, so a stored path
 * carrying a shell metacharacter (`parseRepoUrl` preserves path characters;
 * it strips only userinfo, query and fragment) or a leading `-` can neither
 * split the pasted block into extra commands nor be read as an option.
 */
function buildRepositorySetupCommands(
	route: Extract<LocalSetupRoute, { kind: "repository" }>,
	projectId: string,
	rawKey: string,
	baseUrl: string,
	tool: LocalSetupTool,
): string {
	const cdTarget = route.rootPath
		? `${route.directory}/${route.rootPath}`
		: route.directory;
	return [
		`git clone -- ${quoteShellArgIfNeeded(route.cloneUrl)} ${quoteShellArgIfNeeded(route.directory)}`,
		`cd -- ${quoteShellArgIfNeeded(cdTarget)}`,
		"npm install -g @fabricorg/cli",
		`fabric auth login --key ${rawKey} --base-url ${baseUrl}`,
		`fabric instructions init --project ${projectId} --tool ${tool}`,
	].join("\n");
}

/**
 * Which entry point opened this dialog, so the one pasted sentence names the
 * thing that surface actually promised — full project context from the
 * project-level prompt/checklist, or specifically the published coding
 * instructions from the Coding Instructions tab. Everything else about the
 * dialog (the mint, the scopes, the configuration) is identical either way.
 */
export type ConnectCliPurpose = "project" | "coding-instructions";

/**
 * The one sentence a reader pastes into their coding tool.
 *
 * Deliberately one sentence and no more, for either purpose. The gateway
 * already ships a handshake `instructions` block to every client that
 * connects, and the tool descriptions chain the first calls themselves, so
 * re-teaching any of that here would spend the only sentence the reader will
 * actually paste on something they are being told twice.
 */
function buildStarterInstruction(
	projectName: string,
	purpose: ConnectCliPurpose,
): string {
	if (purpose === "coding-instructions") {
		return `Use the Fabric MCP server to load the published coding instructions for the project "${projectName}" and follow them while you help me work on it.`;
	}
	return `Use the Fabric MCP server to load the context for the project "${projectName}" and help me work on it.`;
}

const DONE_LABEL = "Done";

const CANCEL_LABEL = "Cancel";

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
 * it, so the command the dialog recommends works with the key it just
 * created.
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
 * viewer's mint is not clamped. `DISCLOSURE_POINTS` says so before the key is
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
 * The endpoint the configuration names.
 *
 * It must be the gateway and never the alternate `/mcp` host. That host
 * verifies personal keys only, so an organization key reaches it, fails to
 * resolve, and the client is handed a *successful* connection with an empty
 * tool list — a reader with no error to read and nothing to fix.
 */
const MCP_GATEWAY_PATH = "/api/mcp-gateway";

/** The organization settings page where the key can later be revoked. */
function apiKeysSettingsPath(organizationSlug: string): string {
	return `/app/${organizationSlug}/settings/api-keys`;
}

/**
 * Build the client configuration with the secret already inlined.
 *
 * An http-type MCP server entry carrying the key as a bearer header: the shape
 * Claude Code, Cursor and VS Code all accept, and the shape the gateway
 * actually authenticates.
 */
function buildMcpConfiguration(origin: string, rawKey: string): string {
	return JSON.stringify(
		{
			mcpServers: {
				fabric: {
					type: "http",
					url: `${origin}${MCP_GATEWAY_PATH}`,
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

type CopyTarget = "configuration" | "instruction" | "command";

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
	 * Which entry point opened this dialog. Changes only the starter
	 * instruction's wording — the mint, the scopes, and the configuration are
	 * the same either way. Defaults to `"project"`, the original prompt/
	 * checklist wording, so every existing caller is unaffected.
	 */
	purpose?: ConnectCliPurpose;
	/**
	 * The project, named in the `fabric instructions init` line below. Only
	 * read on the coding-instructions purpose.
	 */
	projectId?: string;
	/**
	 * Which local-checkout route this project offers, if any — computed by
	 * `localSetupRouteFor` in `lib/instructions-repository-sync.ts` from the
	 * project's source-of-truth setting and (for a repository project) its
	 * sync configuration. `null`/`undefined` renders neither variant: the
	 * setting has not resolved yet, or a repository project has nothing
	 * configured for the CLI to compare against.
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
 * The one place an API key is minted and a finished MCP client configuration is
 * shown.
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
 * while the configuration is on screen and has not been copied, every
 * incidental dismissal — Escape, a click outside, the close button, the link
 * out to settings — is disarmed, leaving "Done" as the one deliberate exit
 * (Fizzy #2457).
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
	const [copied, setCopied] = useState<CopyTarget | null>(null);
	/**
	 * Whether the CONFIGURATION specifically has reached the clipboard.
	 *
	 * Separate from `copied`, which names the most recent copy and is therefore
	 * overwritten the moment the starter instruction is copied — reading the
	 * guards off that would re-arm every dismissal behind the reader's back.
	 * This one latches on the first successful configuration copy and is only
	 * cleared when the view closes.
	 */
	const [keyCopied, setKeyCopied] = useState(false);
	const [automaticallyApplyUpdates, setAutomaticallyApplyUpdates] =
		useState(false);
	const [localSetupTool, setLocalSetupTool] =
		useState<LocalSetupTool>("claude-code");
	const [announcement, setAnnouncement] = useState("");
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
	 * continuation can resolve after either onSuccess (a placeholder copy still
	 * in flight when a mint lands) or a close (a real-key copy still in flight
	 * when the reader hits Done) has already reset the state it is about to
	 * write. Bumped in both of those places; `copy()` captures the generation
	 * before awaiting and discards its result if the generation has moved on,
	 * rather than writing `copied`/`announcement`/`keyCopied` into a view that
	 * has already moved past the copy it started for.
	 */
	const copyGenerationRef = useRef(0);

	/**
	 * The single source of truth for "does a real key exist yet".
	 *
	 * Replaces every place that used to branch on `configuration === null` /
	 * `!== null` now that the configuration and commands blocks render
	 * unconditionally with a placeholder — `configuration` itself is never
	 * `null` any more, so it can no longer stand in for this question.
	 */
	const keyIssued = rawKey !== null;

	// Read on the client only, so the rendered URL cannot differ between the
	// server pass and hydration. Same approach as the API keys settings page.
	useEffect(() => {
		setOrigin(window.location.origin);
	}, []);

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
			// A placeholder copy taken before this mint would otherwise leave
			// a stale "Copied" confirmation sitting beside the real secret —
			// the guard is still correctly armed (`keyCopied` is untouched,
			// and gating it on `keyIssued` in `copy` already keeps it false
			// here), but the visible label would contradict that and could
			// read as "you already copied this one, it's safe to close".
			setCopied(null);
			setAnnouncement("");
			// Fences off a placeholder copy that is still in flight: if its
			// `navigator.clipboard.writeText()` resolves after this point, it
			// must not reinstate "Copied" beside the real key the two lines
			// above just cleared.
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

	// Initial focus lands on the create control when the dialog opens, and
	// moves to the copy control the moment a key is minted: it is the only
	// thing in this view that must happen before the dialog closes, and the
	// secret is unrecoverable if it does not. One effect covers both, because
	// `initialFocusRef` is attached to whichever control is the right target
	// for the current value of `keyIssued` — the create button before, the
	// first copy control after — and this reruns whenever that flips,
	// including the initial mount.
	useEffect(() => {
		initialFocusRef.current?.focus();
	}, [keyIssued]);

	const handleOpenChange = (nextOpen: boolean) => {
		if (!nextOpen) {
			// The secret is gone from the client as soon as this view closes,
			// which is the honest reflection of the warning it just showed.
			setRawKey(null);
			setCopied(null);
			setKeyCopied(false);
			setAutomaticallyApplyUpdates(false);
			setLocalSetupTool("claude-code");
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
		// describes — a placeholder copy resolving after a mint reinstating
		// "Copied" beside the real key, or a real-key copy resolving after a
		// close arming the guard for whatever gets minted next. Neither
		// success nor failure below touches state once the generation has
		// moved.
		const generation = copyGenerationRef.current;
		try {
			await navigator.clipboard.writeText(value);
			if (generation !== copyGenerationRef.current) {
				return;
			}
			setCopied(target);
			// Both blocks carry the key ONCE ONE HAS BEEN MINTED; taking either
			// is taking the key then. Before that, both blocks carry only the
			// placeholder, and copying a template that reads "YOUR_API_KEY" is
			// not taking a secret — gating on `keyIssued` keeps a pre-mint copy
			// from silently disarming the dismissal guard for a key minted
			// later in the same visit.
			if (
				(target === "configuration" || target === "command") &&
				keyIssued
			) {
				setKeyCopied(true);
			}
			setAnnouncement(
				target === "configuration"
					? CONFIGURATION_COPIED_ANNOUNCEMENT
					: target === "instruction"
						? INSTRUCTION_COPIED_ANNOUNCEMENT
						: COMMANDS_COPIED_ANNOUNCEMENT,
			);
		} catch {
			if (generation !== copyGenerationRef.current) {
				return;
			}
			setCopied(null);
			setAnnouncement(COPY_FAILED_ANNOUNCEMENT);
		}
	};

	// Built with the placeholder standing in for `rawKey` until one is minted
	// (design point 3): visibility no longer depends on a key existing, only
	// its CONTENT does.
	const configuration = buildMcpConfiguration(
		origin,
		rawKey ?? PLACEHOLDER_KEY,
	);
	const starterInstruction = buildStarterInstruction(projectName, purpose);
	const isRepositoryRoute = localSetup?.kind === "repository";
	const localSyncCommands =
		purpose === "coding-instructions" && localSetup && projectId
			? localSetup.kind === "repository"
				? buildRepositorySetupCommands(
						localSetup,
						projectId,
						rawKey ?? PLACEHOLDER_KEY,
						// `origin`, not `window.location.origin`: this block now
						// renders unconditionally, including on the server
						// pass, where `window` does not exist.
						// `buildMcpConfiguration` above uses the same
						// hydration-safe state for the same reason.
						origin,
						localSetupTool,
					)
				: buildLocalSyncCommands(
						projectId,
						rawKey ?? PLACEHOLDER_KEY,
						origin,
						automaticallyApplyUpdates,
						localSetupTool,
					)
			: null;
	const cliFirst = localSyncCommands !== null;
	const issueError = createKeyMutation.error;

	/**
	 * A live credential is on screen that exists nowhere else.
	 *
	 * Gated on `keyCopied` and not on `keyIssued` alone: the loss this
	 * guards against is losing the ONLY copy, and once the reader has taken one
	 * there is nothing left to lose. Trapping them past that point would be a
	 * modal that refuses to close for no remaining reason — worse for keyboard
	 * users than the accident it was meant to prevent. False whenever
	 * `!keyIssued`, so a placeholder on screen never arms the guard.
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

	/**
	 * The once-only warning and the disarmed-dismissal note. Rendered exactly
	 * once, in the create-control slot directly under the disclosure, once a
	 * key exists — replacing the create button there, per the single-screen
	 * design (Fizzy #2702). Not repeated under the configuration or commands
	 * block below: both blocks stay in place whether or not a key has been
	 * minted, but this notice is about the KEY, not about either block, so it
	 * has exactly one home regardless of which route (checkout or MCP) the
	 * reader is looking at.
	 */
	const keyNotice = (
		<>
			{uncopiedSecretOnScreen ? (
				<p
					className="text-muted-foreground text-sm"
					data-testid="connect-cli-dismissal-note"
					id="connect-cli-dismissal-note"
				>
					{UNCOPIED_DISMISSAL_NOTE}
				</p>
			) : null}
			{/* Painted in the `--highlight` token pair rather
			 * than the primitive's `warning` variant, which
			 * reaches for a raw Tailwind yellow. */}
			<Alert className="border-highlight/40 bg-highlight/5 text-highlight-ink">
				<AlertTriangleIcon
					aria-hidden="true"
					className="text-highlight"
				/>
				<AlertTitle>{SHOWN_ONCE_TITLE}</AlertTitle>
				<AlertDescription>
					<p>{SHOWN_ONCE_BODY}</p>
					{/* The link is withheld until the
					 * configuration has been copied. It is a
					 * client-side navigation out of the page
					 * this dialog is mounted on, so following
					 * it unmounts the only holder of the
					 * plaintext key — the one exit the
					 * dismissal guards cannot intercept,
					 * because it is not a dismissal. Withheld
					 * rather than confirmed-on-click: the page
					 * it points at is still named in the prose
					 * either way, which is all this paragraph
					 * ever had to do, and the reader is spared
					 * a second modal on top of this one. */}
					<p className="mt-1">
						{organizationSlug && keyCopied ? (
							<>
								{REVOKE_LOCATION}{" "}
								<Link
									className="underline underline-offset-4"
									href={apiKeysSettingsPath(organizationSlug)}
								>
									{REVOKE_LINK_LABEL}
								</Link>
							</>
						) : (
							REVOKE_LOCATION
						)}
					</p>
				</AlertDescription>
			</Alert>
		</>
	);

	return (
		<Dialog open={open} onOpenChange={handleOpenChange}>
			<DialogContent
				className="max-w-2xl"
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
					<DialogTitle className="font-serif font-normal text-2xl">
						{DIALOG_TITLE}
					</DialogTitle>
					<DialogDescription>{DIALOG_DESCRIPTION}</DialogDescription>
				</DialogHeader>

				{/* One polite live region for both copy controls. Kept mounted
				 * across state changes so assistive technology has something to
				 * observe rather than a node appearing mid-announcement. */}
				<p aria-live="polite" className="sr-only">
					{announcement}
				</p>

				{/* One screen from the first open (Fizzy #2702): the disclosure,
				 * the create control, and every setup instruction below all
				 * render unconditionally. Only the create control's own
				 * content, and the KEY each instruction block carries, change
				 * with `keyIssued`. */}
				<div className="min-w-0 space-y-4">
					{/* Section 1. Disclosure, above the create control, so
					 * nothing is minted — and no real key is shown — before
					 * it has been read. */}
					<section
						aria-labelledby="connect-cli-disclosure-label"
						className="space-y-3 rounded-lg border border-border bg-muted/40 p-4"
					>
						<h3
							id="connect-cli-disclosure-label"
							className="app-editorial-label"
						>
							{DISCLOSURE_LABEL}
						</h3>
						<ul className="space-y-2 text-muted-foreground text-sm">
							{disclosurePointsFor(purpose).map((point) => (
								<li
									key={point}
									className="flex items-start gap-2"
								>
									<span
										aria-hidden="true"
										className="mt-2 size-1 shrink-0 rounded-full bg-primary"
									/>
									<span>{point}</span>
								</li>
							))}
						</ul>
					</section>

					{/* Section 2. The create control: directly under the
					 * disclosure and above every instruction block, so
					 * nothing about setup is read before the reader has been
					 * told what the key can do. Before a key exists, the
					 * mint button and its error; once one does, that button
					 * is replaced by `keyNotice` — the create affordance
					 * disappears and the disclosure stays exactly where it
					 * was. */}
					{keyIssued ? (
						keyNotice
					) : (
						<>
							{/* The ONLY place a key is minted. Never on open:
							 * a curious click must leave nothing behind. */}
							<Button
								ref={initialFocusRef}
								autoLoading={false}
								className="w-full"
								loading={createKeyMutation.isPending}
								onClick={() => createKeyMutation.mutate()}
							>
								{createKeyMutation.isPending ? (
									CREATE_KEY_PENDING_LABEL
								) : (
									<>
										<KeyIcon aria-hidden="true" />
										{CREATE_KEY_LABEL}
									</>
								)}
							</Button>
							{issueError ? (
								<Alert variant="error">
									<AlertTriangleIcon aria-hidden="true" />
									<AlertTitle>{ISSUE_ERROR_TITLE}</AlertTitle>
									{/* Always the fallback copy, never `issueError.message`:
									 * this repo is public, and a Prisma or driver
									 * message reaching this alert would paint an
									 * internal detail in front of any organization
									 * member who clicks create. The real error is
									 * logged in the mutation's `onError` instead. */}
									<AlertDescription>
										{ISSUE_ERROR_FALLBACK}
									</AlertDescription>
								</Alert>
							) : null}
						</>
					)}

					{/* Section 3. Setup instructions — shown from the first
					 * open, with `PLACEHOLDER_KEY` standing in for the
					 * blocks below until Section 2 mints a real one. */}
					{cliFirst ? (
						<p className="text-muted-foreground text-sm">
							{ROUTES_INTRO}
						</p>
					) : null}

					{/* The checkout route, first when it applies. */}
					{localSyncCommands ? (
						<section
							aria-labelledby="connect-cli-local-sync-label"
							className="space-y-3"
						>
							<h3
								id="connect-cli-local-sync-label"
								className="app-editorial-label"
							>
								{isRepositoryRoute
									? LOCAL_SYNC_REPOSITORY_LABEL
									: LOCAL_SYNC_LABEL}
							</h3>
							<p className="text-muted-foreground text-sm">
								{isRepositoryRoute &&
								localSetup?.kind === "repository"
									? localSyncRepositoryIntro(localSetup.ref)
									: LOCAL_SYNC_INTRO}
							</p>
							<div className="space-y-2">
								<p
									className="text-sm font-medium"
									id="connect-cli-tool-label"
								>
									{LOCAL_SETUP_TOOL_LABEL}
								</p>
								<RadioGroup
									aria-labelledby="connect-cli-tool-label"
									className="flex gap-4"
									onValueChange={(value) => {
										if (
											value === "claude-code" ||
											value === "codex"
										) {
											setLocalSetupTool(value);
											setCopied(null);
											setAnnouncement("");
										}
									}}
									value={localSetupTool}
								>
									<div className="flex items-center gap-2">
										<RadioGroupItem
											id="connect-cli-tool-claude-code"
											value="claude-code"
										/>
										<Label htmlFor="connect-cli-tool-claude-code">
											Claude Code
										</Label>
									</div>
									<div className="flex items-center gap-2">
										<RadioGroupItem
											id="connect-cli-tool-codex"
											value="codex"
										/>
										<Label htmlFor="connect-cli-tool-codex">
											Codex
										</Label>
									</div>
								</RadioGroup>
							</div>
							{localSetupTool === "codex" ? (
								<p className="text-muted-foreground text-sm">
									{CODEX_HOOK_TRUST_NOTE}
								</p>
							) : null}
							{/* Automatic updates are upload-only: Fabric is the
							 * only writer there. A repository checkout's hook
							 * is report-only (see the doc comment above
							 * `ROUTES_INTRO`), so this option has nothing to
							 * offer for that variant. */}
							{isRepositoryRoute ? null : (
								<div className="flex items-start gap-3 rounded-lg border border-border bg-muted/40 p-3">
									<Checkbox
										aria-describedby={
											APPLY_UPDATES_DESCRIPTION_ID
										}
										checked={automaticallyApplyUpdates}
										id={APPLY_UPDATES_CHECKBOX_ID}
										onCheckedChange={(checked) => {
											setAutomaticallyApplyUpdates(
												checked === true,
											);
											setCopied(null);
											setAnnouncement("");
										}}
									/>
									<div className="flex flex-col gap-1">
										<Label
											className="cursor-pointer"
											htmlFor={APPLY_UPDATES_CHECKBOX_ID}
										>
											{APPLY_UPDATES_LABEL}
										</Label>
										<p
											className="text-muted-foreground text-sm"
											id={APPLY_UPDATES_DESCRIPTION_ID}
										>
											{APPLY_UPDATES_DESCRIPTION}
										</p>
									</div>
								</div>
							)}
							{/* Wraps rather than scrolls: a line longer
							 * than the dialog is wide would otherwise hide
							 * its end behind a scrollbar — the project id,
							 * exactly where it stops being obvious.
							 * `min-w-0` on the wrapper above is what keeps
							 * a block like this from widening the dialog's
							 * grid column and clipping every paragraph. */}
							<pre
								className="whitespace-pre-wrap break-all rounded-lg border border-border bg-muted p-4 font-mono text-xs"
								data-testid="connect-cli-local-sync-command"
							>
								{localSyncCommands}
							</pre>
							<Button
								ref={keyIssued ? initialFocusRef : undefined}
								aria-describedby={
									uncopiedSecretOnScreen
										? "connect-cli-dismissal-note"
										: undefined
								}
								autoLoading={false}
								className="w-full"
								onClick={() =>
									copy("command", localSyncCommands)
								}
							>
								{copied === "command" ? (
									<>
										<CheckIcon aria-hidden="true" />
										{COPIED_LABEL}
									</>
								) : (
									<>
										<CopyIcon aria-hidden="true" />
										{COPY_COMMANDS_LABEL}
									</>
								)}
							</Button>
						</section>
					) : null}

					{/* The MCP route: the configuration, then the sentence. */}
					<section
						aria-labelledby="connect-cli-configuration-label"
						className="space-y-3"
					>
						<h3
							id="connect-cli-configuration-label"
							className="app-editorial-label"
						>
							{cliFirst ? MCP_ROUTE_LABEL : CONFIGURATION_LABEL}
						</h3>
						<p className="text-muted-foreground text-sm">
							{CONFIGURATION_INTRO}
						</p>
						<pre className="overflow-x-auto rounded-lg border border-border bg-muted p-4 text-xs">
							<code data-testid="connect-cli-configuration">
								{configuration}
							</code>
						</pre>
						{keyIssued ? null : (
							<p className="text-muted-foreground text-sm">
								{PLACEHOLDER_KEY_NOTE}
							</p>
						)}
						<Button
							ref={
								keyIssued && !cliFirst
									? initialFocusRef
									: undefined
							}
							// Initial focus lands on the first copy control,
							// so the note below is read out as that
							// control's description — the disarmed
							// dismissals are announced before a reader can
							// discover them by pressing Escape.
							aria-describedby={
								uncopiedSecretOnScreen && !cliFirst
									? "connect-cli-dismissal-note"
									: undefined
							}
							autoLoading={false}
							className="w-full"
							onClick={() => copy("configuration", configuration)}
						>
							{copied === "configuration" ? (
								<>
									<CheckIcon aria-hidden="true" />
									{COPIED_LABEL}
								</>
							) : (
								<>
									<CopyIcon aria-hidden="true" />
									{COPY_CONFIGURATION_LABEL}
								</>
							)}
						</Button>
					</section>

					<section
						aria-labelledby="connect-cli-instruction-label"
						className="space-y-3"
					>
						<h3
							id="connect-cli-instruction-label"
							className="app-editorial-label"
						>
							{INSTRUCTION_LABEL}
						</h3>
						<p className="text-muted-foreground text-sm">
							{INSTRUCTION_INTRO}
						</p>
						<p
							className="rounded-lg border border-border bg-muted/40 p-4 text-sm"
							data-testid="connect-cli-starter-instruction"
						>
							{starterInstruction}
						</p>
						<Button
							autoLoading={false}
							onClick={() =>
								copy("instruction", starterInstruction)
							}
							size="sm"
							variant="outline"
						>
							{copied === "instruction" ? (
								<>
									<CheckIcon aria-hidden="true" />
									{COPIED_LABEL}
								</>
							) : (
								<>
									<CopyIcon aria-hidden="true" />
									{COPY_INSTRUCTION_LABEL}
								</>
							)}
						</Button>
					</section>
				</div>

				<DialogFooter>
					{keyIssued ? (
						<Button
							autoLoading={false}
							onClick={() => handleOpenChange(false)}
						>
							<PlugIcon aria-hidden="true" />
							{DONE_LABEL}
						</Button>
					) : (
						<Button
							autoLoading={false}
							onClick={() => handleOpenChange(false)}
							variant="outline"
						>
							{CANCEL_LABEL}
						</Button>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
