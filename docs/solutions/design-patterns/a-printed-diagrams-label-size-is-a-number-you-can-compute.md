---
title: "A printed diagram's label size is a number you can compute before you look"
date: 2026-10-27
category: design-patterns
module: proposal export diagrams
problem_type: design_pattern
component: background_job
severity: medium
applies_when:
  - "Changing how the PDF or DOCX export draws, sizes or lays out mermaid diagrams"
  - "Changing how generated diagrams are written (label length, direction, node count) for documents that are printed"
  - "Deciding whether a diagram is readable on paper, or reviewing an export by its data instead of its output"
  - "Changing the page size or the margins of the print layout"
  - "Changing how the live document page draws mermaid flowcharts (font, label breaks, direction)"
tags: [proposal-export, pdf, mermaid, beautiful-mermaid, diagrams, print, legibility, svg, fizzy-2946]
audience: engineers working on the Proposal export or on the diagrams generation writes
owner: Fabric platform
---

# A printed diagram's label size is a number you can compute before you look

## Context

A Proposal's PDF prints each mermaid diagram as an SVG shrunk to the text column. A diagram wider than the column is scaled down, and its labels with it. Every check on the data passed: the fence parsed, the SVG rendered, it fit the page. The PDF was still unreadable. A staging export printed a left-to-right chain of generated steps at about 3 pt (Fizzy #2946). After the export started turning such charts top-down (#1390), diagrams stored with one-line labels of 130 characters or more still printed at about 6 pt, which #1399 fixed by breaking long labels.

Both defects could only be seen in the rendered PDF. They could also be predicted from the diagram's size.

## The formula

```text
printed label pt = renderer label px
                   × min(1, print column px / SVG width px, figure height px / SVG height px)
                   × 0.75
```

- **Renderer label px.** beautiful-mermaid draws node labels at 13 px (its `FONT_SIZES.nodeLabel`). Edge labels are 11 px and subgraph headers 12 px.
- **Print column px.** US Letter (8.5 in) less two 0.8 in side margins is 6.9 in. At 96 CSS px per inch, that is **662.4 px**: (12240 − 2 × 1152) / 15 twips.
- **Figure height px.** The DOCX writer shrinks a picture taller than the portrait text height less an inch for its caption (`MAX_IMAGE_HEIGHT`): 11 in less the 0.85 in top and 0.9 in bottom margins, less 1 in, is 8.25 in, **792 px**. The PDF's print layer shrinks a figure's drawing to the same height with a `max-height` rule, so a tall figure fits one page with its caption. The first figure on a section opener's page, which it shares with the opener, is offered two inches less: **600 px** right under a two-line heading and a one-line subtitle, less under a longer opener or after paragraphs. It takes that height only while its labels stay at the floor there (below); otherwise it keeps 792 px and moves whole to the next page. The DOCX has no shorter limit.
- **0.75** converts CSS px to pt (72 / 96).
- **The floor** is 9 pt. A diagram that fits both limits prints its labels at 13 × 0.75 = **9.75 pt**. Any diagram wider than 662.4 × 9.75 / 9 ≈ 718 px, or taller than 792 × 9.75 / 9 = 858 px, prints below the floor. Right after a section opener in the PDF, a diagram taller than 600 × 9.75 / 9 = 650 px would, so it is not shrunk to 600 px: `legibleFigureMaxHeightPx` keeps it at 792 px and it moves whole to the next page. A figure template's 12 px text is at the floor at full size, so a template is never shrunk under an opener. A flowchart that is one plain chain of seven steps or more draws as the process template, whose grid of four steps a row stays far shorter than the engine's column of about 85 px a step.
- **SVG width and height** are the size the engine lays the diagram out at. The export and the live page both pass it an 8 px canvas margin (`DIAGRAM_CANVAS_PADDING_PX`) instead of its default 40 px, so a flowchart or state diagram is up to 64 px narrower and shorter than the engine's default drawing. It is "up to" because the engine's own clamp on how far an edge reaches still uses the default 40 px. Every size below is measured with the 8 px margin.

