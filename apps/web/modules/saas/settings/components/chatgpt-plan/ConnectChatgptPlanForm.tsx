"use client";

import { Alert, AlertDescription } from "@ui/components/alert";
import { Button } from "@ui/components/button";
import { Checkbox } from "@ui/components/checkbox";
import { Label } from "@ui/components/label";
import { useTranslations } from "next-intl";
import { useState } from "react";
import {
	ChatgptPlanModelList,
	type ChatgptPlanModelListTask,
} from "../chatgpt-plan-models/ChatgptPlanModelList";
import { ChatgptConnectSteps } from "./ChatgptConnectSteps";
import { ChatgptFabricMarks } from "./ChatgptMark";

const CLI_CALLBACK_PATH = "/fabric/callback";

interface ConnectOrganization {
	id: string;
	name: string;
	enabled: boolean;
	/** The plan model per kind of work the organization chose (Fizzy #2770). */
	models?: ChatgptPlanModelListTask[];
}

/** The CLI's own listener; only the port comes from the link. */
function callbackUrl(port: number, query: Record<string, string>): string {
	return `http://127.0.0.1:${port}${CLI_CALLBACK_PATH}?${new URLSearchParams(query).toString()}`;
}

/** ChatGPT ↔ Fabric, then one short line: the screen reads like ChatGPT's own consent page. */
function ConnectHeader({
	title,
	description,
}: {
	title: string;
	description: string;
}) {
	return (
		<div className="space-y-3 text-center">
			<ChatgptFabricMarks />
			<h1 className="font-serif text-2xl">{title}</h1>
			<p className="text-muted-foreground text-sm">{description}</p>
		</div>
	);
}

function EncryptedNote() {
	const t = useTranslations("settings.chatgptPlan.connect");
	return (
		<p className="text-center text-muted-foreground text-xs">
			{t("encryptedNote")}
		</p>
	);
}

