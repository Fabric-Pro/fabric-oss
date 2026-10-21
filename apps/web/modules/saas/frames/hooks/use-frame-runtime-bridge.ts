"use client";

import { declarationOf } from "@repo/temporal/fabric-page-tool-definitions";
import { readConfirmationPolicy } from "@repo/temporal/fabric-tool-definition";
import {
	callFabricTool,
	FabricToolError,
	listFabricTools,
} from "@saas/mcp/lib/fabric-tool-client";
import { useOrganizationId } from "@saas/organizations/hooks/use-organization-context";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveBase64File } from "../lib/download-file";
import {
	isFrameRuntimeRequest,
	resolveEmbedOrigin,
} from "../lib/frame-embed-protocol";
import {
	approvalKeyOf,
	approve,
	isApproved,
} from "../lib/frame-runtime-approvals";
import {
	createFrameRuntimeHost,
	type FrameRuntimeCallLifetime,
	type FrameRuntimeToolInfo,
} from "../lib/frame-runtime-host";
import {
	type ConfirmEveryBecause,
	createPageTaint,
} from "../lib/page-approval-rules";
import type { PageDownload } from "../lib/page-download";

/**
 * Wires a frame shell to the page runtime of the pages it frames: it listens
 * for `window.fabric` requests the embed relays up, lets the host logic in
 * `lib/frame-runtime-host` decide, and answers the embed that asked. What this
 * file adds is the browser side of that decision: who is allowed to speak, the
 * viewer's approval of a tool or a file, whether the page has read outside its
 * own store, and the app calls (the tool gateway and the router).
 */

async function loadToolInfo(
	organizationId: string | null,
): Promise<ReadonlyMap<string, FrameRuntimeToolInfo>> {
	const tools = await listFabricTools({ organizationId });
	return new Map(
		tools.map((tool) => [
			tool.name,
			{
				readOnlyHint: tool.annotations?.readOnlyHint,
				confirm: readConfirmationPolicy(tool._meta),
			},
		]),
	);
}

export interface FrameRuntimeBridgeOptions {
	/** Identifies the page for the viewer's approvals; the frame id when there is one. */
	frameKey: string;
	/**
	 * The page's own frame, which every call is made for. A page with none (it
	 * is not saved) may not call Fabric.
	 */
	frameId: string | null;
	/**
	 * What the page version on screen hashes to (`frameContentFingerprint`). An
	 * approval is kept for this version only, so an edited page asks again; with
	 * none, every write asks.
	 */
	contentFingerprint: string | null;
	/** Synchronous content identity; hashing a replacement must not retain its predecessor's consent. */
	contentVersion: string | null;
	/** The organization the page belongs to; a page of another one is refused. */
	organizationId: string | null;
	/** Tools the page declared; none means every call is refused. */
	runtimeTools: readonly string[];
	/**
	 * The embed windows this shell frames. A request counts only from one of
	 * them: the sandboxed page itself can post to any ancestor, and none of
	 * those posts may be believed.
	 */
	embedWindows: () => ReadonlyArray<Window | null | undefined>;
	/** Where the embed is served; its origin is the only one believed or answered. */
	embedUrl: string;
	/** Opens Fabric Agent with a draft; absent where there is no agent to open. */
	openAgent?: (prompt: string) => void;
	/** Called when the viewer is about to be asked, before the question shows. */
	onQuestion?: () => void;
	/** A shell with no signed-in viewer (a public share) refuses every call. */
	enabled: boolean;
}

/** The question the viewer is asked, shown so a yes is an informed one. */
export type PendingCall =
	| {
			kind: "tool";
			toolName: string;
			args: Record<string, unknown>;
			/** Set when the viewer is asked on every call, and why. */
			because?: ConfirmEveryBecause;
			/** Trusted tool-list metadata from the host, never a page-supplied hint. */
			readOnly?: boolean;
	  }
	| { kind: "download"; download: PageDownload };

interface AskOptions {
	/**
	 * The question is not asked again for the same entry on this page version:
	 * the tool, or for a connected read the server and tool it reads.
	 */
	remember: { declaration: string } | null;
}

function rememberedAs(
	toolName: string,
	args: Record<string, unknown>,
): AskOptions["remember"] {
	const declaration = declarationOf(toolName, args);
	return declaration === undefined ? null : { declaration };
}

