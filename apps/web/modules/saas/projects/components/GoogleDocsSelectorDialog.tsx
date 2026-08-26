"use client";

/**
 * Google Docs selector — Google Picker launcher.
 *
 * We swapped our in-house list/search dialog for Google's hosted Picker so the
 * OAuth scope can drop from `drive.readonly` (Restricted — CASA audit, ~$10–
 * 20K) to `drive.file` (Sensitive — doc/video review only). `drive.file` only
 * grants per-file access for files the user picks via the Picker or that our
 * app creates, which is precisely the access pattern this feature needs.
 *
 * Flow:
 *   1. Dialog opens. Fetch the picker session
 *      (`projects.contexts.googleDocsPickerSession`).
 *   2. If not connected / reconnect required / misconfigured: render an error
 *      state inside our Dialog with a link to Settings → Integrations.
 *   3. Otherwise: lazy-load `https://apis.google.com/js/api.js`, then
 *      `gapi.load('picker', …)`, then open Google's Picker (DocsView limited
 *      to `MimeTypes.DOCUMENT`). The Picker is its own modal — we keep our
 *      Dialog open as a backdrop only so the user has a familiar "Cancel"
 *      affordance if Google's modal fails to mount for any reason.
 *   4. On PICKED: send the file IDs/titles/urls to
 *      `projects.contexts.addGoogleDocs`, invalidate the project contexts
 *      query, toast a result, close.
 */

import { useContextPath } from "@saas/organizations/hooks/use-organization-context";
import { useSettingsReturnUrl } from "@saas/settings/hooks/use-settings-return-url";
import { GoogleDriveIcon } from "@saas/workflows/lib/plugins/google-drive/icon";
import { orpcClient } from "@shared/lib/orpc-client";
import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { AlertCircleIcon, Loader2Icon, SettingsIcon } from "lucide-react";
import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";

type Props = {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	projectId: string;
	organizationId?: string | null;
	/**
	 * Fired once after a successful add. Lets a parent dialog (e.g.
	 * `ContextUploaderDialog`) close its own modal + emit analytics only when
	 * docs actually landed, not when the user merely cancelled the picker.
	 */
	onAdded?: (result: {
		created: number;
		duplicates: number;
		skipped: number;
		failed: number;
		authFailed: number;
	}) => void;
};

// Backend caps `addGoogleDocs` at 20 files per batch; the Picker has no
// built-in cap so we trim before posting.
const MAX_BATCH = 20;

// Minimal Picker typings — we don't pull in @types/google.picker to keep the
// dependency surface zero. The fields we touch are all stable v1 API.
type PickerDocument = {
	id: string;
	name?: string;
	url?: string;
	mimeType?: string;
};
type PickerResponse = {
	action: string;
	docs?: PickerDocument[];
};
type PickerInstance = { setVisible: (visible: boolean) => void };
type PickerBuilderInstance = {
	addView: (view: unknown) => PickerBuilderInstance;
	setOAuthToken: (token: string) => PickerBuilderInstance;
	setDeveloperKey: (key: string) => PickerBuilderInstance;
	setAppId: (appId: string) => PickerBuilderInstance;
	setCallback: (
		cb: (response: PickerResponse) => void,
	) => PickerBuilderInstance;
	setOrigin: (origin: string) => PickerBuilderInstance;
	setTitle: (title: string) => PickerBuilderInstance;
	build: () => PickerInstance;
};
type GapiWindow = Window & {
	gapi?: {
		// The second arg accepts an options object too, per Google's docs:
		// https://developers.google.com/identity/sign-in/web/reference#gapiload
		load: (
			apiName: string,
			callbackOrOptions:
				| (() => void)
				| {
						callback: () => void;
						onerror?: (error: unknown) => void;
						timeout?: number;
						ontimeout?: () => void;
				  },
		) => void;
	};
	google?: {
		picker: {
			Action: { PICKED: string; CANCEL: string };
			ViewId: { DOCUMENTS: string };
			DocsView: new (
				viewId?: string,
			) => {
				setMimeTypes: (mimeTypes: string) => unknown;
				setIncludeFolders: (include: boolean) => unknown;
				setOwnedByMe: (owned: boolean) => unknown;
			};
			PickerBuilder: new () => PickerBuilderInstance;
		};
	};
};

