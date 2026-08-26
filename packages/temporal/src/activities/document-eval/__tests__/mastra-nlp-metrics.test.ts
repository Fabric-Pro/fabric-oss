import { describe, expect, it } from "vitest";
import { runNLPMetrics } from "../mastra-nlp-metrics";

describe("Mastra NLP metrics", () => {
	it("matches semantic section groups", async () => {
		const result = await runNLPMetrics({
			documentContent: `# PRD

## Benefit Hypothesis
If we build the automated onboarding flow for new enterprise customers, then time-to-value decreases by 40% and trial-to-paid conversion improves significantly for the target segment.

## Overview
This document describes the new onboarding wizard feature. The problem is that enterprise customers take too long to activate. Why now: churn increased 15% last quarter among new signups. The goal is to reduce activation time from 14 days to 3 days. Non-goals include self-serve billing changes and SSO configuration which are handled separately.

## Users and Personas
Primary users are enterprise IT administrators who configure the platform for their organization. Secondary users are team leads who invite members. Internal users include customer success managers who monitor activation progress and intervene when onboarding stalls.

## Objectives and Success Metrics
Our goals are clear and measurable. Goal: reduce activation time. Metric: median days from signup to first workflow created drops below 3. Goal: improve conversion. Metric: trial-to-paid rate increases from 22% to 35%. We will measure weekly and report monthly to stakeholders.

## Scope
In scope: guided setup wizard, progress tracking dashboard, automated email nudges, integration marketplace quick-connect. Out of scope: billing changes, SSO/SAML configuration, custom branding during onboarding, and API-only activation flows.

## Requirements
Must have: step-by-step wizard with progress persistence, integration connection validation, sample data import, team invitation flow. Nice to have: AI-suggested configurations based on industry, video walkthrough embeds. Non-functional: wizard must load in under 2 seconds, support 1000 concurrent onboarding sessions, meet WCAG 2.1 AA accessibility standards.

## Key Flows
Happy path: admin signs up, enters company details, connects first integration, invites team, creates first workflow, sees success state. Edge cases: integration auth failure mid-flow, browser close and resume, team member declines invite. Failure and recovery: if integration connection fails, show retry with diagnostic info and offer manual config fallback.

## Dependencies and Risks
Dependencies: Identity service v2 API for team invitations, integration marketplace catalog API, email service for drip campaigns. Risk: integration marketplace API is still in beta and may have breaking changes. Mitigation: pin to current version and implement adapter layer. Risk: enterprise customers may have restrictive firewalls. Mitigation: provide connectivity check tool in wizard.

## Stakeholders
Product Manager: Jane Smith. Engineering Lead: Bob Johnson. Design: Alice Chen. Customer Success: David Park. QA: Maria Garcia. Executive Sponsor: CTO.
`,
			documentType: "prd",
		});

		expect(result.completeness.details.found).toContain("summary");
		expect(result.completeness.details.found).toContain("goals");
		expect(result.completeness.score).toBeGreaterThan(50);
	});

	it("handles short documents with structure penalties", async () => {
		const result = await runNLPMetrics({
			documentContent: "# Doc\n\nTiny content.",
			documentType: "general",
		});

		expect(result.structure.score).toBeLessThan(100);
		expect(result.structure.details.missing.length).toBeGreaterThan(0);
	});
});
