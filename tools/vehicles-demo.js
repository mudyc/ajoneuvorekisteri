#!/usr/bin/env node
import { Reader } from '../src/read/reader.js';
import { LatencyTransport } from '../src/transport/latency.js';

const LAT = Number(process.argv[2] ?? 30), BW = 100;
const path = new URL('../data/vehicles-full.l0', import.meta.url).pathname;
const reader = await new Reader(new LatencyTransport(path, { latencyMs: LAT, bandwidthMBs: BW })).open();
const cat = reader.catalog;
console.log(`\n${cat.docCount.toLocaleString()} ajoneuvoa · katalogi residentti · ${LAT} ms/kierros, ${BW} MB/s\n`);

const D = (y, m = 1, d = 1) => y * 10000 + m * 100 + d;
const queries = {
  'kaikki':                        { match_all: {} },
  'Helsinki (091)':                { term: { kunta: '091' } },
  'diesel (02)':                   { term: { kayttovoima: '02' } },
  'henkilöautot M1':               { term: { ajoneuvoluokka: 'M1' } },
  'käyttöönotto 2015–2020':        { range: { kayttoonotto: { gte: D(2015), lt: D(2021) } } },
  'omamassa > 3500 kg':            { range: { omamassa: { gt: 3500 } } },
  'CO₂ alle 100 g/km':             { range: { NEDC_Co2: { gt: 0, lt: 100 } } },
  'Toyota':                        { term: { merkkiSelvakielinen: 'Toyota' } },
  'merkki alkaa "Volk"':           { prefix: { merkkiSelvakielinen: 'Volk' } },
  'ahdin + hybridi':               { bool: { filter: [{ term: { ahdin: true } }, { term: { sahkohybridi: true } }] } },
  'M1 diesel Helsingissä 2015–20': { bool: { filter: [
      { term: { ajoneuvoluokka: 'M1' } }, { term: { kayttovoima: '02' } },
      { term: { kunta: '091' } }, { range: { kayttoonotto: { gte: D(2015), lt: D(2021) } } } ] } },
  'sama + ei hybridi + CO₂<150':   { bool: {
      filter: [{ term: { ajoneuvoluokka: 'M1' } }, { term: { kayttovoima: '02' } },
               { term: { kunta: '091' } }, { range: { kayttoonotto: { gte: D(2010), lt: D(2021) } } },
               { range: { NEDC_Co2: { gt: 0, lt: 150 } } }],
      must_not: [{ term: { sahkohybridi: true } }] } },
};

console.log('kysely                             osumia  kier  luku     tavua    aika');
console.log('─'.repeat(78));
for (const [label, query] of Object.entries(queries)) {
  reader.resetStats();
  const t0 = Date.now();
  const r = await reader.search({ query, size: 20, sort: [{ kayttoonotto: 'desc' }] });
  const ms = Date.now() - t0, s = reader.stats;
  console.log(`${label.padEnd(33)} ${r.hits.total.value.toLocaleString().padStart(9)} ` +
    `${String(s.rounds).padStart(5)} ${String(s.reads).padStart(5)} ${(s.bytes/1024).toFixed(0).padStart(8)} kB ${(ms+' ms').padStart(7)}`);
}

console.log('\nsyvä sivutus (M1 diesel Helsinki), 20/sivu:');
const q = { bool: { filter: [{ term: { ajoneuvoluokka: 'M1' } }, { term: { kayttovoima: '02' } }, { term: { kunta: '091' } }] } };
let cursor, page = 0;
for (;;) {
  reader.resetStats();
  const t0 = Date.now();
  const r = await reader.search({ query: q, size: 20, ...(cursor ? { search_after: cursor } : {}) });
  const ms = Date.now() - t0;
  if (r.hits.hits.length === 0) break;
  page++;
  if (page <= 2 || page % 50 === 0) console.log(`  sivu ${String(page).padStart(4)}  ${ms} ms  kier=${reader.stats.rounds}  ${(reader.stats.bytes/1024).toFixed(0)} kB`);
  cursor = r.hits.hits.at(-1).sort;
  if (page >= 200) { console.log('  …katkaistu 200 sivuun'); break; }
}
console.log(`\nesimerkkiosuma:`);
const one = await reader.search({ query: queries['M1 diesel Helsingissä 2015–20'], size: 1, sort: [{ kayttoonotto: 'desc' }] });
console.log(' ', one.hits.hits[0] ? JSON.stringify(one.hits.hits[0]._source) : '(ei osumia)');
await reader.close();
