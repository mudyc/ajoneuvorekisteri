#!/usr/bin/env node
/**
 * Runs every visualisation query against the L0 artifact and writes the results
 * as one JSON file for the page. Each block records its own cost, so the page
 * can show what the index actually charged for the answer.
 */
import { writeFile, readFile } from 'node:fs/promises';
import { Reader } from '../src/read/reader.js';

const ART = process.argv[2] ?? 'data/vehicles-v3.l0';
const OUT = new URL('./data/aggregates.json', import.meta.url).pathname;
const MK = JSON.parse(await readFile(new URL('../tools/maakunnat.json', import.meta.url), 'utf8'));

const r = await new Reader(ART).open();
const cat = r.catalog;
const M1 = { term: { ajoneuvoluokka: 'M1' } };
const KUNTA = { kunnat: { terms: { field: 'kunta', size: 400, min_doc_count: 1 } } };
const costs = [];

async function timed(label, body) {
  r.resetStats();
  const t0 = Date.now();
  const res = await r.search(body);
  // The body is kept so the page can show the query that produced each number.
  costs.push({ label, ms: Date.now() - t0, rounds: r.stats.rounds,
               reads: r.stats.reads, bytes: r.stats.bytes, query: body });
  return res;
}
const rollup = buckets => {
  const m = {};
  for (const b of buckets) { const k = MK.kuntaToMaakunta[b.key]; if (k) m[k] = (m[k] ?? 0) + b.doc_count; }
  return m;
};

// ---- baselines ------------------------------------------------------------
const baseAll = await timed('kaikki ajoneuvot / kunta', { query: { match_all: {} }, size: 0, aggs: KUNTA });
const totByKunta = Object.fromEntries(baseAll.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count]));
const baseM1 = await timed('M1 / kunta', { query: M1, size: 0, aggs: KUNTA });
const m1ByKunta = Object.fromEntries(baseM1.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count]));

// ---- 0. how many of each model year survive --------------------------------
const counts = await timed('M1 × käyttöönottovuosi', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1945, max: 2026 } } } });

// ---- 1. fuel by year ------------------------------------------------------
const fuel = await timed('käyttövoima × vuosi', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1960, max: 2026,
          aggs: { voima: { terms: { field: 'kayttovoima', size: 8 } } } } } } });

// Hybrids are invisible in kayttovoima: a plug-in and a self-charging hybrid are
// both filed as '01 Bensiini'. sahkohybridinluokka is what separates them —
// 01 = OVC-HEV (chargeable), 02 = NOVC-HEV. Two extra histograms are enough:
// one for the whole M1 fleet, one restricted to diesel, so the petrol split
// falls out by subtraction.
const HYB = size => ({ lk: { terms: { field: 'sahkohybridinluokka', size } } });
const hyb = await timed('hybridiluokka × vuosi', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1960, max: 2026,
          aggs: HYB(6) } } } });
const hybDiesel = await timed('hybridiluokka × vuosi (diesel)', {
  query: { bool: { filter: [M1, { term: { kayttovoima: '02' } }] } }, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1960, max: 2026,
          aggs: HYB(6) } } } });

// ---- 2. electrification by year × municipality ----------------------------
const elec = await timed('sähköautot × vuosi × kunta', {
  query: { bool: { filter: [M1, { term: { kayttovoima: '04' } }] } }, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 2015, max: 2026,
          aggs: { kunnat: { terms: { field: 'kunta', size: 400 } } } } } } });
const m1ByYearKunta = await timed('M1 × vuosi × kunta (nimittäjä)', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 2015, max: 2026,
          aggs: { kunnat: { terms: { field: 'kunta', size: 400 } } } } } } });

// ---- 3. what kind of cars -------------------------------------------------
const traits = await timed('massa/kuutiot/CO₂/teho × vuosi', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1950, max: 2026, aggs: {
    massa: { avg: { field: 'omamassa' } }, kuutiot: { avg: { field: 'iskutilavuus' } },
    teho: { avg: { field: 'suurinNettoteho' } }, co2: { avg: { field: 'NEDC_Co2' } },
    syl: { avg: { field: 'sylintereidenLkm' } }, istuimet: { avg: { field: 'istumapaikkojenLkm' } },
    kori: { terms: { field: 'korityyppi', size: 4 } } } } } } });

