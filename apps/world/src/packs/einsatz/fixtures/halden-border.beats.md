# Halden border: beat checklist per preset

The iPad walkthrough of `halden-border` (Red scripted) and `halden-border-human-red` (Red played by a person). Each screen picks a preset in the groups dialog and is checked against the observations below, which were written before the walkthrough.

The observations come from a headless play on the Einsatz Board controller (`border-demo.test.ts`, `fixtures/border-demo.ts`): one screen holding "Blue (one person)" gives every Blue order by taps, and watching screens hold "Civil desks", "Blue military" and, with human Red, "Red commander". The headless play uses the direct (straight-line) router at 15 m/s; the same play is also run on routers 1.4 and 1.5 times as long and slow, standing in for roads, and meets every objective there too. The walkthrough runs on OSRM, so every ETA, every time in a phase and every "≈" figure is approximate. A figure marked **exact** must match; the words on rows must match.

## Setup

- Start a Run of the Definition on an iPad in landscape. The groups dialog opens: tap a preset row, then Join. Presets: "Blue (one person)" (EMS, Police, Fire, Blue recce, Blue armour), "Civil desks" (EMS, Police, Fire), "Blue military" (Blue recce, Blue armour) and, with human Red, "Red commander" (Red recce, Red armour). The Controller row stays for an instructor. In `halden-border` Red's groups read "Red recce (scripted)" and "Red armour (scripted)": they are not for players there.
- Every screen: Board open on the right, map on the left with every object in view (the starting camera fits them beside the Board).
- The good dispatcher: tap each unserved call as it appears, then the Dispatch button; on a divert, tap again to confirm. Besides that, three beats (below): pull B-Recce 1 back at 11:00, + on P1 then C-11 at 13:55, F1 then C-12 then Add to end at 15:00.
- The exercise ends at **30:00** (**exact**): every call, civil and military, should be closed by then.

## On every screen

- **Fog.** A Blue screen never shows a Red unit or a Red call; Red shows as "Contact" (neutral icon) or "Identified · Tank" / "Identified · Recce", and as "Destroyed · …" once a kill is watched. Red never sees a Blue call.
- **Names.** Blue's units are "B-Recce 1" … and "B-Tank 1" …, Red's "R-Recce 1" … and "R-Tank 1" …; no two units share a label.
- **Public places.** "Halden emergency clinic — exercise", "Ystehede receiving site — exercise" and "Objective KNUT — exercise" are on every map.
- **OP East** (an observation post of Blue recce) is on the Blue maps, north-east of Tistedal; it is not in the Units list, which lists units that move.
- **Words.** Lists read "Calls", "Units", "Contacts"; the send button reads "Dispatch"; an empty list reads "No calls waiting".

## Something to decide every three minutes

The headless play records, for each preset, when a call newly needs units on its list or a beat falls to one of its groups. No preset waits longer than 3:30 (**exact** bound) from 0:00 to 30:00:

- **Civil desks:** 0:30, 2:30, 4:30, 6:30, 9:00, 10:30, 12:30, 12:50, 13:05, 13:20, 13:55, 15:00, 16:30, 18:30, 21:00, 21:30, 22:30, 24:30, 26:30.
- **Blue military:** 0:00, 3:00, 6:00, 8:30, 11:00, 13:00, 15:30, 18:30, 21:00, 22:30, 25:00, 26:30.
- **Red commander (human Red):** a new Red call at 0:00, 3:00, 6:00, 9:00, 12:00, 15:00, 18:00, 21:00, 24:00 and 26:30.

## t = 0:00

- **Blue (one person)** and **Blue military:** two calls (**exact** order): "P2 Overwatch Rv21 east of KNUT · needs 3 more tanks · B-Tank 2 + B-Tank 1 + B-Tank 3 ≈2:49" and "P2 Screen east of Tistedal · needs 1 more recce · B-Recce 1 ≈4:13". Every unit available; B-Recce 2 waits at Halden. Five "Contact" rows (T-1 … T-5) from OP East: Red assembling across the border.
- **Civil desks:** "No calls waiting"; A1–A5, H1, P1, P2, F1 available.