export function ConnectChatgptPlanForm({
	email,
	organizations,
	port,
	state,
}: {
	email: string;
	organizations: ConnectOrganization[];
	port: number | null;
	state: string | null;
}) {
	const t = useTranslations("settings.chatgptPlan.connect");
	const tModels = useTranslations("settings.chatgptPlanModels");
	const [chosen, setChosen] = useState<Set<string>>(
		() =>
			new Set(
				organizations.length === 1
					? organizations.map((org) => org.id)
					: organizations
							.filter((org) => org.enabled)
							.map((org) => org.id),
			),
	);
	const [status, setStatus] = useState<
		"idle" | "approving" | "done" | "cancelled" | "error"
	>("idle");

	if (port === null || state === null) {
		return (
			<Alert variant="error">
				<AlertDescription>{t("invalidLink")}</AlertDescription>
			</Alert>
		);
	}

	const toggle = (id: string, on: boolean) =>
		setChosen((current) => {
			const next = new Set(current);
			if (on) {
				next.add(id);
			} else {
				next.delete(id);
			}
			return next;
		});

	const approve = async () => {
		setStatus("approving");
		try {
			const response = await fetch("/api/connect/chatgpt/approve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({ organizationIds: [...chosen] }),
			});
			if (!response.ok) {
				throw new Error(String(response.status));
			}
			const { ticket } = (await response.json()) as { ticket: string };
			setStatus("done");
			window.location.assign(callbackUrl(port, { ticket, state }));
		} catch {
			setStatus("error");
		}
	};

	const cancel = () => {
		setStatus("cancelled");
		window.location.assign(
			callbackUrl(port, { error: "access_denied", state }),
		);
	};

	// Nothing to connect to: say why, and let the CLI stop waiting.
	if (organizations.length === 0) {
		return (
			<div className="space-y-4">
				<Alert>
					<AlertDescription>{t("noOrganizations")}</AlertDescription>
				</Alert>
				<Button
					autoLoading={false}
					onClick={() => {
						setStatus("cancelled");
						window.location.assign(
							callbackUrl(port, {
								error: "chatgpt_plan_not_enabled",
								state,
							}),
						);
					}}
					type="button"
					variant="ghost"
				>
					{t("close")}
				</Button>
			</div>
		);
	}

	if (status === "cancelled") {
		return (
			<p className="text-sm" role="status">
				{t("cancelled")}
			</p>
		);
	}

	if (status === "done") {
		return (
			<div className="space-y-5">
				<p className="text-sm" role="status">
					{t("returnToTerminal")}
				</p>
				<ChatgptConnectSteps current={3} />
			</div>
		);
	}

	return (
		<div className="space-y-5">
			<ConnectHeader
				description={t("description", { email })}
				title={t("title")}
			/>

			<ChatgptConnectSteps current={2} />

			<fieldset className="space-y-3">
				<legend className="mb-2 font-medium text-sm">
					{t("chooseOrganizations")}
				</legend>
				{organizations.map((org) => (
					<div className="space-y-2" key={org.id}>
						<div className="flex items-center gap-2">
							<Checkbox
								checked={chosen.has(org.id)}
								id={`chatgpt-plan-org-${org.id}`}
								onCheckedChange={(value) =>
									toggle(org.id, value === true)
								}
							/>
							<Label htmlFor={`chatgpt-plan-org-${org.id}`}>
								{org.name}
							</Label>
						</div>
						{org.models && org.models.length > 0 ? (
							<div className="space-y-1 pl-6">
								<p className="text-muted-foreground text-xs">
									{tModels("connectNote", {
										organization: org.name,
									})}
								</p>
								<ChatgptPlanModelList tasks={org.models} />
							</div>
						) : null}
					</div>
				))}
			</fieldset>

			{status === "error" ? (
				<Alert variant="error">
					<AlertDescription>{t("failed")}</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-2">
				<Button
					autoLoading={false}
					disabled={status === "approving" || chosen.size === 0}
					onClick={() => void approve()}
					type="button"
				>
					{status === "approving" ? t("approving") : t("approve")}
				</Button>
				<Button
					autoLoading={false}
					disabled={status === "approving"}
					onClick={cancel}
					type="button"
					variant="ghost"
				>
					{t("cancel")}
				</Button>
			</div>
			<EncryptedNote />
		</div>
	);
}

/**
 * `fabric connect chatgpt --org <slug> --shared` (Fizzy #2770): an admin
 * connects a ChatGPT account the organization shares. `organization` is null
 * when the person does not administer it or ChatGPT plans are off there.
 */
export function ConnectSharedChatgptPlanForm({
	organization,
	port,
	state,
}: {
	organization: {
		slug: string;
		name: string;
		models?: ChatgptPlanModelListTask[];
	} | null;
	port: number | null;
	state: string | null;
}) {
	const t = useTranslations("settings.chatgptPlan.connectShared");
	const tConnect = useTranslations("settings.chatgptPlan.connect");
	const tModels = useTranslations("settings.chatgptPlanModels");
	const [status, setStatus] = useState<
		"idle" | "approving" | "done" | "cancelled" | "error"
	>("idle");

	if (port === null || state === null) {
		return (
			<Alert variant="error">
				<AlertDescription>{t("invalidLink")}</AlertDescription>
			</Alert>
		);
	}

	const leave = (error: string) => {
		setStatus("cancelled");
		window.location.assign(callbackUrl(port, { error, state }));
	};

	if (organization === null) {
		return (
			<div className="space-y-4">
				<Alert>
					<AlertDescription>{t("notAllowed")}</AlertDescription>
				</Alert>
				<Button
					autoLoading={false}
					onClick={() => leave("chatgpt_plan_shared_not_allowed")}
					type="button"
					variant="ghost"
				>
					{tConnect("close")}
				</Button>
			</div>
		);
	}

	const approve = async () => {
		setStatus("approving");
		try {
			const response = await fetch("/api/connect/chatgpt/approve", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				credentials: "include",
				body: JSON.stringify({
					shared: { organizationSlug: organization.slug },
				}),
			});
			if (!response.ok) {
				throw new Error(String(response.status));
			}
			const { ticket } = (await response.json()) as { ticket: string };
			setStatus("done");
			window.location.assign(callbackUrl(port, { ticket, state }));
		} catch {
			setStatus("error");
		}
	};

	if (status === "cancelled") {
		return (
			<p className="text-sm" role="status">
				{tConnect("cancelled")}
			</p>
		);
	}

	if (status === "done") {
		return (
			<div className="space-y-5">
				<p className="text-sm" role="status">
					{t("returnToTerminal", {
						organization: organization.name,
					})}
				</p>
				<ChatgptConnectSteps current={3} shared />
			</div>
		);
	}

	return (
		<div className="space-y-5">
			<ConnectHeader
				description={t("description", {
					organization: organization.name,
				})}
				title={t("title")}
			/>

			<ChatgptConnectSteps current={2} shared />

			{organization.models && organization.models.length > 0 ? (
				<div className="space-y-1">
					<p className="text-muted-foreground text-sm">
						{tModels("connectNote", {
							organization: organization.name,
						})}
					</p>
					<ChatgptPlanModelList tasks={organization.models} />
				</div>
			) : null}

			{status === "error" ? (
				<Alert variant="error">
					<AlertDescription>{tConnect("failed")}</AlertDescription>
				</Alert>
			) : null}

			<div className="grid gap-2">
				<Button
					autoLoading={false}
					disabled={status === "approving"}
					onClick={() => void approve()}
					type="button"
				>
					{status === "approving"
						? tConnect("approving")
						: tConnect("approve")}
				</Button>
				<Button
					autoLoading={false}
					disabled={status === "approving"}
					onClick={() => leave("access_denied")}
					type="button"
					variant="ghost"
				>
					{tConnect("cancel")}
				</Button>
			</div>
			<EncryptedNote />
		</div>
	);
}
