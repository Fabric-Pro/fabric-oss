import {
	Container,
	Font,
	Head,
	Hr,
	Html,
	Section,
	Tailwind,
	Text,
} from "@react-email/components";
import React, { type PropsWithChildren } from "react";
import { Logo } from "./Logo";

export default function Wrapper({ children }: PropsWithChildren) {
	return (
		<Html lang="en">
			<Head>
				<Font
					fontFamily="Inter"
					fallbackFontFamily="Arial"
					fontWeight={400}
					fontStyle="normal"
				/>
				<Font
					fontFamily="EB Garamond"
					fallbackFontFamily="Georgia"
					webFont={{
						url: "https://fonts.gstatic.com/s/ebgaramond/v27/SlGDmQSNjdsmc35JDF1K5E55YMjF_7DPuGi-6_RUA4V-e6yHgQ.woff2",
						format: "woff2",
					}}
					fontWeight={400}
					fontStyle="normal"
				/>
			</Head>
			<Tailwind
				config={{
					theme: {
						extend: {
							colors: {
								border: "#ece8e1",
								background: "#f5f4f1",
								foreground: "#1c1917",
								muted: "#78716c",
								accent: "#B91C1C",
								primary: {
									DEFAULT: "#9F2A3A",
									foreground: "#ffffff",
								},
								card: {
									DEFAULT: "#fbfaf8",
									foreground: "#1c1917",
								},
								surface: "#f0eee9",
								// Release-version chip: a deliberately darker
								// neutral than `surface`/`card` so the pill reads
								// as a filled badge (surface ≈ card was visually
								// invisible). Foreground is a mid stone, not the
								// red `primary`, matching the design mockup.
								chip: {
									DEFAULT: "#e7e5e4",
									foreground: "#57534e",
								},
							},
						},
					},
				}}
			>
				<Section className="bg-background py-8 px-4">
					<Container className="max-w-[520px] rounded-lg border border-border bg-card px-8 py-10 text-card-foreground">
						<Logo />
						{children}
						<Hr className="mt-8 mb-4 border-border" />
						<Text className="text-xs text-muted leading-tight m-0">
							Fabric AI — Intelligent software delivery,
							automated.
						</Text>
					</Container>
				</Section>
			</Tailwind>
		</Html>
	);
}
