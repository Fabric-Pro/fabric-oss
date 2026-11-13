"use client";

import { useActiveOrganization } from "@saas/organizations/hooks/use-active-organization";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { orpcClient } from "@shared/lib/orpc-client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@ui/components/button";
import { Label } from "@ui/components/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@ui/components/select";
import { AlertCircle } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { toast } from "sonner";

/** Radix Select cannot hold an empty value, so "no template" has its own. */
const NONE = "none";

const queryKeyFor = (organizationId: string) =>
	["organizationInstructionTemplate", organizationId] as const;

/**
 * A refused save in the form's own words, by the error's code: the server's
 * `message` is not translated.
 */
function saveErrorKey(
	error: unknown,
): "notUploadMode" | "notFound" | "forbidden" | "saveFailed" {
	const code =
		error && typeof error === "object" && "code" in error
			? error.code
			: undefined;
	switch (code) {
		case "PRECONDITION_FAILED":
			return "notUploadMode";
		case "NOT_FOUND":
			return "notFound";
		case "FORBIDDEN":
			return "forbidden";
		default:
			return "saveFailed";
	}
}

/**
 * The project whose published coding instructions the organization's other
 * projects can start from.
 *
 * Admins and owners only: the server refuses everyone else for both the read
 * and the write, so the form is not shown to them at all. The picker offers
 * exactly the projects the server accepts (`candidates`: uploaded
 * instructions, no move into a repository open), saying which have nothing
 * published to copy yet. A template that has since stopped qualifying is
 * still shown by the name the setting returns, so saving never clears it by
 * accident.
 */
export function InstructionTemplateForm() {
	const t = useTranslations("organizations.settings.instructionTemplate");
	const queryClient = useQueryClient();
	const { activeOrganization, isOrganizationAdmin } = useActiveOrganization();
	const organizationId = activeOrganization?.id;
	const enabled = Boolean(organizationId) && isOrganizationAdmin;

	const setting = useQuery({
		queryKey: queryKeyFor(organizationId ?? ""),
		queryFn: async () =>
			orpcClient.organizations.instructionTemplate.get({
				organizationId: organizationId as string,
			}),
		enabled,
		retry: 1,
	});
	const [selected, setSelected] = useState<string>(NONE);
	useEffect(() => {
		setSelected(setting.data?.projectId ?? NONE);
	}, [setting.data?.projectId]);

	const updateMutation = useMutation({
		mutationFn: async (projectId: string | null) =>
			orpcClient.organizations.instructionTemplate.update({
				organizationId: organizationId as string,
				projectId,
			}),
		onSuccess: (result) => {
			toast.success(
				result.projectId === null ? t("cleared") : t("saved"),
			);
			if (organizationId) {
				queryClient.invalidateQueries({
					queryKey: queryKeyFor(organizationId),
				});
			}
		},
		onError: (err) => {
			toast.error(t(saveErrorKey(err)));
		},
	});

	if (!enabled) {
		return null;
	}

	if (setting.isLoading) {
		return (
			<SettingsItem title={t("title")} description={t("description")}>
				<div className="text-muted-foreground text-sm">
					{t("loading")}
				</div>
			</SettingsItem>
		);
	}

	if (setting.error) {
		return (
			<SettingsItem title={t("title")} description={t("description")}>
				<div className="flex items-center gap-2 text-destructive text-sm">
					<AlertCircle className="size-4" aria-hidden="true" />
					<span>{t("loadFailed")}</span>
				</div>
			</SettingsItem>
		);
	}

	const current = setting.data?.projectId ?? null;
	const candidates = setting.data?.candidates ?? [];
	const options = [
		...candidates.map((project) => ({
			id: project.id,
			label: project.published
				? project.name
				: t("nothingPublished", { name: project.name }),
		})),
		...(current !== null &&
		!candidates.some((project) => project.id === current)
			? [{ id: current, label: setting.data?.projectName ?? current }]
			: []),
	];
	const next = selected === NONE ? null : selected;

	return (
		<SettingsItem title={t("title")} description={t("description")}>
			<div className="space-y-2">
				<Label htmlFor="organization-instruction-template">
					{t("label")}
				</Label>
				<div className="flex flex-col gap-2 sm:flex-row">
					<Select
						value={selected}
						onValueChange={setSelected}
						disabled={updateMutation.isPending}
					>
						<SelectTrigger id="organization-instruction-template">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							<SelectItem value={NONE}>{t("none")}</SelectItem>
							{options.map((option) => (
								<SelectItem key={option.id} value={option.id}>
									{option.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
					<Button
						variant="outline"
						disabled={updateMutation.isPending || next === current}
						onClick={() => updateMutation.mutate(next)}
					>
						{t("save")}
					</Button>
				</div>
				{options.length === 0 ? (
					<p className="text-muted-foreground text-xs">
						{t("noCandidates")}
					</p>
				) : null}
				<p className="text-muted-foreground text-xs">{t("help")}</p>
			</div>
		</SettingsItem>
	);
}
