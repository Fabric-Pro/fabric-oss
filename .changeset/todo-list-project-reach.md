---
"fabric-app": patch
---

The To Do list now shows work from the projects you actually belong to, and the "Open in the meeting" link on a to-do reaches that meeting instead of a "Project not found" page.

The list had been deciding which projects it could reach with a rule of its own, and that rule counted membership of the organization as access to every project inside it. The rest of the product does not: a project opens for the person who created it and for people who have accepted an invitation to it, which is also what the projects list shows you. So the To Do page had been listing other people's commitments, their meeting names and the people named in them from projects nobody had added you to, and every link on those rows led somewhere that refused to load. The page now asks the same question the project page answers, so what it lists and what it links to agree.

Work that is yours stays yours. A commitment assigned to you, or one you wrote by hand, still appears even when it came out of a meeting on a project you cannot open — the meeting digest can assign an action item to anyone in the organization, and a list that hid those would be hiding the very thing it exists to surface. Such a row keeps its wording, its meeting name and its date, and simply offers no link into a project that would turn you away. The same now holds for the meeting heading above it, the pending-proposals indicator and the linked feature and bug shortcuts.
