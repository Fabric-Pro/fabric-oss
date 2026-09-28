---
"fabric-app": patch
---

Load only the web logging modules during startup when OpenTelemetry is disabled, preserving provider registrations and App Insights log forwarding.
