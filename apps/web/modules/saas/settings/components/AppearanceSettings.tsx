"use client";

import { config } from "@repo/config";
import { useContrastPreference } from "@saas/shared/components/ContrastPreferenceProvider";
import { SettingsItem } from "@saas/shared/components/SettingsItem";
import { SettingsList } from "@saas/shared/components/SettingsList";
import { Label } from "@ui/components/label";
import { RadioGroup, RadioGroupItem } from "@ui/components/radio-group";
import { Switch } from "@ui/components/switch";
import { useTranslations } from "next-intl";
import { useTheme } from "next-themes";
import { useEffect, useId, useState } from "react";

/**
 * Personal appearance settings (Fizzy #1444, AC-1): the colour mode and the
 * high-contrast theme, side by side because they combine — high contrast has a
 * light and a dark palette, and the colour mode picks between them.
 *
 * The two are saved differently, and the descriptions say so: the colour mode
 * is this browser's (next-themes, as it has always been), high contrast is the
 * account's and follows the person to every device.
 */
export function AppearanceSettings() {
	return (
		<SettingsList>
			<ColorModeSetting />
			<HighContrastSetting />
		</SettingsList>
	);
}

const COLOR_MODES = ["system", ...config.ui.enabledThemes] as const;

function ColorModeSetting() {
	const t = useTranslations("settings.account.appearance.colorMode");
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const baseId = useId();

	useEffect(() => {
		setMounted(true);
	}, []);

	return (
		<SettingsItem title={t("title")} description={t("description")}>
			<RadioGroup
				aria-label={t("title")}
				// next-themes knows the stored value only in the browser; until
				// then, show nothing selected rather than a guess that flips.
				value={mounted ? (theme ?? "system") : undefined}
				onValueChange={(value) => setTheme(value)}
				className="gap-3"
				data-testid="appearance-color-mode"
			>
				{COLOR_MODES.map((mode) => (
					<div key={mode} className="flex items-center gap-2">
						<RadioGroupItem value={mode} id={`${baseId}-${mode}`} />
						<Label
							htmlFor={`${baseId}-${mode}`}
							className="font-normal text-sm"
						>
							{t(mode)}
						</Label>
					</div>
				))}
			</RadioGroup>
		</SettingsItem>
	);
}

function HighContrastSetting() {
	const t = useTranslations("settings.account.appearance.highContrast");
	const contrast = useContrastPreference();
	const switchId = useId();
	const descriptionId = useId();

	if (!contrast) {
		return null;
	}

	return (
		<SettingsItem
			title={t("title")}
			description={<span id={descriptionId}>{t("description")}</span>}
		>
			<div className="flex items-center gap-3">
				<Switch
					id={switchId}
					checked={contrast.highContrast}
					onCheckedChange={contrast.setHighContrast}
					aria-describedby={descriptionId}
					data-testid="appearance-high-contrast"
				/>
				<Label htmlFor={switchId} className="font-normal text-sm">
					{t("label")}
				</Label>
			</div>
		</SettingsItem>
	);
}
