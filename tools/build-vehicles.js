#!/usr/bin/env node
import { build } from '../src/build/builder.js';
import { readVehicles } from './ingest-vehicles.js';

const csv = process.argv[2];
const limit = Number(process.argv[3] ?? 1e6);
const out = process.argv[4] ?? 'data/vehicles.l0';

console.log(`ingesting up to ${limit.toLocaleString()} rows…`);
let t = Date.now();
const docs = [];
for await (const d of readVehicles(csv, { limit })) docs.push(d);
console.log(`  ${docs.length.toLocaleString()} docs in ${((Date.now()-t)/1000).toFixed(1)}s`);

console.log('building…');
t = Date.now();
const { catalog, bytes } = await build({
  docs, index: 'vehicles', clusteringField: 'kayttoonotto',
  blockSize: 512, granule: 8192, outPath: out, keywordMaxCardinality: 200000,
});
console.log(`  built in ${((Date.now()-t)/1000).toFixed(1)}s\n`);

const sec = Object.entries(catalog.sections);
const by = {};
for (const [name, s] of sec) {
  const kind = name.split(':')[0];
  by[kind] = (by[kind] ?? 0) + s.length;
}
const stored = catalog.stored.blocks.reduce((a, b) => a + b.length, 0);
console.log(`documents   ${catalog.docCount.toLocaleString()}`);
console.log(`artifact    ${(bytes/1e6).toFixed(1)} MB  (${(bytes/catalog.docCount).toFixed(1)} B/doc)`);
console.log(`sections    ${sec.length}`);
for (const [k, v] of Object.entries(by).sort((a,b)=>b[1]-a[1]))
  console.log(`  ${k.padEnd(6)} ${(v/1e6).toFixed(1)} MB  ${(v/bytes*100).toFixed(1)}%`);
console.log(`  stored ${(stored/1e6).toFixed(1)} MB  ${(stored/bytes*100).toFixed(1)}%`);
const catBytes = bytes - stored - Object.values(catalog.sections).reduce((a,s)=>a+s.length,0);
console.log(`  catalog ${(catBytes/1e6).toFixed(2)} MB`);
console.log(`\nfields:`);
for (const [f, m] of Object.entries(catalog.fields)) {
  const extra = m.type === 'keyword' ? `${m.stats.cardinality} values`
              : m.type === 'text' ? `${m.stats.distinctTrigrams} trigrams`
              : m.type === 'numeric' ? `${m.count.toLocaleString()} values` : '';
  console.log(`  ${f.padEnd(22)} ${m.type.padEnd(8)} ${extra}`);
}
