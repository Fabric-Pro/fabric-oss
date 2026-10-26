"use client";

import type { DatabricksDashboard } from "@databricks/aibi-client";
import { orpcClient } from "@shared/lib/orpc-client";
import { Button } from "@ui/components/button";
import { Skeleton } from "@ui/components/skeleton";
import { useTheme } from "next-themes";
import { useEffect, useRef, useState } from "react";
import { isReplayNotFound } from "./decision-replay";
import { loadReplayDashboard } from "./decision-replay-dashboard-client";
import { createReplayTokenLifecycle } from "./decision-replay-token-lifecycle";

type EmbedResult = Awaited<
	ReturnType<typeof orpcClient.projects.decisionReplay.getEmbedToken>
>;

export function DecisionReplayDashboard({
	projectId,
	onNotFound,
}: {
	projectId: string;
	onNotFound?: () => void;
}) {
	const container = useRef<HTMLDivElement>(null);
	const [attempt, setAttempt] = useState(0);
	const [status, setStatus] = useState<
		"loading" | "ready" | "unavailable" | "not_configured"
	>("loading");
	const { resolvedTheme } = useTheme();
	const theme = useRef(resolvedTheme);
	theme.current = resolvedTheme;
	const notFoundCallback = useRef(onNotFound);
	notFoundCallback.current = onNotFound;
	useEffect(() => {
		const frame = container.current?.querySelector("iframe");
		if (frame) {
			frame.style.colorScheme =
				resolvedTheme === "dark" ? "dark" : "light";
		}
	}, [resolvedTheme]);
	useEffect(() => {
		let active = true;
		let showSequence = 0;
		let dashboard: DatabricksDashboard | undefined;
		let frame: HTMLIFrameElement | null = null;
		let loadTimeout: ReturnType<typeof setTimeout> | undefined;
		let onLoad: (() => void) | undefined;
		const host = container.current;
		// Isolate late SDK error rendering from a replacement project's frame.
		const sdkContainer = document.createElement("div");
		sdkContainer.className = "h-full w-full";
		host?.append(sdkContainer);
		setStatus("loading");
		function destroyFrame() {
			clearTimeout(loadTimeout);
			if (onLoad) {
				frame?.removeEventListener("load", onLoad);
			}
			dashboard?.destroy();
			dashboard = undefined;
			sdkContainer.replaceChildren();
		}
		function finish(next: "unavailable" | "not_configured") {
			if (!active) {
				return;
			}
			active = false;
			lifecycle.dispose();
			removeListeners();
			destroyFrame();
			sdkContainer.remove();
			setStatus(next);
		}
		function unavailable() {
			finish("unavailable");
		}
		async function showToken(
			result: Extract<EmbedResult, { available: true }>,
			recreate: boolean,
		) {
			if (!recreate) {
				return;
			}
			const sequence = ++showSequence;
			destroyFrame();
			setStatus("loading");
			try {
				const { DatabricksDashboard } = await loadReplayDashboard();
				if (!active || sequence !== showSequence) {
					return;
				}
				if (Date.now() >= Date.parse(result.expiresAt)) {
					lifecycle.wake();
					return;
				}
				// Only the SDK receives this token. Its iframe fragment is not sent
				// to servers or in Referer; Fabric never reads the iframe src.
				dashboard = new DatabricksDashboard({
					instanceUrl: result.instanceUrl,
					workspaceId: result.workspaceId,
					dashboardId: result.dashboardId,
					token: result.token,
					container: sdkContainer,
					getNewToken: lifecycle.getNewToken,
					colorScheme: theme.current === "dark" ? "dark" : "light",
					config: { version: 1, hideDatabricksLogo: true },
				});
				dashboard.initialize();
				lifecycle.confirmMounted(result);
				frame = sdkContainer.querySelector("iframe");
				if (!frame) {
					unavailable();
					return;
				}
				frame.title = "AI outcomes trends and details";
				onLoad = () => {
					if (!active) {
						return;
					}
					clearTimeout(loadTimeout);
					setStatus("ready");
				};
				frame.addEventListener("load", onLoad, { once: true });
				loadTimeout = setTimeout(unavailable, 30_000);
			} catch {
				if (active && sequence === showSequence) {
					unavailable();
				}
			}
		}
		const lifecycle = createReplayTokenLifecycle({
			mint: async () => {
				const result =
					await orpcClient.projects.decisionReplay.getEmbedToken({
						projectId,
					});
				if (!result.available && result.reason === "not_configured") {
					// Disposal closes minting, rejects SDK waiters and clears deadlines.
					finish("not_configured");
				}
				if (!result.available || !host) {
					throw new Error("Dashboard access unavailable");
				}
				return result;
			},
			onToken: (result, recreate) => {
				void showToken(result, recreate);
			},
			onUnavailable: unavailable,
			onError: (error) => {
				if (isReplayNotFound(error)) {
					notFoundCallback.current?.();
				}
			},
		});
		function onVisible() {
			if (document.visibilityState === "visible") {
				lifecycle.wake();
			}
		}
		function removeListeners() {
			window.removeEventListener("online", lifecycle.wake);
			document.removeEventListener("visibilitychange", onVisible);
		}
		window.addEventListener("online", lifecycle.wake);
		document.addEventListener("visibilitychange", onVisible);
		lifecycle.start();
		return () => {
			active = false;
			lifecycle.dispose();
			removeListeners();
			destroyFrame();
			sdkContainer.remove();
		};
	}, [projectId, attempt]);
	return (
		<div className="space-y-3">
			{status !== "not_configured" && (
				<p className="text-xs text-muted-foreground">
					Refreshes on a schedule, so new decisions can take several
					hours to appear
				</p>
			)}
			{/* The SDK cannot size the iframe to its content. 1360px fits the longest
			    dashboard page as measured on staging at desktop width (1312px of
			    content plus a 43px tab bar), so it shows without an inner scrollbar.
			    Re-measure after adding dashboard rows; narrow screens stack and scroll. */}
			<div
				hidden={status === "not_configured"}
				className={
					status === "not_configured"
						? undefined
						: "relative h-340 overflow-hidden rounded-lg border border-border"
				}
			>
				<div ref={container} className="h-full w-full" />
				{status === "loading" && (
					// biome-ignore lint/a11y/useSemanticElements: This status region contains a skeleton or retry controls.
					<div
						role="status"
						aria-label="Loading trends"
						className="absolute inset-0"
					>
						<Skeleton className="h-full w-full" />
					</div>
				)}
				{status === "unavailable" && (
					// biome-ignore lint/a11y/useSemanticElements: This status region contains a skeleton or retry controls.
					<div
						role="status"
						className="absolute inset-0 flex flex-col items-center justify-center gap-3 bg-card text-sm"
					>
						<p>Trends are unavailable right now</p>
						<Button
							variant="outline"
							onClick={() => setAttempt((n) => n + 1)}
						>
							Try again
						</Button>
					</div>
				)}
			</div>
			{/* biome-ignore lint/a11y/useSemanticElements: This persistent live region announces a notice, not a calculation result. */}
			<div role="status">
				{status === "not_configured" && (
					<p className="rounded-lg border border-border p-4 text-sm text-muted-foreground">
						Trends aren't set up in this environment yet.
					</p>
				)}
			</div>
		</div>
	);
}
