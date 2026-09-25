---
"fabric-app": patch
---

Two Azure Monitor alert rules in the Azure deployment templates now satisfy Azure's scheduled-query rules: the circuit-breaker alert evaluates every five minutes instead of every minute, and the collector-heartbeat alert fires on a single violating period.

The circuit-breaker query combines two tables with `union`, which Azure's one-minute evaluation does not support. The heartbeat query required two of two violating periods, which Azure only allows when the query returns a datetime column; the query already covers 15 minutes of absence on its own.