const PICKER_SCRIPT_SRC = "https://apis.google.com/js/api.js";
const DOC_MIME = "application/vnd.google-apps.document";

const PICKER_LOAD_TIMEOUT_MS = 10_000;

let pickerScriptPromise: Promise<void> | null = null;
function loadPickerScript(signal?: AbortSignal): Promise<void> {
	if (typeof window === "undefined") {
		return Promise.reject(new Error("Picker requires a browser"));
	}
	const w = window as GapiWindow;
	if (w.gapi) {
		return Promise.resolve();
	}
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	// `??=` removes the theoretical race where two synchronous callers see a
	// null cache and both run `new Promise(...)`. Functionally equivalent to
	// the prior `if/return` guard, but eliminates the doubt.
	pickerScriptPromise ??= new Promise<void>((resolve, reject) => {
		// `data-picker` lets us identify and remove the tag we created vs a
		// pre-existing one a different consumer injected. Distinguishing them
		// matters at error time — we should clean up our own tag, but leave
		// someone else's alone.
		const ownAttr = "data-fabric-picker-script";
		const existing = document.querySelector<HTMLScriptElement>(
			`script[src="${PICKER_SCRIPT_SRC}"]`,
		);
		if (existing) {
			// A prior consumer (HMR, another component) may have already loaded
			// the script — in that case `load` will never re-fire, so poll for
			// `gapi` to bridge until it appears, with a hard timeout so we
			// don't hang forever when the script genuinely failed.
			const start = Date.now();
			let intervalId = 0;
			const settle = () => {
				if ((window as GapiWindow).gapi) {
					resolve();
					return true;
				}
				return false;
			};
			const cleanup = () => {
				window.clearInterval(intervalId);
				existing.removeEventListener("error", onError);
				signal?.removeEventListener("abort", onAbort);
			};
			const onAbort = () => {
				cleanup();
				pickerScriptPromise = null;
				reject(new DOMException("Aborted", "AbortError"));
			};
			const onError = () => {
				cleanup();
				// The existing tag isn't ours; don't remove it. But clear our
				// cache so a retry can re-evaluate the world.
				pickerScriptPromise = null;
				reject(new Error("Failed to load Google Picker script"));
			};
			if (settle()) {
				return;
			}
			if (signal?.aborted) {
				onAbort();
				return;
			}
			signal?.addEventListener("abort", onAbort);
			existing.addEventListener("error", onError);
			intervalId = window.setInterval(() => {
				if (settle()) {
					cleanup();
					return;
				}
				if (Date.now() - start > PICKER_LOAD_TIMEOUT_MS) {
					cleanup();
					pickerScriptPromise = null;
					reject(
						new Error(
							"Timed out waiting for the Google Picker script to initialize.",
						),
					);
				}
			}, 100);
			return;
		}
		const script = document.createElement("script");
		script.src = PICKER_SCRIPT_SRC;
		script.async = true;
		script.defer = true;
		script.setAttribute(ownAttr, "true");
		const removeOwnScript = () => {
			if (script.parentNode) {
				script.remove();
			}
		};
		const onAbort = () => {
			signal?.removeEventListener("abort", onAbort);
			removeOwnScript();
			pickerScriptPromise = null;
			reject(new DOMException("Aborted", "AbortError"));
		};
		script.onload = () => {
			signal?.removeEventListener("abort", onAbort);
			resolve();
		};
		script.onerror = () => {
			signal?.removeEventListener("abort", onAbort);
			// Reset the cached promise so a subsequent attempt can retry
			// (e.g. transient network blip on first open). Also remove the
			// dead tag so the next call's `querySelector` doesn't find it
			// and start polling a corpse.
			removeOwnScript();
			pickerScriptPromise = null;
			reject(new Error("Failed to load Google Picker script"));
		};
		if (signal?.aborted) {
			onAbort();
			return;
		}
		signal?.addEventListener("abort", onAbort);
		document.head.appendChild(script);
	});
	return pickerScriptPromise;
}