// ---- 4. colours by year ---------------------------------------------------
const colours = await timed('värit × vuosi', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1960, max: 2026,
          aggs: { vari: { terms: { field: 'vari', size: 14 } } } } } } });

// ---- 5. V8 prevalence -----------------------------------------------------
const hasCyl = !!cat.fields.sylintereidenLkm;
const v8 = hasCyl
  ? await timed('V8 / kunta', { query: { bool: { filter: [M1, { range: { sylintereidenLkm: { gte: 8 } } }] } }, size: 0, aggs: KUNTA })
  : await timed('isolohkoiset ≥5000 cm³ / kunta', { query: { bool: { filter: [M1, { range: { iskutilavuus: { gte: 5000 } } }] } }, size: 0, aggs: KUNTA });

// ---- 6. exotic brands -----------------------------------------------------
const GROUPS = {
  super:  ['Ferrari','FERRARI','Lamborghini','McLaren','Aston Martin','ASTON MARTIN','ASTON-MARTIN','Maserati','Bugatti','BUGATTI','DE TOMASO','De Tomaso'],
  luksus: ['Rolls-Royce','Rolls-Royce MFC','Bentley','Maybach'],
  porsche:['Porsche'],
};
const exotic = {};
for (const [g, brands] of Object.entries(GROUPS)) {
  const res = await timed(`${g} / kunta`, { query: { terms: { merkkiSelvakielinen: brands } }, size: 0, aggs: KUNTA });
  exotic[g] = { total: res.hits.total.value, brands: brands,
                kunta: Object.fromEntries(res.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count])),
                maakunta: rollup(res.aggregations.kunnat.buckets) };
}

// ---- 6b. brands by year ---------------------------------------------------
// Same shape as the colours query, but merkkiSelvakielinen holds 15 651 values
// against vari's 14. It is affordable only because the histogram's terms
// sub-aggregation counts id lists directly instead of materialising a bitmap
// per value.
const merkit = await timed('merkit \u00d7 vuosi', {
  query: M1, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1960, max: 2026,
          aggs: { merkki: { terms: { field: 'merkkiSelvakielinen', size: 40 } } } } } } });

// ---- 6c. Porsche models ---------------------------------------------------
// Fetching the 5 978 Porsches as documents costs 1 672 MB: each hit lands in its
// own 177 kB stored block, so a scattered result set pays a whole block per row.
// Two aggregations answer the same question for 77 MB.
// Cayenne and Macan are registered as M1G (off-road passenger car), not M1, so an
// M1-only filter put the Cayenne at 67 when it is really ~2 000. Porsche also has
// 167 tractors in the register, which is why the class breakdown is worth keeping.
const PORSCHE_ANY = { term: { merkkiSelvakielinen: 'Porsche' } };
const pLuokat = await timed('porsche / ajoneuvoluokka', {
  query: PORSCHE_ANY, size: 0,
  aggs: { lk: { terms: { field: 'ajoneuvoluokka', size: 20 } } } });
const PORSCHE = { bool: { filter: [PORSCHE_ANY, { terms: { ajoneuvoluokka: ['M1', 'M1G'] } }] } };
const pMallit = await timed('porsche-mallit', {
  query: PORSCHE, size: 0,
  aggs: { m: { terms: { field: 'kaupallinenNimi', size: 500, min_doc_count: 1 } } } });
const pVuodet = await timed('porsche-mallit \u00d7 vuosi', {
  query: PORSCHE, size: 0,
  aggs: { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1950, max: 2026,
          aggs: { m: { terms: { field: 'kaupallinenNimi', size: 20 } } } } } } });

// ---- 7. brand mileage, 2010 cohort ---------------------------------------
const cohort = { bool: { filter: [M1,
  { range: { kayttoonotto: { gte: 20100101, lt: 20110101 } } },
  { range: { matkamittarilukema: { gte: 10000, lte: 1000000 } } }] } };
const km = await timed('mittarilukema / merkki (kohortti 2010)', {
  query: cohort, size: 0,
  aggs: { merkit: { terms: { field: 'merkkiSelvakielinen', size: 4000, min_doc_count: 300 },
          aggs: { km: { stats: { field: 'matkamittarilukema' } } } } } });

