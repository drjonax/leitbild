# Halden border: beat checklist per preset

The iPad walkthrough of `halden-border` (Red scripted) and `halden-border-human-red` (Red played by a person). Each screen picks a preset in the groups dialog and is checked against the observations below, which were written before the walkthrough.

The observations come from a headless play on the Einsatz Board controller (`border-demo.test.ts`, `fixtures/border-demo.ts`): one screen holding "Blue (one person)" gives every Blue order by taps, and watching screens hold "Civil desks", "Blue military" and, with human Red, "Red commander". The headless play uses the direct (straight-line) router at 15 m/s; the walkthrough runs on OSRM, so every ETA, every time in a phase and every "≈" figure is approximate. A figure marked **exact** must match; the words on rows must match.

## Setup

- Start a Run of the Definition on an iPad in landscape. The groups dialog opens: tap a preset row, then Join. Presets: "Blue (one person)" (EMS, Police, Fire, Blue recce, Blue armour), "Civil desks" (EMS, Police, Fire), "Blue military" (Blue recce, Blue armour) and, with human Red, "Red commander" (Red recce, Red armour). The Controller row stays for an instructor.
- Every screen: Board open on the right, map on the left with every object in view (the starting camera fits them beside the Board).
- The good dispatcher: tap each unserved call as it appears, then the Dispatch button; on a divert, tap again to confirm. Besides that, three beats (below): pull the recce back at 11:00, + on P1 then C-11 at 13:55, F1 then C-12 then Add to end at 15:00.

## On every screen

- **Fog.** A Blue screen never shows a Red unit or a Red call; Red shows as "Contact" (neutral icon) or "Identified · Tank" / "Identified · Recce", and as "Destroyed · …" once a kill is watched. Red never sees a Blue call.
- **Public places.** "Halden emergency clinic — exercise", "Ystehede receiving site — exercise" and "Objective KNUT — exercise" are on every map.
- **OP East** (an observation post of Blue recce) is on the Blue maps, north-east of Tistedal; it is not in the Units list, which lists units that move.
- **Words.** Lists read "Calls", "Units", "Contacts"; the send button reads "Dispatch"; an empty list reads "No calls waiting".

## t = 0:00

- **Blue (one person)** and **Blue military:** two calls (**exact** order): "P2 Overwatch Rv21 east of KNUT · needs 3 more tanks · Tank 2 + Tank 1 + Tank 3 ≈2:49" and "P2 Screen east of Tistedal · needs 1 more recce · Recce 1 ≈4:13". Every unit available. No contacts yet.
- **Civil desks:** "No calls waiting"; A1–A4, H1, P1, P2, F1 available.
- **Red commander (human Red):** "P1 Attack Objective KNUT · needs 2 more tanks · Tank 1 + Tank 2 ≈10:14" and "P2 Scout the Tistedal road · needs 1 more recce · Recce 1 ≈4:10"; Recce 1 and Tank 1–4 available.

Taps (Blue): Overwatch row, Dispatch; Screen row, Dispatch (4 taps).

## t = 0:30

- **Every Blue screen:** five "Contact" rows (T-1 … T-5) from OP East: Red assembling across the border.
- **Blue (one person)** and **Civil desks:** "P2 C-1 Brekke · needs P2×1 · A3 ≈2:04". Tap it, Dispatch.
- **Blue military:** both calls served, "3 en route" and "1 en route".

## t = 5:00

- **Blue military:** Tank 1–3 available at the overwatch (call closed); Recce 1 "Screening" at its post. Red's contacts start to move (scripted Red leaves for its ambush now).
- **Civil desks:** C-2 Rv21 Tistedal (accident, P2) served by P2 and A1; C-3 Busterud (P3) by A2; A3 transporting to the Halden clinic.
- **Red commander (cautious plan):** sends Recce 1 to its Scout call and three tanks onto the ground north-east of Tistedal.

## t = 9:00

- **Every Blue screen:** Contacts read "Destroyed · Recce" (T-1, killed by the overwatch at about 8:35), three "Identified · Tank" and one "Contact": the recce on its post has found the column.
- **Civil desks:** C-4 Rød (building fire, P1 floor) served by F1 and A3, both en route.

## t = 11:00 (beat: Red pushes)

Scripted Red's three tanks drive onto the Tistedal heights, at the screen post.

- **Blue military / Blue (one person):** tap Recce 1, tap Recall (2 taps). Recce 1 turns "returning". If nobody recalls it, it is destroyed at about 15:00 and two "P1 Casualty · Recce 1" calls appear on the heights.
- **Civil desks:** C-5 Idd served by H1, C-6 Sentrum by P1.

## t = 13:00