Taps (Blue): Overwatch row, Dispatch; Screen row, Dispatch (4 taps).

## t = 0:30 – 6:00

- **Civil desks:** "P2 C-1 Brekke · needs P2×1 · A3 ≈1:49" at 0:30, then C-2 Rv21 Tistedal (2:30, accident: a patrol car and an ambulance), C-3 Busterud (4:30). Tap each, Dispatch.
- **Blue military:** "P2 Screen the Ystehede road" at 3:00 (B-Recce 2). At 5:30 "B-Tank 4: new · Tank" arrives behind KNUT, and at 6:00 "P2 Hold Objective KNUT" recommends it: it is nearer KNUT than the overwatch tanks, which stay where they are.
- At 5:00 Red's contacts start to move (scripted Red leaves for its ambush now).

## t = 6:30 – 9:00

- **Civil desks:** C-4 Rød (6:30, building fire, P1 floor: F1 and an ambulance), C-5 Idd (9:00).
- **Blue military:** at 8:30 "B-Tank 5: new · Tank" arrives at Halden with "P2 Guard the Ystehede road", which recommends it.
- **Every Blue screen:** at about 8:40 Contacts read "Destroyed · Recce" (T-1, killed by the overwatch), three "Identified · Tank" and one "Contact": the recce on its post has found the column.

## t = 11:00 (beat: Red pushes)

Scripted Red's three tanks drive onto the Tistedal heights, at the screen post.

- **Blue military / Blue (one person):** tap B-Recce 1, tap Recall (2 taps). B-Recce 1 turns "returning". If nobody recalls it, it is destroyed at about 15:00 and two "P1 Casualty · B-Recce 1" calls appear on the heights.
- **Civil desks:** C-6 Sentrum (10:30) served by P1.

## t = 12:30 – 13:20 (the burst; the fighting reaches the civil desks)

- **Blue military:** the three Red tanks are "Identified · Tank" under **Engageable**; the overwatch tanks fire on their own (weapons free by default). At 13:00 "P2 Block the Tistedal bridge · needs 1 more tank · B-Tank 4 ≈4:15".
- **Civil desks:** C-7 Gimle (12:30), C-8 Hollenderhaven (12:50), then at 13:05 "P1 C-9 KNUT farm": a farm worker beside Objective KNUT caught in the crossfire as Red attacks. H1 takes it. C-10 Torpum (13:20, police) follows.

## t = 13:55 (beat: two calls, no free car)

- **Civil desks / Blue (one person):** C-11 E6 Svingen needs a patrol car and P1 and P2 are both busy. Tap + on P1, then C-11 (2 taps): the row reads "1 en route · needs 1 more patrol car · No free unit · 2 busy · P1 next, 1 step ahead". Its ambulance part: tap C-11, Dispatch (A3).

## t = 15:00 (beat: Do now or Add to end)

- **Civil desks / Blue (one person):** "P3 C-12 Svinesund road · needs 1 more fire engine · No free unit · 1 busy". Tap F1, tap C-12, tap **Add to end** (3 taps). Do now would pull F1 off the building fire. The row then reads "F1 next, 1 step ahead".
- **Blue military:** Contacts: one Red tank destroyed, the others damaged and withdrawing. At 15:30 "P2 Screen the Tistedal heights" (B-Recce 2).

## t = 16:30 – 18:30

- **Civil desks:** C-13 Remmen (16:30, P3). At 18:00 "Halden emergency clinic — exercise: not accepting" in the log; units carrying patients to it turn to "transporting → Ystehede receiving site — exercise". At 18:30 "P2 C-14 Brattås · needs 1 more patrol car · No free unit · 2 busy": it is served once a car is free.
- **Blue military:** at 18:30 "P2 Screen the border road · needs 1 more recce · B-Recce 1 ≈6:35".