In code, `printedNodeLabelPt({ width, height }, figureMaxHeightPx)` in `@repo/utils/proposal-artifact/diagram-label-wrap` computes the formula; the height defaults to a figure's own 792 px. That module cannot import the Word writer's `build-docx/styles.ts`, so it restates the page width, and `print-column-parity.test.ts` pins `PRINT_COLUMN_PX` to `PORTRAIT_TEXT_WIDTH / TWIPS_PER_PIXEL`. The two heights come from the print layer, `PRINT_FIGURE_MAX_HEIGHT_PX` and `PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX` in `proposal-theme-print-page-flow.ts`, which writes its `max-height` rules from the same inch lengths, so the rule and the measure are one number each. The parity test pins the first to `MAX_IMAGE_HEIGHT / TWIPS_PER_PIXEL` too.

A left-to-right chain of nodes whose labels are whole sentences is several thousand pixels wide and prints at roughly 1.6 to 5 pt. The four-step sentence chain in `render-diagrams.test.ts`, three of whose labels are too wide for their boxes, measured at each step of the export:

| Step | SVG size | Printed labels |
|---|---|---|
| As written, `flowchart LR` | 1781 × 74 px | 3.63 pt |
| Labels too wide for their boxes broken, still `LR` | 1167 × 104 px | 5.54 pt |
| Broken, turned top-down | 375 × 429 px | 9.75 pt |
| As written, turned top-down | 480 × 311 px | 9.75 pt |

The export lays out the first two rows and keeps the second: its labels fit their boxes, and they print larger too. It is below the floor, so the export turns both copies top-down. Both print at 9.75 pt, and the broken one is kept, since three labels of the other would spill out of their boxes. Recompute any row as 13 × min(1, 662.4 / width, 792 / height) × 0.75.

Height matters for tall diagrams. Breaking labels makes a diagram narrower but taller. An eight-step top-down chain of 73-character labels lays out at 487 × 650 px as written (9.75 pt), but at 229 × 1053 px with its labels broken (7.33 pt). As written, every label spills out of its box, by about 0.7 px a side in print and 2.4 px on the page, so the broken copy is kept: it prints below the floor, and the export warns.

The same holds once a diagram is turned. An eight-step left-to-right chain of 40- to 55-character labels, two of them too wide for their boxes, prints larger sideways with those two broken: 2899 × 91 px (2.23 pt) against 3195 × 74 px (2.02 pt). Turned top-down, the broken copy is 380 × 718 px and the copy as written 384 × 650 px, both at 9.75 pt, and the broken one is kept. The six-item timeline in the Glossy layout is 251 × 984 px broken and turned (7.84 pt) and 775 × 481 px turned as written (8.33 pt). The second prints larger, but its labels spill, so the export keeps the first, still below the floor, and warns.

## What the export does

The export and the live page share one module, `@repo/utils/proposal-artifact/diagram-label-wrap`: the helpers below, the measure and its limits (`printedNodeLabelPt`, `PRINT_COLUMN_PX`, `PRINT_FIGURE_MAX_HEIGHT_PX`, `PRINT_FIGURE_UNDER_OPENER_MAX_HEIGHT_PX`, `PRINT_LABEL_FLOOR_PT`), the prediction of which labels are too wide for their boxes (`nodeLabelLineOverflows`, and `flowchartNodeLabelsOverflow` for a whole copy), the choice between copies (`printsBetter`) and the 8 px canvas margin (`DIAGRAM_CANVAS_PADDING_PX`). The labels are found with the same node patterns beautiful-mermaid's parser uses, and the prediction restates its width table, so both must be checked again after an engine upgrade.

`packages/temporal/src/activities/proposal-export/render-diagrams.ts` applies the formula to every flowchart and state diagram, and to every figure template (`proposal-figures/`), whose text is 12 px: 9 pt at full size, exactly the floor, so a template taller than its figure may be warns. Other kinds (charts, sequence, class, ER) size their text by rules of their own and are not measured. `renderOne`:

