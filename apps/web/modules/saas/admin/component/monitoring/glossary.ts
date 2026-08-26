/**
 * Centralised plain-language glossary of monitoring terms surfaced on the
 * admin monitoring dashboard. Every tooltip on the page pulls its text from
 * here so the prose is consistent and easy to audit / update.
 *
 * Keep the entries:
 *  - Plain English (the audience is admins, not the on-call team that wrote
 *    the rules).
 *  - Specific (cite the actual numbers / windows from `ThresholdConfigDisplay`
 *    so the text never goes stale when the dashboard does).
 *  - Short — one or two sentences. If you need more, link out.
 */

export const GLOSSARY = {
	// ----- Page level --------------------------------------------------
	monitoringOverview:
		"Real-time view of every monitored signal and incident in the Fabric platform. Acknowledge or resolve incidents from here; thresholds are read-only and changed in code.",

	// ----- Active incidents columns -----------------------------------
	severity:
		"SEV-1: customer-impacting outage, pages on-call. SEV-2: degraded but functional, business-hours response. SEV-3: chronic issue, ticket-only.",
	kind: "How the incident was detected. ERROR RATE = our app's own 5xx burn rate. INTEGRATION = a third-party provider failure (statuspage, synthetic probe, or circuit breaker).",
	serviceProvider:
		"Which service or third-party provider the incident relates to.",
	featureSource:
		"Which feature is impacted (for error-rate incidents) or which detection signal fired (for integration incidents).",
	started:
		"When the incident first fired. Auto-resolve happens after the underlying signal clears for the recovery hysteresis window.",
	status: "FIRING = active and unacknowledged. ACKNOWLEDGED = an admin has seen it and is working on it. RESOLVED = clear, moved to the timeline below.",

	// ----- Status / health words --------------------------------------
	healthOperational: "Provider reports all systems normal.",
	healthDegraded:
		"Provider reports slower than normal but still functional. Expect higher latency; retries help. Non-critical paths can continue.",
	healthPartialOutage:
		"Provider reports some functionality is unavailable. Check which feature is affected and consider failover.",
	healthMajorOutage:
		"Provider reports completely down. Hard outage — page on-call and fail over if possible.",
	healthMaintenance:
		"Provider announced scheduled maintenance. Expected downtime.",
	healthUnknown:
		"We couldn't determine status. Either the provider has no public health feed, our poller hasn't reached it yet, or the feed format isn't supported (e.g., non-Atlassian Statuspage).",
	healthNotConfigured:
		"Synthetic probe disabled because a required environment variable (e.g., STRIPE_SECRET_KEY, AWS_S3_BUCKET) is missing in this environment. The provider itself is not necessarily down — we just can't probe it from here. Check the provider's status page directly to confirm.",

	lastPoll:
		"When our service last successfully polled this provider's health endpoint. Statuspage feeds are polled every 2 minutes.",
	affectedFeatures:
		"The product features that depend on this provider. If the provider goes down, these are the areas of the app to watch.",

	// ----- Timeline filters --------------------------------------------
	timelineAll:
		"Every detection signal across all incident streams (error-rate, integration, and component).",
	timelineErrorRate:
		"Application's own 5xx burn-rate alerts (from KQL scheduledQueryRules over the App Insights `requests` table).",
	timelineStatuspage:
		"Provider declared an incident on their public Atlassian Statuspage feed. We poll the feed every 2 minutes.",
	timelineSynthetic:
		"Our scheduled probe (every 5 min) found the provider unreachable from outside our datacenter. Distinct from real-traffic failures.",
	timelineBreaker:
		"The Cockatiel circuit breaker opened on consecutive failures and blocked new calls until it half-opens for retry.",
	timelineAlertmanager:
		"Custom application-level alert fired via App Insights / Alertmanager — typically a deep app-level invariant, not a provider signal.",
	timelineComponent:
		"An internal Fabric subsystem outage — Temporal worker stalled, Prisma migration drift, RAG indexer queue backed up, agent rail down. Not a customer integration; these are our own moving parts.",

	// ----- Burn-rate thresholds table ---------------------------------
	burnRateSeverity:
		"Maps to Action Group severity routing. SEV-1 pages on-call. SEV-2 ticket / Teams. SEV-3 weekly digest.",
	burnRateLongWindow:
		"The longer of the two evaluation windows. Both the long and short windows must breach the burn rate simultaneously for the alert to fire — a multi-window pattern from the Google SRE Workbook that eliminates single-spike false positives.",
	burnRateShortWindow:
		"The shorter, faster-reacting window. Paired with the long window above to confirm the breach is sustained, not a one-off blip.",
	burnRateMultiplier:
		"Multiplier above the 0.1% error budget for a 99.9% SLO. 14.4× means burning the monthly budget 14.4 times faster than allowed — at that pace the monthly budget exhausts in ~2 hours.",
	burnRateMinCount:
		"Absolute floor on the long-window error count. Without this, a single error in a low-traffic feature would page on-call.",

	// ----- Integration signals table ----------------------------------
	integrationSignal:
		"Internal name for the detection rule. Each signal maps to one row in the provider-health pipeline.",
	integrationCondition:
		"The exact condition that must be true to start an incident for this signal.",
	integrationHysteresis:
		"Condition that auto-closes the incident. Prevents flapping — the signal must stay healed for the listed duration before the incident is marked RESOLVED.",

	// ----- Hysteresis policy summary ----------------------------------
	hysteresisErrorRate:
		"How long the error rate must stay under half of the trigger threshold before the incident auto-resolves. The cool-down keeps a noisy recovery from re-paging the on-call.",
	hysteresisStatuspage:
		"What we need to see on the provider's statuspage feed before we close an integration incident — either the provider's own incident.resolved webhook, or two consecutive polls showing operational status.",
	hysteresisSyntheticProbe:
		"How many consecutive successful probes we need before clearing a synthetic-probe incident. Three in a row (~15 min of green) is enough to be confident the issue cleared.",
} as const;