function loadPickerModule(signal?: AbortSignal): Promise<void> {
	const w = window as GapiWindow;
	if (w.google?.picker) {
		return Promise.resolve();
	}
	const gapi = w.gapi;
	if (!gapi) {
		return Promise.reject(new Error("gapi not loaded"));
	}
	if (signal?.aborted) {
		return Promise.reject(new DOMException("Aborted", "AbortError"));
	}
	return new Promise<void>((resolve, reject) => {
		const onAbort = () => {
			signal?.removeEventListener("abort", onAbort);
			reject(new DOMException("Aborted", "AbortError"));
		};
		signal?.addEventListener("abort", onAbort);
		// Use the options form of gapi.load so a CDN hang / regional outage
		// produces a real rejection instead of a forever-pending promise that
		// strands the dialog on "Opening Google Picker…".
		gapi.load("picker", {
			callback: () => {
				signal?.removeEventListener("abort", onAbort);
				resolve();
			},
			onerror: (error) => {
				signal?.removeEventListener("abort", onAbort);
				reject(
					error instanceof Error
						? error
						: new Error(
								`Failed to load Google Picker module: ${String(error)}`,
							),
				);
			},
			timeout: PICKER_LOAD_TIMEOUT_MS,
			ontimeout: () => {
				signal?.removeEventListener("abort", onAbort);
				reject(
					new Error("Timed out loading the Google Picker module."),
				);
			},
		});
	});
}