1. **Chooses between the copy as written and one with the labels too wide for their boxes broken.** The export lays out the copy as written. When `wrapFlowchartNodeLabels` with `overflowingOnly` changes anything, it lays out that copy too. That copy breaks each one-line node label `nodeLabelLineOverflows` predicts would spill out of its box: the title before a ` — `/` – `/` - ` dash, then a trailing parenthesis, then at words, up to 30 characters a line and never a line the prediction says would spill. Labels that already have line breaks or inline formatting are left as written. No word is cut or dropped. A copy whose labels all fit their boxes (`flowchartNodeLabelsOverflow`) beats one whose labels spill, however much larger the other prints (`printsBetter`). Between two copies that fit, or two that spill, the one whose labels print larger is kept, the broken copy on a tie. A copy the engine refuses drops out. The steps below start from the copy kept.
2. **Re-lays it top-down.** If the graph is below the floor, `turnFlowchartTopDown` changes an `LR`/`RL` header to `TD` in the copy only. The fence in the document is untouched. When the broken copy was kept, the copy as written is turned too, because broken labels make a turned diagram taller and a tall one prints smaller; it is kept only when its labels fit their boxes as the kept copy's do. The render that prints better is kept; the broken one wins a tie.
3. **Breaks the remaining long labels.** If the diagram is still below the floor, `wrapFlowchartNodeLabels` without `overflowingOnly` breaks every one-line node label longer than one wrapped line, the same way. The better render wins again.
4. **Warns.** A diagram still below the floor prints as it is and counts toward one `DIAGRAM_BELOW_PRINT_FLOOR` export warning. The download menu shows it as `exportWarningDiagramBelowPrintFloor` (`DocumentDownloadDropdown.tsx`).

Every figure is measured against the height it prints at. For the PDF, `printFigureMaxHeight` in `print-openers.ts` reads the prepared Markdown as the print page walks it: a fence that is the first block of a section to print anything, past the opener's subtitle and every block that prints nothing (`printsNothing`: a definition, an author's comment, a dropped image, a `cover` block, an empty table, a diagram left out), follows the opener's header on the page and is offered 600 px or less; every other fence, and every fence of the DOCX, 792 px. The print page finds the block after an opener with the same `firstPrintedAfterOpener`, and the diagram step asks for each fence's height with the diagrams drawn before it, so a diagram the engine refused between an opener and a fence counts too. A fence is laid out for the height it is offered; when its labels would fall below the floor there, it keeps 792 px instead, is laid out again for that height, and moves whole to the next page. The print page writes the same height on the figure (`figureMaxHeightAsDrawn`), so only a diagram below the floor even at 792 px is reported.

The live page draws its own copy the same way. `drawDiagram` in `apps/web/modules/saas/projects/lib/tiptap-mermaid-extension.tsx` draws with the same canvas margin:

- **A client-document Proposal's page** makes the export's choice and follows its floor rule. It measures each drawing's width and height against the print column and a figure's own 792 px, so the page shows the layout the PDF prints. It does not know which fence the print page places right after an opener, so for such a fence the PDF can choose another layout that stays legible in the room there.
- **Other documents** always draw the copy with the labels too wide for their boxes broken (see the next section for why), since height does not matter on screen. They keep the direction their author wrote.

Only the drawn copy changes, never the fence. After that, `mermaid-diagram-sizing.ts` shrinks a diagram only as far as its smallest label stays at `MIN_DIAGRAM_LABEL_PX = 12`, and a wider one scrolls sideways in its container.

The generation side helps too. Proposal diagrams the visuals step writes use a short title plus at most one short detail per node, and timelines are drawn top-down. Diagrams stored before that change are why the export still has to wrap.

## Text width is estimated, not measured

beautiful-mermaid sizes a node box from `measureTextWidth`: a per-character width table (`getCharWidth`) × font size × a weight ratio of 0.54 to 0.60. It never measures the font that is printed. The export prints in Inter, which ran wider than the estimate in the PDFs we reviewed, so a long label could spill past its box. Wrapping shortens each line and makes the spill smaller. Treat the SVG width the renderer reports as a good estimate of size, not a guarantee that the text fits its shape.