/**
 * Questions a page can have waiting at once, the one on screen included. A page
 * that asks faster than anyone can answer is refused rather than queued, since
 * each waiting question holds what the page sent, a download's file among it.
 */
const MAX_PENDING_QUESTIONS = 5;
const TOO_MANY_QUESTIONS =
	"This page has too many requests waiting for your answer. Answer them, then try again.";

export function useFrameRuntimeBridge(options: FrameRuntimeBridgeOptions) {
	const router = useRouter();
	const viewingOrganizationId = useOrganizationId();
	const [pendingCall, setPendingCall] = useState<PendingCall | null>(null);
	const resolveConfirmation = useRef<((allowed: boolean) => void) | null>(
		null,
	);
	const shownQuestion = useRef<PendingCall | null>(null);
	const { enabled, frameKey, frameId, embedUrl, contentVersion } = options;
	const taint = useMemo(() => createPageTaint(frameKey), [frameKey]);
	const frameOrganizationId = options.organizationId;
	const runtimeToolsKey = options.runtimeTools.join("\n");
	const scope = useMemo(
		() => ({
			enabled,
			frameKey,
			frameId,
			embedUrl,
			contentVersion,
			frameOrganizationId,
			viewingOrganizationId,
			runtimeToolsKey,
		}),
		[
			enabled,
			frameKey,
			frameId,
			embedUrl,
			contentVersion,
			frameOrganizationId,
			viewingOrganizationId,
			runtimeToolsKey,
		],
	);
	const latest = useRef({ options, router, scope });
	latest.current = { options, router, scope };

	const answerConfirmation = useCallback(
		(allowed: boolean) => {
			if (
				latest.current.scope !== scope ||
				shownQuestion.current !== pendingCall ||
				!resolveConfirmation.current
			) {
				return;
			}
			resolveConfirmation.current(allowed);
			resolveConfirmation.current = null;
			setPendingCall(null);
		},
		[scope, pendingCall],
	);

	useEffect(() => {
		const {
			enabled,
			frameKey,
			frameId,
			embedUrl,
			frameOrganizationId,
			viewingOrganizationId,
			runtimeToolsKey,
		} = scope;
		const embedOrigin = resolveEmbedOrigin(embedUrl);
		let active = true;
		let confirmationQueue = Promise.resolve(false);
		let pendingQuestions = 0;
		const calls = new Map<Window, Map<string, AbortController>>();
		const isCurrent = () => active && latest.current.scope === scope;
		// The digest may hydrate while a question is open; the synchronous
		// content identity above keeps it bound to the version that asked.
		const currentApprovalKey = () => {
			const fingerprint = latest.current.options.contentFingerprint;
			return isCurrent() && fingerprint
				? approvalKeyOf(
						`${viewingOrganizationId}:${frameKey}`,
						fingerprint,
					)
				: null;
		};

		// One question at a time, whatever it is about.
		const askViewer = (
			question: PendingCall,
			{ remember }: AskOptions,
			lifetime?: FrameRuntimeCallLifetime,
		): Promise<boolean> => {
			const isLive = () =>
				isCurrent() &&
				(!lifetime ||
					(!lifetime.signal.aborted &&
						Date.now() < lifetime.expiresAt));
			if (!isLive()) {
				return Promise.resolve(false);
			}
			if (pendingQuestions >= MAX_PENDING_QUESTIONS) {
				return Promise.reject(
					new FabricToolError(
						TOO_MANY_QUESTIONS,
						question.kind === "tool"
							? question.toolName
							: "download",
						{ reason: "busy", retryable: true },
					),
				);
			}
			pendingQuestions += 1;
			let settled = false;
			let complete!: (allowed: boolean) => void;
			const answer = new Promise<boolean>((resolve) => {
				complete = resolve;
			});
			const settle = (allowed: boolean) => {
				if (settled) {
					return;
				}
				settled = true;
				pendingQuestions -= 1;
				lifetime?.signal.removeEventListener("abort", cancelled);
				if (shownQuestion.current === question) {
					shownQuestion.current = null;
					resolveConfirmation.current = null;
					setPendingCall(null);
				}
				complete(allowed && isLive());
			};
			const cancelled = () => settle(false);
			lifetime?.signal.addEventListener("abort", cancelled, {
				once: true,
			});
			const ask = async () => {
				if (settled || !isLive()) {
					settle(false);
					return;
				}
				const known = currentApprovalKey();
				if (
					remember &&
					known &&
					isApproved(known, remember.declaration)
				) {
					settle(true);
					return;
				}
				shownQuestion.current = question;
				resolveConfirmation.current = settle;
				latest.current.options.onQuestion?.();
				setPendingCall(question);
				const allowed = await answer;
				const answeredFor = currentApprovalKey();
				if (allowed && isLive() && remember && answeredFor) {
					approve(answeredFor, remember.declaration);
				}
			};
			// A tool approved while it waited is not asked again.
			const turn = confirmationQueue.then(ask);
			confirmationQueue = turn.then(
				() => false,
				() => {
					settle(false);
					return false;
				},
			);
			return answer;
		};

		const host = createFrameRuntimeHost({
			runtimeTools: enabled
				? runtimeToolsKey.split("\n").filter(Boolean)
				: [],
			frameId,
			taint,
			organizationId: frameOrganizationId,
			viewingOrganizationId: () =>
				latest.current.scope.viewingOrganizationId,
			loadToolInfo: () => loadToolInfo(viewingOrganizationId),
			callTool: (name, args) => {
				if (!isCurrent()) {
					throw new FabricToolError(
						"This page changed. Try again from the current version.",
						name,
					);
				}
				return callFabricTool(name, args, {
					organizationId: viewingOrganizationId,
					pageFrameId: frameId ?? undefined,
				});
			},
			confirmTool: (
				toolName,
				args,
				{ every, because, readOnly },
				lifetime,
			) =>
				askViewer(
					{ kind: "tool", toolName, args, because, readOnly },
					{ remember: every ? null : rememberedAs(toolName, args) },
					lifetime,
				),
			// A file offered beyond the questions a page may have waiting is
			// declined: the page is not told, as with any answer to a download.
			confirmDownload: (download) =>
				enabled
					? askViewer(
							{ kind: "download", download },
							{ remember: null },
						).catch(() => false)
					: Promise.resolve(false),
			saveDownload: (download) => {
				if (isCurrent()) {
					saveBase64File(download);
				}
			},
			openAgent: (prompt) => {
				if (enabled && isCurrent()) {
					latest.current.options.openAgent?.(prompt);
				}
			},
			navigate: (path) => {
				if (enabled && isCurrent()) {
					latest.current.router.push(path);
				}
			},
		});

		const onMessage = (event: MessageEvent) => {
			if (!isCurrent() || event.origin !== embedOrigin || !event.source) {
				return;
			}
			const embed = latest.current.options
				.embedWindows()
				.find((candidate) => candidate && candidate === event.source);
			if (!embed || !isFrameRuntimeRequest(event.data)) {
				return;
			}
			const request = event.data;
			switch (request.type) {
				case "fabric-frame:call": {
					const embedCalls =
						calls.get(embed) ?? new Map<string, AbortController>();
					if (embedCalls.has(request.requestId)) {
						return;
					}
					const controller = new AbortController();
					embedCalls.set(request.requestId, controller);
					calls.set(embed, embedCalls);
					void host
						.handleCall(request, { signal: controller.signal })
						.then((result) => {
							if (isCurrent()) {
								embed.postMessage(result, embedOrigin);
							}
						})
						.finally(() => {
							if (
								embedCalls.get(request.requestId) === controller
							) {
								embedCalls.delete(request.requestId);
								if (embedCalls.size === 0) {
									calls.delete(embed);
								}
							}
						});
					return;
				}
				case "fabric-frame:cancel-call":
					calls.get(embed)?.get(request.requestId)?.abort();
					return;
				case "fabric-frame:open-agent":
					host.handleOpenAgent(request.prompt);
					return;
				case "fabric-frame:navigate":
					host.handleNavigate(request.path);
					return;
				case "fabric-frame:download":
					void host.handleDownload(request);
					return;
				default: {
					const unreachable: never = request;
					return unreachable;
				}
			}
		};

		window.addEventListener("message", onMessage);
		return () => {
			active = false;
			window.removeEventListener("message", onMessage);
			for (const embedCalls of calls.values()) {
				for (const controller of embedCalls.values()) {
					controller.abort();
				}
			}
			calls.clear();
			resolveConfirmation.current?.(false);
			resolveConfirmation.current = null;
			shownQuestion.current = null;
			setPendingCall(null);
		};
	}, [scope, taint]);

	return { pendingCall, answerConfirmation };
}
