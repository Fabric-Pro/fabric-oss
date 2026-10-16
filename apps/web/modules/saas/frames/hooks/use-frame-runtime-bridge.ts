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
	const confirmationQueue = useRef<Promise<boolean>>(Promise.resolve(false));
	const pendingQuestions = useRef(0);
	const taint = useMemo(createPageTaint, []);

	const latest = useRef({ options, router, viewingOrganizationId });
	latest.current = { options, router, viewingOrganizationId };

	const answerConfirmation = useCallback((allowed: boolean) => {
		resolveConfirmation.current?.(allowed);
		resolveConfirmation.current = null;
		setPendingCall(null);
	}, []);

	const { enabled, frameKey, embedUrl, contentFingerprint } = options;
	const frameOrganizationId = options.organizationId;
	const runtimeToolsKey = options.runtimeTools.join("\n");

	// Another version of the page is another page: what the last one had read is
	// not carried over. A host made again for the same version keeps it.
	const version = contentFingerprint
		? approvalKeyOf(frameKey, contentFingerprint)
		: null;
	const lastVersion = useRef<string | null>(null);
	useEffect(() => {
		if (version === null) {
			return;
		}
		if (lastVersion.current !== null && lastVersion.current !== version) {
			taint.reset();
		}
		lastVersion.current = version;
	}, [version, taint]);

	useEffect(() => {
		const embedOrigin = resolveEmbedOrigin(embedUrl);
		// Read when asked and when answered, not when the host is made: the
		// fingerprint is worked out a moment after the page appears, and a
		// question already open must survive that.
		const currentApprovalKey = () => {
			const fingerprint = latest.current.options.contentFingerprint;
			return fingerprint ? approvalKeyOf(frameKey, fingerprint) : null;
		};

		// One question at a time, whatever it is about.
		const askViewer = (
			question: PendingCall,
			{ remember }: AskOptions,
		): Promise<boolean> => {
			if (pendingQuestions.current >= MAX_PENDING_QUESTIONS) {
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
			pendingQuestions.current += 1;
			const ask = async () => {
				const known = currentApprovalKey();
				if (
					remember &&
					known &&
					isApproved(known, remember.declaration)
				) {
					return true;
				}
				const allowed = await new Promise<boolean>((resolve) => {
					resolveConfirmation.current = resolve;
					latest.current.options.onQuestion?.();
					setPendingCall(question);
				});
				const answeredFor = currentApprovalKey();
				if (allowed && remember && answeredFor) {
					approve(answeredFor, remember.declaration);
				}
				return allowed;
			};
			// A tool approved while it waited is not asked again.
			const turn = confirmationQueue.current.then(ask);
			confirmationQueue.current = turn.finally(() => {
				pendingQuestions.current -= 1;
			});
			return turn;
		};

		const host = createFrameRuntimeHost({
			runtimeTools: enabled
				? runtimeToolsKey.split("\n").filter(Boolean)
				: [],
			frameId: latest.current.options.frameId ?? null,
			taint,
			organizationId: frameOrganizationId,
			viewingOrganizationId: () => latest.current.viewingOrganizationId,
			loadToolInfo: () =>
				loadToolInfo(latest.current.viewingOrganizationId),
			callTool: (name, args) =>
				callFabricTool(name, args, {
					organizationId: latest.current.viewingOrganizationId,
					pageFrameId: latest.current.options.frameId ?? undefined,
				}),
			confirmTool: (toolName, args, { every, because }) =>
				askViewer(
					{ kind: "tool", toolName, args, because },
					{ remember: every ? null : rememberedAs(toolName, args) },
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
			saveDownload: saveBase64File,
			openAgent: (prompt) => {
				if (enabled) {
					latest.current.options.openAgent?.(prompt);
				}
			},
			navigate: (path) => {
				if (enabled) {
					latest.current.router.push(path);
				}
			},
		});

		const onMessage = (event: MessageEvent) => {
			if (event.origin !== embedOrigin || !event.source) {
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
				case "fabric-frame:call":
					void host.handleCall(request).then((result) => {
						embed.postMessage(result, embedOrigin);
					});
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
			window.removeEventListener("message", onMessage);
			resolveConfirmation.current?.(false);
			resolveConfirmation.current = null;
			setPendingCall(null);
		};
	}, [
		enabled,
		frameKey,
		embedUrl,
		runtimeToolsKey,
		frameOrganizationId,
		taint,
		options.frameId,
	]);

	return { pendingCall, answerConfirmation };
}