On the live page the font is Inter at 500 weight and 13 px. Measured in the browser against the boxes the engine drew, the estimate runs short by:

- about 5 to 9% for plain prose (0.3 to 0.5 px a character);
- 13 to 30% for text dense in narrow letters and dashes, up to about 1 px a character, such as "implementation — implementation of the agreed pilot scope" (57 characters, estimated at 326 px, drawn 370 px wide in a 366 px box);
- almost nothing for capitals.

Measured one glyph at a time, the em dash is 5.5 px wider than its estimate. Lower-case m is 2.6 px wider, the hyphen 2.2, w 1.8, and f and t about 1.4. Narrow i and l are close to their estimates (0.24 px), and r, s, E and L are drawn narrower than estimated.

A box gives its label 20 px of padding on each side, so a one-line label spills once that shortfall passes 40 px. Prose would need 80 characters or more for that; the longest prose label measured, 54 characters, still had 8.8 px to spare on each side. Text dense in narrow letters and dashes, at up to about 1 px a character, reaches it from about 41 characters. The first such label seen to spill had 44.

So the page, the export and the browser download predict the width instead. `nodeLabelLineOverflows` adds up Inter's own advance for each character (`inter-advances.ts`, keyed by character), measured in Chromium at 13 px for the 400 and 500 faces with the wider kept, and compares it with the engine's estimate plus the 20 px of padding a side. Cyrillic, Greek and the Latin letters that do not decompose are measured in print's 400 and 600 faces, since the page loads only Inter's Latin subset; the engine counts their capitals as average lower-case letters, so a 36-character all-caps Russian label, "ЦЕНТРАЛИЗОВАННОЕ УПРАВЛЕНИЕ ДОСТУПОМ", prints 319 px wide in a 298 px box, about 10 px past each side, unless it is broken. Any other capital counts as 0.72 em. A line that would come within 4 px of either side of its box is too wide. Such a label is broken into lines, each packed by the same prediction, and a label that fits stays on one line whatever its length: a 55-character prose label fits, while 30 characters dense in m, w and hyphens can spill. Each line of a label already broken is measured in the box its widest line sets, as the engine sizes it. The browser download draws in Helvetica, which is 6 to 11% narrower than Inter for lower-case text, so its labels have more room.

Text dense in m, w and hyphens with an em dash runs further short, at 1 to 1.4 px a character. "momentum — minimum-time multi-team flow" (39 characters) spills by 6 px a side, and a 30-character line of the same text by about 1 px. No character count keeps such text inside its box.

Print embeds Inter 4.1 at 500 as well, so it draws node labels in the engine's weight, as the page does. Measured in the print Chromium, its Medium face is within 1/1000 em of the table for Basic Latin, the rounding of the table itself. Cyrillic, Greek and the other letters the table takes from the 600 face draw narrower in Medium (Ж 996 against 1032, Δ 716 against 736), so they break a label a little early, as before.

The 8 px canvas margin does not change any of this: it is the space around the whole drawing, while the 20 px is inside each box.

The choice between copies puts fit before size. Breaking labels makes a diagram taller, and a tall one prints smaller, so the copy as written can print larger than the broken one. It is kept only when its labels fit their boxes as well: in the PDF, the DOCX and on a Proposal's page, a copy whose labels spill never beats one whose labels fit. A diagram can therefore print below the floor where its copy as written would not, and the export warns; a label across its box's border would go unreported. Only a label no copy fits, a single word too long for its box or one with line breaks or formatting of its own, which no wrap touches, can still spill. The engine also writes its `font` option inside quotes (`font-family: '<font>', system-ui`). The page used to pass a whole font stack there, which no family matches, so the text was drawn in system-ui. It now passes the single family `Inter`, the font the width table is tuned for.

## The lesson: judge the rendered PDF, not the data

The 3 pt chart passed every data-level assertion. Before saying an export "works", open the PDF and look at the diagrams at print size. Better still, compute the printed size from the SVG's width and height, which turns "it looks small" into a number a test can assert.

