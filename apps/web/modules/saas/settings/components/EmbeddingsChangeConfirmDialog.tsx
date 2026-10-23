"use client";

import { orpcClient } from "@shared/lib/orpc-client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@ui/components/alert-dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";

export type EmbeddingsChangeImpact = {
	companyContext: { indexedWithCurrentModel: number; total: number };
	projectContent: { indexed: number };
};

export function hasIndexedEmbeddingContent(impact: EmbeddingsChangeImpact) {
	return (
		impact.companyContext.indexedWithCurrentModel > 0 ||
		impact.projectContent.indexed > 0
	);
}
export function matchesEmbeddingsConfirmation(value: string, word: string) {
	return value.trim().toLowerCase() === word.trim().toLowerCase();
}
function impactQueryOptions(organizationId: string) {
	return {
		queryKey: ["embeddingsChangeImpact", organizationId],
		queryFn: () =>
			orpcClient.aiConfig.embeddings.changeImpact({ organizationId }),
		staleTime: 0,
		retry: false as const,
	};
}
export function useEmbeddingsChangeImpact(
	organizationId: string | null | undefined,
	enabled: boolean,
) {
	return useQuery({
		...impactQueryOptions(organizationId ?? ""),
		enabled: enabled && !!organizationId,
	});
}

/** The count explanation and input, also embedded in the default-switch dialog. */
export function EmbeddingsChangeConfirmation({
	impact,
	isLoading = false,
	isError = false,
	value,
	onValueChange,
}: {
	impact?: EmbeddingsChangeImpact;
	isLoading?: boolean;
	isError?: boolean;
	value: string;
	onValueChange: (value: string) => void;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const id = useId();
	return (
		<div className="space-y-3 text-sm">
			<p>{t("embeddingsChangeBody")}</p>
			{isLoading ? (
				<output className="block">
					{t("embeddingsImpactLoading")}
				</output>
			) : isError || !impact ? (
				<p role="alert">{t("embeddingsImpactUnavailable")}</p>
			) : (
				<div className="space-y-1">
					<p>{t("embeddingsCompanyImpact", impact.companyContext)}</p>
					<p>{t("embeddingsProjectImpact", impact.projectContent)}</p>
				</div>
			)}
			<div className="space-y-2">
				<Label htmlFor={id}>{t("embeddingsConfirmationLabel")}</Label>
				<p id={`${id}-instruction`}>
					{t("embeddingsConfirmationInstruction", {
						word: t("embeddingsConfirmationWord"),
					})}
				</p>
				<Input
					id={id}
					aria-describedby={`${id}-instruction`}
					value={value}
					onChange={(event) => onValueChange(event.target.value)}
					autoComplete="off"
				/>
			</div>
		</div>
	);
}

export function EmbeddingsChangeConfirmDialog({
	open,
	onOpenChange,
	onConfirm,
	impact,
	isLoading = false,
	isError = false,
	testId,
	invokingElement,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	onConfirm: () => void;
	impact?: EmbeddingsChangeImpact;
	isLoading?: boolean;
	isError?: boolean;
	testId?: string;
	invokingElement?: HTMLElement | null;
}) {
	const t = useTranslations("settings.aiModelsRouting.models");
	const [value, setValue] = useState("");
	const returnFocus = useRef<HTMLElement | null>(null);
	return (
		<AlertDialog
			open={open}
			onOpenChange={(next) => {
				setValue("");
				onOpenChange(next);
			}}
		>
			<AlertDialogContent
				data-testid={testId}
				onOpenAutoFocus={() => {
					setValue("");
					returnFocus.current =
						invokingElement ??
						(document.activeElement instanceof HTMLElement
							? document.activeElement
							: null);
				}}
				onCloseAutoFocus={(event) => {
					const original = returnFocus.current;
					// Configure is hidden during confirmation and mounts a new Save button
					// on cancellation. Its stable id identifies the same invoking control.
					const target = original?.isConnected
						? original
						: original?.id
							? document.getElementById(original.id)
							: null;
					if (target) {
						event.preventDefault();
						target.focus();
					}
				}}
			>
				<AlertDialogHeader>
					<AlertDialogTitle>
						{t("embeddingsChangeTitle")}
					</AlertDialogTitle>
					<AlertDialogDescription>
						{t("embeddingsConfirmationDescription")}
					</AlertDialogDescription>
				</AlertDialogHeader>
				<EmbeddingsChangeConfirmation
					impact={impact}
					isLoading={isLoading}
					isError={isError}
					value={value}
					onValueChange={setValue}
				/>
				<AlertDialogFooter>
					<AlertDialogCancel>
						{t("embeddingsChangeCancel")}
					</AlertDialogCancel>
					<AlertDialogAction
						disabled={
							isLoading ||
							!matchesEmbeddingsConfirmation(
								value,
								t("embeddingsConfirmationWord"),
							)
						}
						onClick={(event) => {
							event.preventDefault();
							onConfirm();
						}}
					>
						{t("embeddingsChangeConfirm")}
					</AlertDialogAction>
				</AlertDialogFooter>
			</AlertDialogContent>
		</AlertDialog>
	);
}

/** Fetch before opening: a known-empty index needs no warning dialog. */
export function useEmbeddingsChangeConfirmation(
	organizationId: string | null | undefined,
) {
	const client = useQueryClient();
	const t = useTranslations("settings.aiModelsRouting.models");
	const [pending, setPending] = useState<{
		action: () => void;
		impact?: EmbeddingsChangeImpact;
	} | null>(null);
	const [isChecking, setIsChecking] = useState(false);
	const checking = useRef(false);
	const generation = useRef(0);
	const cancel = useCallback(() => {
		generation.current++;
		checking.current = false;
		setIsChecking(false);
		setPending(null);
	}, []);
	useEffect(() => {
		cancel();
		return () => {
			generation.current++;
		};
	}, [organizationId, cancel]);
	const invokingElement = useRef<HTMLElement | null>(null);
	const requestChange = async (
		action: () => void,
		invoker?: HTMLElement | null,
	) => {
		if (!organizationId) {
			toast.error(t("embeddingsOrganizationLoading"));
			return;
		}
		if (checking.current) {
			return;
		}
		invokingElement.current =
			invoker ??
			(document.activeElement instanceof HTMLElement
				? document.activeElement
				: null);
		checking.current = true;
		const requestGeneration = ++generation.current;
		setIsChecking(true);
		let impact: EmbeddingsChangeImpact | undefined;
		try {
			impact = await client.fetchQuery(
				impactQueryOptions(organizationId),
			);
		} catch {
			// An unavailable count requires confirmation rather than reporting zero.
		}
		if (generation.current !== requestGeneration) {
			return;
		}
		checking.current = false;
		setIsChecking(false);
		if (impact && !hasIndexedEmbeddingContent(impact)) {
			action();
			return;
		}
		setPending({ action, impact });
	};
	return {
		requestChange,
		cancel,
		isChecking,
		open: pending !== null,
		dialog: (
			<EmbeddingsChangeConfirmDialog
				open={pending !== null}
				invokingElement={invokingElement.current}
				impact={pending?.impact}
				isError={!!pending && !pending.impact}
				onOpenChange={(open) => {
					if (!open) {
						cancel();
					}
				}}
				onConfirm={() => {
					const action = pending?.action;
					setPending(null);
					action?.();
				}}
				testId="ai-models-embeddings-change"
			/>
		),
	};
}
