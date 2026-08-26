"use client";

import { Button } from "@ui/components/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@ui/components/dialog";
import { Input } from "@ui/components/input";
import { Label } from "@ui/components/label";
import { Switch } from "@ui/components/switch";
import { Textarea } from "@ui/components/textarea";
import { Loader2Icon } from "lucide-react";
import { useTranslations } from "next-intl";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

export type PlanFormValues = {
	name: string;
	description: string | null;
	/** Only present when `showState` is set (edit flow). */
	state?: "ACTIVE" | "INACTIVE";
};

/**
 * Shared create/edit dialog for a Test Plan's name, description and (edit-only)
 * Active/Inactive state. The caller owns the mutation + success/error handling
 * and passes `onSubmit`; this component owns the form state, a one-per-open seed
 * (so a refetch while the dialog is open can't stomp in-progress edits), and the
 * "name required" guard. Used by both the create (TestPlansList) and edit
 * (TestPlanDetail) flows so the form is defined once.
 */
export function PlanFormDialog({
	open,
	onOpenChange,
	title,
	dialogDescription,
	submitLabel,
	initialName = "",
	initialDescription = "",
	initialState,
	showState = false,
	pending,
	onSubmit,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	title: string;
	dialogDescription: string;
	submitLabel: string;
	initialName?: string;
	initialDescription?: string;
	initialState?: "ACTIVE" | "INACTIVE";
	showState?: boolean;
	pending: boolean;
	onSubmit: (values: PlanFormValues) => void;
}) {
	const t = useTranslations("projects.testCases");
	const [name, setName] = useState(initialName);
	const [description, setDescription] = useState(initialDescription);
	const [active, setActive] = useState(initialState !== "INACTIVE");

	// Seed once per open (on the closed→open transition) so a concurrent refetch
	// of the plan while the dialog is open can't re-run this and stomp edits.
	const seededRef = useRef(false);
	useEffect(() => {
		if (!open) {
			seededRef.current = false;
			return;
		}
		if (!seededRef.current) {
			seededRef.current = true;
			setName(initialName);
			setDescription(initialDescription);
			setActive(initialState !== "INACTIVE");
		}
	}, [open, initialName, initialDescription, initialState]);

	const submit = () => {
		if (!name.trim()) {
			toast.error(t("toasts.planNameRequired"));
			return;
		}
		onSubmit({
			name: name.trim(),
			description: description.trim() || null,
			...(showState ? { state: active ? "ACTIVE" : "INACTIVE" } : {}),
		});
	};

	return (
		<Dialog open={open} onOpenChange={onOpenChange}>
			<DialogContent className="max-w-md">
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{dialogDescription}</DialogDescription>
				</DialogHeader>
				<div className="space-y-4">
					<div className="space-y-1.5">
						<Label htmlFor="plan-form-name">
							{t("plans.nameLabel")}{" "}
							<span className="text-destructive">*</span>
						</Label>
						<Input
							id="plan-form-name"
							value={name}
							onChange={(e) => setName(e.target.value)}
							placeholder={t("plans.namePlaceholder")}
						/>
					</div>
					<div className="space-y-1.5">
						<Label htmlFor="plan-form-desc">
							{t("plans.descriptionLabel")}
						</Label>
						<Textarea
							id="plan-form-desc"
							value={description}
							onChange={(e) => setDescription(e.target.value)}
							rows={3}
							placeholder={t("plans.descriptionPlaceholder")}
						/>
					</div>
					{showState && (
						<div className="flex items-start justify-between gap-3 rounded-lg border p-3">
							<div>
								<Label
									htmlFor="plan-form-state"
									className="text-sm"
								>
									{t("plans.stateLabel")}
								</Label>
								<p className="mt-0.5 text-muted-foreground text-xs">
									{t("plans.stateHint")}
								</p>
							</div>
							<Switch
								id="plan-form-state"
								checked={active}
								onCheckedChange={setActive}
								aria-label={t("plans.stateLabel")}
							/>
						</div>
					)}
				</div>
				<DialogFooter>
					<Button
						variant="outline"
						onClick={() => onOpenChange(false)}
						disabled={pending}
					>
						{t("actions.cancel")}
					</Button>
					<Button onClick={submit} disabled={pending}>
						{pending && (
							<Loader2Icon className="mr-2 size-4 animate-spin" />
						)}
						{submitLabel}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
