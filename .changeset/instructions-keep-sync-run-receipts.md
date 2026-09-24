---
"fabric-app": patch
---

Coding Instructions keeps the repository-sync run history when a project switches back to upload mode or its repository is disconnected, and marks runs that came from a switched-off configuration.

Fizzy #2672. A run receipt's foreign key to the sync configuration cascaded on delete, so "Switch to upload mode" and a repository disconnect erased History, and a run in flight at that moment could never write its receipt or its completion audit row. The receipt now keeps the configuration id as a plain column, as the Living Memory sync already does; a run without its configuration still completes as "configuration changed", and the tab's status line shows only the current configuration's last run.