export function GoogleDocsSelectorDialog({
	open,
	onOpenChange,
	projectId,
	organizationId,
	onAdded,
}: Props) {
	const queryClient = useQueryClient();
	const integrationsSettingsUrlRaw = useContextPath("settings/integrations");
	const buildReturnUrl = useSettingsReturnUrl();
	const integrationsSettingsUrl = buildReturnUrl(integrationsSettingsUrlRaw);

	// True only while we're loading the SDK / showing the Picker — used to
	// suppress our Dialog's body so the Picker isn't fighting it visually.
	const [pickerOpen, setPickerOpen] = useState(false);
	const pickerInstanceRef = useRef<PickerInstance | null>(null);
	// Tracks whether the dialog has been closed mid-load. Reset by the OPEN
	// effect (so React StrictMode's mount→unmount→mount can't latch it to
	// true), set by the close effect, and inspected after every await in
	// `openPicker` so we don't mount a Picker iframe on top of an
	// already-dismissed Dialog (would leave an orphan modal with no backdrop).
	const cancelledRef = useRef(false);
	// AbortController tied to a single picker-open attempt; aborted when the
	// dialog closes so any in-flight `loadPickerScript` poll / `gapi.load`
	// can tear down its timers + listeners synchronously rather than running
	// to a (now-pointless) completion.
	const pickerAbortRef = useRef<AbortController | null>(null);

	const sessionQuery = useQuery({
		queryKey: [
			"google-docs-picker-session",
			projectId,
			organizationId ?? null,
		],
		// Always re-issue on each open: tokens expire quickly (~1h).
		staleTime: 0,
		gcTime: 0,
		enabled: open,
		queryFn: async () =>
			orpcClient.projects.contexts.googleDocsPickerSession({
				projectId,
				organizationId: organizationId ?? null,
			}),
	});

	const addMutation = useMutation({
		mutationFn: async (
			files: Array<{ id: string; title: string; url?: string }>,
		) =>
			orpcClient.projects.contexts.addGoogleDocs({
				projectId,
				organizationId: organizationId ?? null,
				files,
			}),
		onSuccess: (result) => {
			let message = `Added ${result.created} document${result.created !== 1 ? "s" : ""}`;
			if (result.duplicates > 0) {
				message += `, ${result.duplicates} already added`;
			}
			if (result.skipped > 0) {
				message += `, ${result.skipped} skipped (project context limit reached)`;
			}
			if (result.failed > 0) {
				message += `, ${result.failed} failed`;
			}
			// Pick the toast severity by outcome instead of always using
			// `success`. `authFailed > 0` means a token revocation invalidated
			// the whole batch — the user needs to reconnect Google, not retry,
			// so we surface the strongest CTA. `failed > 0 && !authFailed` is
			// a partial success — warn so the user notices the per-doc errors
			// in the contexts list.
			if (result.authFailed > 0) {
				toast.error(
					"Reconnect Google in Settings → Integrations and try again — the previous session expired during import.",
				);
			} else if (result.failed > 0) {
				toast.warning(message);
			} else {
				toast.success(message);
			}
			void queryClient.invalidateQueries({
				queryKey: orpc.projects.contexts.list.queryOptions({
					input: {
						projectId,
						organizationId: organizationId ?? null,
					},
				}).queryKey,
			});
			// Let the parent react to the *successful* add (analytics, close
			// its own modal). Distinct from `onOpenChange(false)` which also
			// fires on cancel — without this split, an "Add Context" wrapper
			// can't tell the two apart.
			onAdded?.(result);
			// Only ask the parent to close if it's still open — closing an
			// already-closed dialog is a no-op today, but guarding makes the
			// intent obvious and protects against `onOpenChange` parents that
			// treat repeat-close as a real event.
			if (!cancelledRef.current) {
				onOpenChange(false);
			}
		},
		onError: (err: Error & { data?: unknown }) => {
			// If the user closed the dialog mid-mutation, surface the failure
			// at warn-level instead of an error toast — they aren't watching.
			if (cancelledRef.current) {
				console.warn(
					"[GoogleDocsSelectorDialog] addGoogleDocs failed after dialog close:",
					err,
				);
				return;
			}
			toast.error(
				err.message ||
					(err.data as { message?: string } | undefined)?.message ||
					"Failed to add Google Docs",
			);
		},
	});

	const handlePicked = useCallback(
		(response: PickerResponse) => {
			const w = window as GapiWindow;
			const action = response.action;
			if (action === w.google?.picker.Action.PICKED) {
				const picks = (response.docs ?? [])
					.filter((doc) => doc.mimeType === DOC_MIME)
					.slice(0, MAX_BATCH)
					.map((doc) => ({
						id: doc.id,
						title: doc.name ?? "Untitled",
						url: doc.url,
					}));
				if (picks.length === 0) {
					toast.info("No Google Docs were selected.");
					setPickerOpen(false);
					return;
				}
				setPickerOpen(false);
				addMutation.mutate(picks);
			} else if (action === w.google?.picker.Action.CANCEL) {
				setPickerOpen(false);
			}
		},
		[addMutation],
	);

	const openPicker = useCallback(async () => {
		let session = sessionQuery.data;
		if (!session?.accessToken || !session.developerKey || !session.appId) {
			return;
		}
		// Tear down any previous attempt's abort hooks before starting a new
		// one. The open effect resets `cancelledRef`, so by the time we get
		// here it's always false.
		pickerAbortRef.current?.abort();
		const abortController = new AbortController();
		pickerAbortRef.current = abortController;
		const signal = abortController.signal;
		setPickerOpen(true);
		// Google access tokens are ~1h; the helper refreshes inside a 60s
		// buffer. If the user opened the dialog earlier and is only now
		// triggering the Picker, the cached session may already be close to
		// dying — re-fetch when <120s of life remains so the Picker iframe
		// doesn't mount with a token that expires mid-interaction.
		if (
			session.expiresAt !== null &&
			session.expiresAt - Date.now() < 120_000
		) {
			try {
				const fresh = await sessionQuery.refetch();
				if (fresh.data?.accessToken) {
					session = fresh.data;
				}
			} catch {
				// Refetch failures fall through to the load below; the next
				// Picker auth error will surface them.
			}
			if (signal.aborted) {
				return;
			}
		}
		let stage: "script" | "module" | "build" = "script";
		try {
			await loadPickerScript(signal);
			if (cancelledRef.current || signal.aborted) {
				return;
			}
			stage = "module";
			await loadPickerModule(signal);
			if (cancelledRef.current || signal.aborted) {
				return;
			}
			stage = "build";
			const w = window as GapiWindow;
			if (!w.google?.picker) {
				throw new Error("Picker module did not load");
			}
			// Re-narrow after the optional refetch above reassigned `session`.
			const { accessToken, developerKey, appId } = session;
			if (!accessToken || !developerKey || !appId) {
				return;
			}
			const docsView = new w.google.picker.DocsView(
				w.google.picker.ViewId.DOCUMENTS,
			);
			docsView.setMimeTypes(DOC_MIME);
			docsView.setIncludeFolders(false);
			const picker = new w.google.picker.PickerBuilder()
				.addView(docsView)
				.setOAuthToken(accessToken)
				.setDeveloperKey(developerKey)
				.setAppId(appId)
				.setCallback(handlePicked)
				.setOrigin(window.location.origin)
				.setTitle("Select Google Docs")
				.build();
			// One last check before exposing the iframe — if the user closed our
			// Dialog while the builder ran, swallow the picker silently.
			if (cancelledRef.current || signal.aborted) {
				picker.setVisible(false);
				return;
			}
			pickerInstanceRef.current = picker;
			picker.setVisible(true);
		} catch (error) {
			// AbortError only counts as "this dialog was cancelled" when
			// `signal` itself aborted. The module-level `pickerScriptPromise`
			// is shared across both mount surfaces (Settings + ContextUploader
			// dialog), so another instance's abort can settle our pending
			// await with the SAME AbortError — without resetting our local
			// state, this dialog would stay stuck on "Opening Google
			// Picker…" indefinitely. Distinguish via `signal.aborted`.
			const isOurAbort =
				error instanceof DOMException &&
				error.name === "AbortError" &&
				signal.aborted;
			if (isOurAbort) {
				return;
			}
			setPickerOpen(false);
			// Foreign-AbortError (another dialog cancelled the shared script
			// load) is recoverable — surface a soft retry message and clear
			// telemetry, no error toast.
			if (error instanceof DOMException && error.name === "AbortError") {
				console.warn(
					"[GoogleDocsSelectorDialog] Picker load was cancelled by another consumer; retry by reopening.",
				);
				toast.info("Picker load was interrupted. Please try again.");
				return;
			}
			// Telemetry for CDN / regional Picker outages — without this, we
			// only learn about them from support tickets. Stage tells us which
			// step blew up.
			console.error(
				`[GoogleDocsSelectorDialog] Picker open failed at "${stage}" step:`,
				error,
			);
			const message =
				error instanceof Error
					? error.message
					: "Failed to open Google Picker";
			toast.error(message);
		}
	}, [handlePicked, sessionQuery.data]);

	// Auto-open the Picker as soon as a healthy session lands. The user already
	// clicked "Add from Google Docs"; making them click a second button inside
	// our Dialog would be empty ceremony.
	useEffect(() => {
		const session = sessionQuery.data;
		if (
			open &&
			session &&
			session.isConnected &&
			!session.requiresReconnect &&
			session.accessToken &&
			!pickerOpen &&
			!addMutation.isPending
		) {
			void openPicker();
		}
	}, [
		open,
		sessionQuery.data,
		pickerOpen,
		addMutation.isPending,
		openPicker,
	]);

	// Reset the cancellation flag when the dialog opens. Doing this here
	// instead of inside `openPicker` makes the ordering deterministic with
	// respect to React effect timing — the close effect's `true` write and
	// this open effect's `false` write are both bound to renders, so they
	// can't race against an in-flight promise.
	useEffect(() => {
		if (open) {
			cancelledRef.current = false;
		}
	}, [open]);

	// Tear down transient state + abort any in-flight load when the dialog
	// closes. The cancellation flag also makes any synchronous code path in
	// `openPicker` that's already past an await bail before mounting the
	// iframe.
	useEffect(() => {
		if (!open) {
			cancelledRef.current = true;
			pickerAbortRef.current?.abort();
			pickerAbortRef.current = null;
			setPickerOpen(false);
			pickerInstanceRef.current?.setVisible(false);
			pickerInstanceRef.current = null;
		}
	}, [open]);

	const session = sessionQuery.data;
	const loading = sessionQuery.isLoading || sessionQuery.isFetching;
	const errorMessage =
		sessionQuery.error instanceof Error
			? sessionQuery.error.message
			: (session?.error ?? null);

	const showReconnect = session?.requiresReconnect === true;
	const showNotConnected =
		!loading && !showReconnect && session?.isConnected === false;
	// Coerce to a real boolean — `session?.accessToken` would otherwise leak a
	// non-empty string into JSX conditional rendering and render the token.
	const showPickerActive =
		pickerOpen ||
		addMutation.isPending ||
		(!loading && Boolean(session?.accessToken));

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle className="flex items-center gap-2">
						<GoogleDriveIcon className="size-5 text-muted-foreground" />
						Select Google Docs
					</DialogTitle>
					<DialogDescription>
						Pick Google Docs from your Google Drive to add as
						project context.
					</DialogDescription>
				</DialogHeader>

				{loading ? (
					<div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
						<Loader2Icon className="size-4 animate-spin" />
						<span className="text-sm">Connecting to Google…</span>
					</div>
				) : showReconnect ? (
					<div className="rounded-lg border border-highlight/40 bg-highlight/10 p-4">
						<div className="flex items-start gap-2 text-foreground">
							<AlertCircleIcon className="size-5 mt-0.5 text-highlight" />
							<div className="space-y-3">
								<div>
									<p className="font-medium">
										Reconnect Google to continue
									</p>
									<p className="text-sm text-muted-foreground mt-1">
										{errorMessage ??
											"Fabric needs a new Google permission to open the Docs picker."}
									</p>
								</div>
								<Button variant="outline" size="sm" asChild>
									<Link href={integrationsSettingsUrl}>
										<SettingsIcon className="size-4 mr-2" />
										Open Integrations
									</Link>
								</Button>
							</div>
						</div>
					</div>
				) : showNotConnected ? (
					<div className="rounded-lg border border-highlight/40 bg-highlight/10 p-4">
						<div className="flex items-start gap-2 text-foreground">
							<AlertCircleIcon className="size-5 mt-0.5 text-highlight" />
							<div className="space-y-3">
								<div>
									<p className="font-medium">
										Google Drive is not connected
									</p>
									<p className="text-sm text-muted-foreground mt-1">
										{errorMessage ??
											"Connect your Google account to pick Docs."}
									</p>
								</div>
								<Button variant="outline" size="sm" asChild>
									<Link href={integrationsSettingsUrl}>
										<SettingsIcon className="size-4 mr-2" />
										Open Integrations
									</Link>
								</Button>
							</div>
						</div>
					</div>
				) : errorMessage ? (
					<div className="rounded-lg border border-destructive/50 bg-destructive/10 p-4 text-destructive">
						<div className="flex items-start gap-2">
							<AlertCircleIcon className="size-5 mt-0.5" />
							<p className="text-sm">{errorMessage}</p>
						</div>
					</div>
				) : showPickerActive ? (
					<div className="flex items-center justify-center gap-2 py-6 text-muted-foreground">
						<Loader2Icon className="size-4 animate-spin" />
						<span className="text-sm">
							{addMutation.isPending
								? "Adding selected documents…"
								: "Opening Google Picker…"}
						</span>
					</div>
				) : null}

				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={addMutation.isPending}
					>
						Close
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
