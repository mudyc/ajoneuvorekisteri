#!/usr/bin/env node
/**
 * Rebuild the vehicle artifact small enough for a host with a size cap.
 *
 * The 2.2 GB artifact spends 77 % of itself on stored documents held as raw
 * JSON — every field name repeated 5.3 million times. The page never reads a
 * stored field: every chart is a `size: 0` aggregation, answered from bitmaps
 * and sorted columns. So the rebuild keeps the index and drops the payload,
 * and indexes only the fields the queries actually name.
 *
 *   node tools/rebuild-compact.js <lähde.l0> <kohde.l0> [montako]
 */
import { Reader } from '../src/read/reader.js';
import { build } from '../src/build/builder.js';

// Tasan ne kentät joita viz/queries.js nimeää.
const KEEP = ['ajoneuvoluokka','kayttoonotto','kayttovoima','kunta','vari','korityyppi',
  'merkkiSelvakielinen','kaupallinenNimi','sahkohybridinluokka','omamassa','iskutilavuus',
  'suurinNettoteho','NEDC_Co2','istumapaikkojenLkm','sylintereidenLkm','matkamittarilukema'];
// Tallennetaan vain nämä. Artefakti on aggregaatiokäyttöön: yksittäistä
// ajoneuvoa ei voi hakea esiin, mutta sivu ei sitä tee.
const STORE = ['merkkiSelvakielinen','kayttoonotto'];

const [src, out, limitArg] = process.argv.slice(2);
if (!src || !out) { console.error('usage: rebuild-compact.js <src.l0> <out.l0> [n]'); process.exit(1); }
const limit = limitArg ? Number(limitArg) : Infinity;

const r = new Reader(src); await r.open();
// Tyypit luetaan lähteestä, ei arvata: 'kunta' on "740" ja menisi numeroksi,
// jolloin terms-aggregaatio ei toimisi.
const fieldTypes = Object.fromEntries(
  Object.entries(r.catalog.fields).filter(([f]) => KEEP.includes(f)).map(([f, m]) => [f, m.type]));
const total = Math.min(limit, (await r.search({ query: { match_all: {} }, size: 0 })).hits.total.value);
process.stdout.write(`luetaan ${total.toLocaleString('fi-FI')} dokumenttia…`);

const docs = [];
const PAGE = 250000;
for (let from = 0; from < total; from += PAGE) {
  const n = Math.min(PAGE, total - from);
  const res = await r.search({ query: { match_all: {} }, size: n, from });
  for (const h of res.hits.hits) {
    const d = {};
    for (const f of KEEP) { const v = h._source[f]; if (v !== undefined && v !== null) d[f] = v; }
    docs.push(d);
  }
  process.stdout.write(`\rluettu ${docs.length.toLocaleString('fi-FI')} / ${total.toLocaleString('fi-FI')}`);
}
// Aikajärjestys on luonteva klusterointi: uudet rekisteröinnit tulevat loppuun.
docs.sort((a, b) => (a.kayttoonotto ?? 0) - (b.kayttoonotto ?? 0));
console.log(`\nrakennetaan ${out}…`);
const t0 = Date.now();
await build({ docs, outPath: out, clusteringField: 'kayttoonotto',
              indexFields: KEEP, storedFields: STORE, fieldTypes,
              // kaupallinenNimi on kymmeniätuhansia eri arvoja; ilman nostoa se
              // putoaisi pois avainsanoista eikä terms-aggregaatio toimisi.
              keywordMaxCardinality: 200000 });
const { statSync } = await import('node:fs');
console.log(`valmis ${(statSync(out).size / 1e6).toFixed(0)} MB  ${((Date.now() - t0) / 1000).toFixed(0)} s`);