## How to test

`packages/temporal/src/activities/proposal-export/__tests__/render-diagrams.test.ts`:

- "the print legibility floor (Fizzy #2946)": the print column equals (8.5 − 2 × 0.8) × 96 and prints at 9.75 pt; a sideways chain of sentence labels is laid out top-down once and prints at 9 pt or more; a label too long even top-down is kept sideways once broken and prints at 9 pt or more; a sideways pair of 70-character labels stays sideways with its labels broken, as the live page draws it; a 57-character label dense in narrow letters is broken even in a diagram the floor rule turns; a sideways chain of eight 40- to 55-character labels prints top-down with only its two labels too wide for their boxes broken; labels that fit are broken only once top-down is still below the floor; a broken copy the engine refuses drops out; a tall top-down chain of 73-character labels prints broken and warns, though as written it prints larger, and a shorter one whose two copies tie keeps the broken one; a branched diagram right after a section opener, past its subtitle, an author's comment or a fence the engine refuses, or after a paragraph, whose labels 600 px or less would take below the floor keeps 792 px without a warning, while a shorter one is shrunk to the room there with its labels at the floor or above; the better render is kept and the warning raised when even broken labels are too wide; a figure shrunk below the floor by its height warns, and so does one whose kept broken copy is still too wide; a top-down diagram too wide to turn still warns.
- "figure templates and diagrams that do not draw (Fizzy #2946)": a gantt template taller than 600 px and no taller than 792 px prints at the floor after a subheading and right under a section opener, where it keeps 792 px and moves whole, and only a template taller than 792 px warns; a plain chain of twelve steps draws from the process template without a layout, and one of six with the engine.
- "long node labels broken for print (Fizzy #2946)": labels of 130 characters or more print at 9 pt or more with every word kept; labels with existing breaks are left alone; every common node shape is handled, quoted or not; six-item timelines and flows reach the floor; the same timeline in the Glossy layout prints broken and turned, though turned as written it prints larger, still below the floor, and warns.

`proposal-artifact-diagram-label-wrap.test.ts` in `packages/utils` checks the 600 px measure, which copies `flowchartNodeLabelsOverflow` finds a label too wide in (a broken label's lines in the box its widest line sets, node labels of flowcharts only) and that `printsBetter` puts a copy that fits before one that spills, and otherwise the larger print first. `build-theme-html.test.ts` checks that `printFigureMaxHeights` gives 600 px to exactly the figures the print page places right after an opener's header, and `proposal-artifact-theme.test.ts` that both `max-height` rules come to the exported heights.

`engine-label-metrics-parity.test.ts` draws single-node flowcharts with the installed beautiful-mermaid and checks that each box is exactly as wide as `nodeLabelBoxWidthPx` estimates and each label is set at 13 px in weight 500, so an engine upgrade that changes the mirrored estimate or padding fails there. `print-column-parity.test.ts` checks that the shared print column is the Word writer's text width, that the figure height is its tallest picture and shorter than the page's 888 px text area, and that the export measures with the shared values. On the live side, `tiptap-mermaid-label-legibility.test.tsx` draws the same 70-character pair sideways with its labels broken and the 8 px margin. It also draws the tall chain broken on a Proposal's page, as it prints, and on any other page, and the eight-step sideways chain top-down with its two labels too wide for their boxes broken on a Proposal's page. It breaks the 57-character label on both pages, and `markdown-to-document-mermaid-labels.test.ts` breaks it in the browser download.

These tests lay out with the real renderer and measure the SVG's `viewBox` width and height. Keep it that way: a mocked width cannot catch a layout that grew.

## Related

- [a-react-node-view-without-node-view-content-shows-its-nodes-text.md](../ui-bugs/a-react-node-view-without-node-view-content-shows-its-nodes-text.md): the same diagrams on the live page.
- [identity-inside-text-that-writers-replace-wholesale.md](../architecture-patterns/identity-inside-text-that-writers-replace-wholesale.md): the marker and caption `%%` lines a diagram carries, which the export strips from its copy before layout.