## t = 21:00 – 24:30

- **Civil desks:** C-15 Tistedal school (21:00), C-16 Ørbekk (21:30, P3), then at 22:30 the top-priority call "P1 C-17 Bakke · needs P1×1 · A2 ≈1:02": reach it within six minutes (objective). C-18 Ystehede road (24:30, P3).
- **Blue military:** "P2 Screen east of Tistedal again" (21:00, B-Recce 2), then at 22:30, as Red's reserve probes towards KNUT, "P2 Block Rv21 north of KNUT · needs 2 more tanks · B-Tank 1 + B-Tank 2 ≈1:30". The overwatch tanks engage the reserve on their own once a recce identifies it.
- At 24:00 "B-Tank 6" and "B-Recce 3" arrive at Halden: a reserve for Blue's late calls.

## t = 25:00 – 30:00 (the last orders)

- **Blue military:** "P2 Relieve Objective KNUT" (25:00) and "P2 Screen the Tistedal heights again" (26:30).
- **Civil desks:** "P3 C-19 Ystehede school" (26:30), beside the receiving site.
- Every call is closed by about 29:10, on the slowed routers too; at 30:00 the Calls list reads "No calls waiting". Blue has lost nothing; Red has lost eight or nine steps.

## Human Red

The Blue screens see the same calls. Red's units start on the border road, a few minutes from KNUT. Red's screen ("Red commander") shows Red's own calls, its units and its own Contacts; it never sees a Blue call.

- **t = 0:00:** "P1 Attack Objective KNUT · needs 1 more tank" and "P2 Scout the Tistedal road · needs 1 more recce"; R-Recce 1 and R-Tank 1–4 available.
- **Red's calls after that (exact times):** "Watch the Ystehede road" (3:00), "Scout Objective KNUT" (6:00), "Take the Tistedal heights" (9:00, three tanks), "Observe KNUT from the heights" (12:00), "Scout the border road" (15:00, when R-Tank 5 and R-Recce 2 cross the border), "Probe the Tistedal bridge" (18:00), "Attack Objective KNUT again" (21:00), "Cut Rv21 north of KNUT" (24:00, after R-Tank 6 and R-Recce 3 cross at 23:30) and "Hold the Tistedal heights" (26:30). A Red tank may serve a scouting call.
- **A cautious Red** (the scripted column's moves to its ambush and the heights, then one tank onto the Attack call at 13:00) loses its column to the overwatch; KNUT holds, and Red loses more steps than Blue.
- **An all-in Red** (at 0:30: R-Recce 1 to Scout, R-Tank 1 to Attack, R-Tank 2–4 to ground beside KNUT; at 9:00 a healthy free tank onto Attack) catches Blue moving up: Blue's overwatch and recces are destroyed early, casualty calls flood EMS, and Red completes the Attack at about 12:00 for far fewer steps than Blue. Red's choice of when to strike decides the game.
- **A Red that follows each call's first recommendation** feeds its tanks in one at a time and loses them; its tank calls stay open once every Red tank is destroyed.

## Found while writing these observations

1. **Blue's tanks fire freely by default.** The touch Board has no rules-of-engagement control, so a Blue tank on "return fire" could never open fire first on a tap. The Definition sets Blue's tanks to weapons free; engaging a track by tap picks the priority target.
2. **A damaged unit is still recommended.** In the all-in Red play the recommendations send Blue's damaged units back to their posts, where they are destroyed. Reported, not changed here.
3. **OP East is not on the Units list.** Units that do not move are listed nowhere on the Board; OP East is visible on the map only.
4. **A side wiped out of a kind of unit cannot act on that kind of call.** After the all-in Red rush, Blue's military calls wait for the reserve that arrives at 24:00; after Red loses every tank, its tank calls stay open. Only the Controller can close them.
