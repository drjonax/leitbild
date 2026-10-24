---
name: multiunit-displays
description: Shows several like units at once in one live vignette (a fleet table, a comparison across units, or a trend over a set). Use when asked how the units of a kind are doing, which needs attention, or to compare or rank them. Skip when one unit or a sentence answers.
allowed-tools: [workspace_explore, workspace_call]
---

This extends operator-displays: its compose call, one-vignette, citation, refusal and `leitbild-view` rules all apply.

A set is `{"category": "<category>", "group": "<group>"}`, copied from the Run context's "as a set" line, or at most 12 exact object ids. A group is re-resolved each sample, so units that come or go show; never list more than 12 ids, use the group. A view of a set takes `subjects: []`.

Pick one view, fleet when unsure:
- `{"kind": "fleet", "of": <set>}`: how the units are doing; each unit worst first under its counts.
- `{"kind": "compare", "of": <set>, "signals": [...]}`: up to 8 quantities side by side, e.g. which unit is furthest from the others.
- `{"kind": "trend", "of": <set>, "signals": [...]}`: up to 4 quantities over time; many units draw as a band (min to max, median line) with the outliers named.
- `{"kind": "alerts", "of": <set>}`: the set's alerts ranked.
Name a quantity as the context or a refusal words it ("Pressurizer pressure"), never one unit's ref; World matches it on every unit.

Which needs attention: rank by the group line's worst unit and counts, name the top unit at caution or above with its alert text, then show the fleet. Furthest from a value: compare that quantity and name the unit its card line shows furthest.

Cite as the card reads: the first line counts units (12 units ⟦k1⟧); a unit's number takes its unit line's key; a band line ("12 units", min · median · max) supports a spread, never one unit's value. "not measured" is not zero.

`not_fitted` on a set means more units at caution or above than fit: show the set's alerts or name them in text; never pick a subset that hides one. A quantity no unit measures is refused with the ones that exist; choose once.
