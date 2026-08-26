"use client";

import { orpc } from "@shared/lib/orpc-query-utils";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useCallback } from "react";
import { toast } from "sonner";
import {
	buildEmbeddedKanbanUrl,
	buildKanbanRuntimeStatusUrl,
	buildProtocolKanbanUrl,
	getKanbanLaunchModeFromStatus,
} from "../lib/kanban-launch";

type KanbanMode = "embed" | "external" | "not-running";

interface KanbanLaunchTarget {
	mode: KanbanMode;
	url: string;
}

interface UseKanbanStatusReturn {
	isCreatingToken: boolean;
	prepareKanbanLaunch: (
		projectId: string,
		storyId?: string,
	) => Promise<KanbanLaunchTarget | null>;
}

async function getKanbanRuntimeLaunchMode(
	parentOrigin: string,
): Promise<"embed" | "external" | "not-running"> {
	const controller = new AbortController();
	const timeout = window.setTimeout(() => controller.abort(), 1500);
	try {
		const response = await fetch(buildKanbanRuntimeStatusUrl(), {
			headers: {
				Accept: "application/json",
			},
			signal: controller.signal,
		});
		window.clearTimeout(timeout);
		if (!response.ok) {
			return "external";
		}
		const status = (await response.json()) as {
			mode?: "embed" | "standalone";
			parentOrigin?: string | null;
		};
		return getKanbanLaunchModeFromStatus(
			status.mode
				? {
						mode: status.mode,
						parentOrigin: status.parentOrigin ?? null,
					}
				: null,
			parentOrigin,
		);
	} catch {
		// Could be CORS (server up but headers missing) or connection refused.
		// Try a no-cors probe to distinguish: an opaque response means server is up.
		window.clearTimeout(timeout);
		try {
			const probeController = new AbortController();
			const probeTimeout = window.setTimeout(
				() => probeController.abort(),
				1000,
			);
			const probe = await fetch(buildKanbanRuntimeStatusUrl(), {
				method: "HEAD",
				mode: "no-cors",
				signal: probeController.signal,
			});
			window.clearTimeout(probeTimeout);
			// Opaque response (type === "opaque") means server responded — CORS just blocked the body.
			// Assume embed mode since that's what --embed starts.
			if (probe.type === "opaque") {
				return "embed";
			}
		} catch {
			// Both failed → not running
		}
		return "not-running";
	}
}

export type KanbanRuntimeDetection = "checking" | "detected" | "not-detected";

/**
 * Non-blocking probe for a locally running fabric-kanban runtime.
 *
 * Renders inline hints near "Local development" delegation actions — it
 * must never disable them (the user may start the runtime after queueing
 * work). Pass `enabled: false` while no delegation UI is visible to skip
 * the probe entirely.
 */
export function useKanbanRuntimeDetected(
	enabled: boolean,
): KanbanRuntimeDetection {
	const { data } = useQuery({
		queryKey: ["kanban-runtime-detected"],
		queryFn: async (): Promise<"detected" | "not-detected"> => {
			const mode = await getKanbanRuntimeLaunchMode(
				window.location.origin,
			);
			return mode === "not-running" ? "not-detected" : "detected";
		},
		enabled,
		staleTime: 30_000,
		retry: false,
	});
	return data ?? "checking";
}

export function useKanbanStatus(): UseKanbanStatusReturn {
	const { mutateAsync: createToken, isPending: isCreatingToken } =
		useMutation({
			...orpc.kanban.token.mutationOptions(),
			onError: (error) => {
				toast.error("Failed to create kanban token", {
					description: error.message,
				});
			},
		});

	const prepareKanbanLaunch = useCallback(
		async (projectId: string, storyId?: string) => {
			try {
				const parentOrigin = window.location.origin;

				// Check status first — skip token creation if kanban isn't running
				const launchMode =
					await getKanbanRuntimeLaunchMode(parentOrigin);
				if (launchMode === "not-running") {
					return { mode: "not-running" as const, url: "" };
				}

				const { token, projectName, repositoryUrl } = await createToken(
					{
						projectId,
						storyId,
					},
				);

				const repoConfigured = Boolean(repositoryUrl);

				if (launchMode === "embed") {
					return {
						mode: "embed" as const,
						url: buildEmbeddedKanbanUrl({
							projectId,
							storyId,
							parentOrigin,
							token,
							projectName,
							repositoryUrl,
							repoConfigured,
						}),
					};
				}

				return {
					mode: "external" as const,
					url: buildProtocolKanbanUrl({
						projectId,
						storyId,
						parentOrigin,
						token,
					}),
				};
			} catch {
				return null;
			}
		},
		[createToken],
	);

	return {
		prepareKanbanLaunch,
		isCreatingToken,
	};
}