- **Blue military:** the three Red tanks are "Identified · Tank" under **Engageable**; Tank 1–3 fire at them on their own (weapons free by default).
- **Civil desks:** the burst begins: C-7 Gimle (P2, A4) and C-8 Hollenderhaven (P3, A1) served; C-9 Torpum (13:10), C-10 Os (P1, 13:30) and C-11 E6 Svingen (13:55) follow.

## t = 13:55 (beat: two calls, one free car)

- **Civil desks / Blue (one person):** C-11 E6 Svingen needs a patrol car and P1 and P2 are both busy. Tap + on P1, then C-11 (2 taps): the row reads "P1 next, 1 step ahead". Its ambulance part: tap C-11, Dispatch, confirm "Divert A1 from C-8 Hollenderhaven (P3)" (3 taps).

## t = 15:00 (beat: Do now or Add to end)

- **Civil desks / Blue (one person):** "P3 C-12 Svinesund road · needs 1 more fire engine · No free unit · 1 busy". Tap F1, tap C-12, tap **Add to end** (3 taps). Do now would pull F1 off the building fire.
- **Blue military:** "Under fire: T-4 (Tank)" on Tank 1; Contacts: one Red tank destroyed, the others damaged and withdrawing.

## t = 18:05

- **Civil desks:** "Halden emergency clinic — exercise: not accepting" in the log; A1, A2 and H1 are "transporting → Ystehede receiving site — exercise" (released from the clinic at 18:00 with their patients). C-12 reads "F1 next, 1 step ahead"; "P3 C-13 Remmen · No free unit · 2 busy".
- **Blue military:** "P2 Screen the border road" (17:30) served by Recce 1, en route. Contacts: two Red tanks destroyed, one identified, one contact (Red's reserve).

## t = 20:05

- **Blue military:** "Tank 4: new · Tank" at Halden and "P2 Reinforce Objective KNUT", served by the nearest free tank (Tank 1).
- **Civil desks:** "P2 C-14 Brattås · No free unit · 2 busy": both cars on scene; it is served at about 20:30.

## t = 22:00 – 24:05

- **Every Blue screen:** Red's reserve tank moves towards KNUT and turns "Identified · Tank" once the recce on the border road sees it; the tanks engage it on their own (destroyed by about 28:40).
- **Civil desks:** C-15 Kongeveien (21:00, H1), C-16 Tistedal school (22:00, A4 diverted from C-13 Remmen, which A2 takes), C-17 Ystehede road (23:00, A3). At 24:05: "P3 C-18 Ørbekk · No free unit · 4 busy"; A1 takes it at about 24:20.

## t = 25:00 (beat: the late top-priority call)

- **Civil desks / Blue (one person):** "P1 C-19 Bakke · needs P1×1 · A1 ≈1:35 · Divert A1 from C-18 Ørbekk (P3) · ≈1:35". Tap C-19, Dispatch, confirm (3 taps).
- **After:** C-19 "1 en route"; "P3 C-18 Ørbekk · No free unit · 5 busy" with the alert "A1 released from C-18 Ørbekk · 1 patient waiting". A3 takes C-18 at about 28:15; every call is closed by about 34:20.

## Human Red

The Blue screens see the same calls. Red's screen ("Red commander") shows Red's two calls, its five units and its own Contacts; it never sees a Blue call.

- **A cautious Red** (the scripted column's moves, then Tank 1 + Tank 2 onto the Attack call at 13:00) loses its recce at about 8:30 and its tanks to the overwatch; at 25:00 its Attack call still reads "needs 2 more tanks · Tank 2 + Tank 4", with Tank 1 and 3 destroyed and Tank 2 damaged. Blue loses nothing; KNUT holds.
- **An all-in Red** (at 0:30: Recce 1 to Scout, Tank 1 + Tank 2 to Attack, Tank 3 and Tank 4 to ground beside KNUT; at 10:00 Tank 4 onto Attack) catches Blue moving up: Blue's recce is destroyed at about 4:15 and Tank 1–3 by about 9:00, casualty calls flood EMS from 4:10 and force diverts, and Red completes the Attack at about 13:00 for one tank destroyed and one damaged. Red's choice of when to strike decides the game.

## Found while writing these observations

1. **Blue's tanks fire freely by default.** The touch Board has no rules-of-engagement control, so a Blue tank on "return fire" could never open fire first on a tap. The Definition sets Blue's tanks to weapons free; engaging a track by tap picks the priority target.
2. **A damaged unit is still recommended.** In the all-in Red play the recommendation sent Blue's damaged recce, which had withdrawn, back to its screen post at 4:10, where it was destroyed. Reported, not changed here.
3. **OP East is not on the Units list.** Units that do not move are listed nowhere on the Board; OP East is visible on the map only.
