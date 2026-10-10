# viz — Suomen ajoneuvokanta

A one-page D3 report built on the L0 index of Traficom's open vehicle register
(5.3 M vehicles, 30 June 2026).

```bash
node viz/build-data.js data/vehicles-v3.l0   # runs the aggregation queries -> data/aggregates.json
python3 -m http.server 8231 --directory viz  # then open http://localhost:8231/
```

## How it fits together

`build-data.js` runs every visualisation as one aggregation query against the
artifact and records what each one cost — time, **dependent round trips**, range
reads, bytes. Those costs are shown on the page, because the point of the index
is the round-trip column, not the chart.

The page itself loads three static files: the aggregate JSON, and the
municipality and region boundaries from
[samilaine/hallinnollisetrajat](https://github.com/samilaine/hallinnollisetrajat)
(WGS84, `NATCODE` joins to the register's `kunta`).

**The aggregates are precomputed.** Querying the 2.1 GB artifact live from the
browser needs an HTTP Range transport, which is the next piece of work; the
current `FileTransport` is Node-only. The costs shown are real measurements from
the Node run, not estimates.

## Charts

| Section | Query | Form |
|---|---|---|
| Montako on jäljellä | histogram(vuosi) | log-scale area, read this one first |
| Käyttövoima × vuosi | 3 histograms: fuel terms + hybrid class, all and diesel-only | stacked area, counts or shares |
| Sähköistyminen | histogram + terms(kunta), year slider | choropleth |
| … maakunnittain | same query, rolled up via `kunta → maakunta` | 18 small multiples, one shared y |
| Minkälaisia autoja | histogram + 4 × avg | indexed lines (1995 = 100) |
| Värit | histogram + terms(vari) | one column per year, boxes re-ranked yearly |
| Merkkien kärkisijat | histogram + terms(merkki, 40/yr) | bump chart, rank 1–10 |
| Porschet | terms(luokka) + terms(nimi) + histogram × terms | two tables, one classification |
| Rouheimmat saundit | terms(kunta) over ≥8 cylinders | choropleth + table |
| Brameilijat | terms(kunta) → rolled up to maakunta | choropleth + table |
| Mittarilukema | terms(merkki) + stats, 2010 cohort | horizontal bars |

Colour follows the bundled data-viz palette: categorical slots in fixed order
for the stacks and lines, a single-hue blue ramp for every choropleth, validated
in both light and dark against the surface. Dark mode has its own steps, not an
inverted flip.

Two deliberate departures:

- **Colours-by-year uses the colour each series represents**, not the categorical
  palette — the category *is* a colour, so any other encoding would be perverse.
  It also **re-sorts the boxes every year** instead of holding one stacking order.
  That breaks the usual rule only in appearance: hue still follows the entity, it is
  *position* that follows rank, so the bottom box is always that year's most common
  colour and a colour changing places is itself the event. A fixed order let you see
  a band get thinner but never when it lost its place.
- **Indexed lines instead of four y-scales.** Mass (kg), displacement (cm³), power
  (kW) and CO₂ (g/km) share one axis only because everything is indexed to
  1995 = 100. A dual axis would have been the easier and wronger choice.

## Two reader fixes this page paid for

Both were found by reading the cost column, not by profiling.

- **`min_doc_count` was applied after the work, not before.** A terms aggregation
  with a numeric sub-aggregation disabled the id-list counting path, so all 15 651
  brands were decoded into dense 661 kB bitmaps and AND-ed across 5.29 M documents
  — to keep 26. Counting first and materialising only survivors: **3 898 ms → 31 ms**,
  byte-identical output. The whole page's aggregations went 4 199 ms → 902 ms.
- **The histogram's terms sub-aggregation had the same shape.** It built one dense
  bitmap per value up front; at 15 651 brands that is ~10 GB resident. Counting id
  lists directly made `merkit × vuosi` possible at all (136 ms, 18.4 MB).

A third cost is architectural rather than a bug: fetching the 5 978 Porsches as
documents costs **1 672 MB**, because a scattered result set pays a whole 177 kB
stored block per row. The Porsche section uses two aggregations (77 MB) instead.

## Every chart shows its own query

Each section carries a collapsed `<details>` box listing the OpenSearch query that
produced its numbers, with that query's measured cost (ms, round trips, range
reads, bytes). The bodies are recorded by `timed()` in `build-data.js` and shipped
in `aggregates.json`, so the box cannot drift from what was actually run. Boxes are
matched to sections by label prefix: rename a query and its box disappears rather
than showing the wrong DSL.

## What the data will not support

Written into the page as well, because every one of these can produce a
confident wrong reading:

- **Survivorship.** The register is what is still on the road. About 8 % of the
  1995 cohort survives, and not at random — every old-year statistic is a
  statistic about survivors.
- **`kunta` is the registration municipality**, i.e. the company's address for
  company-owned vehicles. For rare vehicles this dominates: 19 supercars in
  Hausjärvi is almost certainly one importer, not local taste.
- **Åland has its own vehicle register** and appears here with ~1 000 rows. It is
  grey on every map and excluded from the rankings.
- **Odometer readings contain garbage** — the maximum in the file is over a
  billion kilometres. All mileage figures are trimmed to 10 000–1 000 000 km.
- **CO₂ coverage collapses for new cars** (NEDC → WLTP), so the rise at the right
  edge of that curve is a measurement change, not an emissions change.
- **2026 is a half year.**
- **Brand and model names are not normalised.** Traficom spells Volkswagen two ways
  (`Volkswagen`, `Volkswagen, VW`) which would otherwise split it from second place
  into sixth and ninth; `Datsun-Nissan` is separate from `Datsun`. Model names are
  worse: the Porsche 356 alone appears under 11 spellings, and 544 of 5 978 Porsches
  carry no model name at all.
- **`M1` is not all passenger cars.** Cayenne and Macan are registered as `M1G`
  (off-road passenger car), so an `M1`-only filter showed 67 Cayennes instead of
  2 248 — it is the commonest Porsche in Finland, not a rounding error. Filtering a
  brand without a class filter has the opposite problem: 212 of Porsche's 8 894
  vehicles are 1950s–60s Porsche-Diesel tractors.
- **`kayttovoima` cannot see a hybrid.** A plug-in and a self-charging hybrid are
  both filed as `01 Bensiini`; the codes that look right — 39 `Bensiini/Sähkö`,
  44 `Diesel/Sähkö` — hold 944 rows in the whole 5.3 M register. The split lives in
  `sahkohybridinluokka`, where `01` is OVC-HEV (chargeable) and `02` NOVC-HEV.
  That reading is checked against emissions, not assumed: class 01 reports CO₂ only
  in the weighted NEDC2/WLTP2 columns and averages 29 g/km, class 02 reports in the
  plain ones and averages 118 g/km. Without the split, a quarter of recent "petrol"
  cars are mislabelled — and the electrification map, which counts `kayttovoima=04`,
  correctly excludes plug-ins but should say so.

## Two choices worth defending

- **The survivorship chart comes first.** Every later chart about old model years
  is a chart about survivors, and that only lands if you have already seen that
  pre-1990 years hold a few thousand cars against 131 091 in 2017 — three orders
  of magnitude. Putting the caveat in prose under chart four would not have done it.
- **18 regions became small multiples, not 18 lines.** Past eight series a
  categorical palette stops separating, and the comparison here is between
  regions, so all 18 panels share one y-scale. The shape turns out to be identical
  everywhere — including a 2024 dip in 18 of 18 — which is the finding, and it is
  only visible because the panels are comparable.