// ---- write ----------------------------------------------------------------
const out = {
  meta: { artifact: ART.split('/').pop(), docCount: cat.docCount, version: cat.version,
          contentHash: cat.contentHash, built: new Date().toISOString(),
          sections: Object.keys(cat.sections).length,
          catalogBytes: JSON.stringify(cat).length,
          hasCylinders: hasCyl },
  costs,
  maakunnat: MK.maakunnat,
  kuntaToMaakunta: MK.kuntaToMaakunta,
  totals: { all: baseAll.hits.total.value, m1: baseM1.hits.total.value },
  totByKunta, m1ByKunta,
  m1ByMaakunta: rollup(baseM1.aggregations.kunnat.buckets),
  allByMaakunta: rollup(baseAll.aggregations.kunnat.buckets),
  countsByYear: counts.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count })),
  fuelByYear: (() => {
    const idx = res => Object.fromEntries(res.aggregations.v.buckets.map(
      b => [b.key, Object.fromEntries(b.lk.buckets.map(x => [x.key, x.doc_count]))]));
    const H = idx(hyb), HD = idx(hybDiesel);
    return fuel.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
      voima: Object.fromEntries(b.voima.buckets.map(x => [x.key, x.doc_count])),
      hyb: H[b.key] ?? {}, hybDiesel: HD[b.key] ?? {} }));
  })(),
  electricByYear: elec.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
    kunta: Object.fromEntries(b.kunnat.buckets.map(x => [x.key, x.doc_count])) })),
  m1ByYearKunta: m1ByYearKunta.aggregations.v.buckets.map(b => ({ year: b.key,
    kunta: Object.fromEntries(b.kunnat.buckets.map(x => [x.key, x.doc_count])) })),
  traits: traits.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
    massa: b.massa.value, kuutiot: b.kuutiot.value, teho: b.teho.value, co2: b.co2.value,
    syl: b.syl.value, istuimet: b.istuimet.value,
    kori: b.kori.buckets.map(x => ({ key: x.key, n: x.doc_count })) })),
  porsche: {
    total: pMallit.hits.total.value ?? pMallit.hits.total,
    luokat: Object.fromEntries(pLuokat.aggregations.lk.buckets.map(x => [x.key, x.doc_count])),
    kaikki: pLuokat.hits.total.value ?? pLuokat.hits.total,
    mallit: Object.fromEntries(pMallit.aggregations.m.buckets.map(x => [x.key, x.doc_count])),
    vuodet: pVuodet.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
      mallit: Object.fromEntries(b.m.buckets.map(x => [x.key, x.doc_count])) })),
  },
  merkkiByYear: merkit.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
    merkki: Object.fromEntries(b.merkki.buckets.map(x => [x.key, x.doc_count])) })),
  colours: colours.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
    vari: Object.fromEntries(b.vari.buckets.map(x => [x.key, x.doc_count])) })),
  v8: { total: v8.hits.total.value, byCylinders: hasCyl,
        kunta: Object.fromEntries(v8.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count])),
        maakunta: rollup(v8.aggregations.kunnat.buckets) },
  exotic,
  brandKm: km.aggregations.merkit.buckets.filter(b => b.km.count >= 300)
    .map(b => ({ merkki: b.key, n: b.km.count, avg: b.km.avg, min: b.km.min, max: b.km.max }))
    .sort((a, b) => b.avg - a.avg),
};
await writeFile(OUT, JSON.stringify(out));
await r.close();
const size = JSON.stringify(out).length;
console.log(`kirjoitettu ${OUT}  (${(size/1e6).toFixed(2)} MB)`);
console.log(`\nkyselykustannukset:`);
for (const c of costs)
  console.log(`  ${c.label.padEnd(38)} ${String(c.ms).padStart(6)} ms  ${c.rounds} kier  ${(c.bytes/1e6).toFixed(1).padStart(6)} MB`);
console.log(`  ${'YHTEENSÄ'.padEnd(38)} ${String(costs.reduce((a,c)=>a+c.ms,0)).padStart(6)} ms`);
