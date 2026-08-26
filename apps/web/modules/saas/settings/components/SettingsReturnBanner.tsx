"use client";

import { RETURN_REDIRECT_EVENT } from "@saas/settings/hooks/use-return-to-redirect";
import {
	clearReturnTo,
	getReturnToFromUrl,
} from "@saas/settings/lib/settings-return-url";
import { Button } from "@ui/components/button";
import { ArrowLeftIcon, CheckCircle2Icon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

/**
 * Banner + overlay shown on Settings pages when the user arrived
 * via a `?returnTo=<path>` link from the project setup flow.
 *
 * Without `returnTo` in the URL, nothing is rendered at all,
 * so direct visits to settings are completely unaffected.
 *
 * Two UI elements:
 * 1. **Idle banner** -- always visible when returnTo is present.
 *    Shows a manual "Return to project" link as a backup.
 * 2. **Center overlay** -- appears after a setting is saved.
 *    Shows a success message with a countdown progress bar
 *    and a "Stay here" cancel option. Can be dismissed by clicking
 *    the backdrop, pressing Escape, or clicking "Stay here".
 */
export function SettingsReturnBanner() {
	const router = useRouter();
	const [returnTo, setReturnTo] = useState<string | null>(null);
	const [redirecting, setRedirecting] = useState(false);
	const [cancelled, setCancelled] = useState(false);
	const dialogRef = useRef<HTMLDivElement>(null);
	const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		const target = getReturnToFromUrl();
		setReturnTo(target);

		const params = new URLSearchParams(window.location.search);

		// Surface OAuth errors from the full-page redirect callback flow.
		// The callback redirects with ?oauth=error&message=... when there's
		// no window.opener (i.e. not a popup).
		if (params.get("oauth") === "error") {
			const message = params.get("message");
			toast.error(
				message
					? decodeURIComponent(message)
					: "OAuth connection failed",
			);
		}

		// Auto-trigger redirect if returning from a successful OAuth flow
		if (target) {
			if (
				params.get("oauth") === "success" ||
				params.get("github_oauth") === "success" ||
				params.get("gitlab_oauth") === "success"
			) {
				setRedirecting(true);
			}
		}
	}, []);

	// Listen for redirect trigger from useReturnToRedirect hook
	useEffect(() => {
		const handler = () => {
			setRedirecting(true);
			setCancelled(false);
		};
		window.addEventListener(RETURN_REDIRECT_EVENT, handler);
		return () => window.removeEventListener(RETURN_REDIRECT_EVENT, handler);
	}, []);

	// Listen for OAuth popup postMessage (covers all popup OAuth flows).
	// Mounted unconditionally so failures surface even when the user
	// did not arrive via a project-setup returnTo link.
	useEffect(() => {
		const handler = (event: MessageEvent) => {
			if (event.origin !== window.location.origin) {
				return;
			}
			const type = event.data?.type;
			if (typeof type !== "string") {
				return;
			}

			if (
				type.includes("oauth_success") &&
				event.data?.success !== false
			) {
				if (returnTo) {
					setRedirecting(true);
					setCancelled(false);
				}
				return;
			}

			if (type.includes("oauth_error") || event.data?.success === false) {
				const message = event.data?.message;
				toast.error(
					typeof message === "string" && message
						? message
						: "OAuth connection failed",
				);
			}
		};

		window.addEventListener("message", handler);
		return () => window.removeEventListener("message", handler);
	}, [returnTo]);

	// Auto-navigate after 3s countdown (matches progress bar animation)
	useEffect(() => {
		if (!redirecting || cancelled || !returnTo) {
			return;
		}

		timerRef.current = setTimeout(() => {
			clearReturnTo();
			router.push(returnTo);
		}, 3000);

		return () => {
			if (timerRef.current) {
				clearTimeout(timerRef.current);
				timerRef.current = null;
			}
		};
	}, [redirecting, cancelled, returnTo, router]);

	const handleStay = () => {
		setCancelled(true);
		setRedirecting(false);
		if (timerRef.current) {
			clearTimeout(timerRef.current);
			timerRef.current = null;
		}
		// Dispatch cancel event so the hook clears its timer
		window.dispatchEvent(new CustomEvent("settings:return-cancel"));
	};

	// Close overlay on Escape key + focus trap
	useEffect(() => {
		if (!redirecting || cancelled) {
			return;
		}

		const handler = (e: KeyboardEvent) => {
			if (e.key === "Escape") {
				handleStay();
			}
		};
		window.addEventListener("keydown", handler);

		// Move focus into the dialog when it opens
		dialogRef.current?.focus();

		return () => window.removeEventListener("keydown", handler);
	}, [redirecting, cancelled]); // eslint-disable-line react-hooks/exhaustive-deps

	// Only render for the project-setup wizard — new AND edit both live at
	// `/projects/new` (edit is `/projects/new?projectId=…`). Scoping to
	// `/projects/new` (not the broader `/projects/`) keeps the banner OUT of
	// the in-project "Add Context" chip flow, whose returnTo is the project
	// detail page `/projects/{id}` — there the "continue project setup" copy
	// would be wrong. (Requirement: switch-back applies to the wizard only.)
	if (!returnTo || !returnTo.includes("/projects/new")) {
		return null;
	}

	const showOverlay = redirecting && !cancelled;

	return (
		<>
			{/* Idle banner — manual "Return to project" backup */}
			<div className="mb-4 flex items-center justify-between rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
				<p className="text-sm text-muted-foreground">
					Complete your configuration, then return to continue project
					setup.
				</p>
				<Button variant="outline" size="sm" asChild>
					<Link href={returnTo}>
						<ArrowLeftIcon className="mr-2 h-4 w-4" />
						Return to project
					</Link>
				</Button>
			</div>

			{/* Center overlay — appears after save with countdown */}
			{showOverlay && (
				<div
					className="fixed inset-0 z-50 flex items-center justify-center bg-black/30"
					onClick={handleStay}
					onKeyDown={(e) => {
						if (e.key === "Escape") {
							handleStay();
						}
					}}
					role="presentation"
				>
					<div
						ref={dialogRef}
						className="w-[420px] overflow-hidden rounded-2xl bg-background shadow-2xl"
						onClick={(e) => e.stopPropagation()}
						onKeyDown={(e) => e.stopPropagation()}
						role="dialog"
						aria-modal="true"
						aria-labelledby="settings-return-dialog-title"
						tabIndex={-1}
					>
						<div className="px-8 pb-6 pt-8 text-center">
							<div className="mx-auto mb-4 flex h-14 w-14 items-center justify-center rounded-full bg-secondary/10">
								<CheckCircle2Icon className="h-7 w-7 text-secondary" />
							</div>
							<h3
								id="settings-return-dialog-title"
								className="mb-2 text-lg font-semibold text-foreground"
							>
								Configuration saved!
							</h3>
							<p className="mb-6 text-sm text-muted-foreground">
								Returning to project setup in 3 seconds...
							</p>
							<Button
								variant="outline"
								size="sm"
								onClick={handleStay}
								className="rounded-lg px-6"
							>
								Stay here
							</Button>
						</div>
						{/* Animated progress bar */}
						<div className="h-1 w-full bg-secondary/10">
							<div
								className="h-full bg-secondary"
								style={{
									animation:
										"settings-return-shrink 3s linear forwards",
								}}
							/>
						</div>
						{/* Global keyframes — plain <style> tag avoids styled-jsx dependency */}
						{/* biome-ignore lint/security/noDangerouslySetInnerHtml: keyframe injection for progress animation */}
						<style
							dangerouslySetInnerHTML={{
								__html: "@keyframes settings-return-shrink{from{width:100%}to{width:0%}}",
							}}
						/>
					</div>
				</div>
			)}
		</>
	);
}
