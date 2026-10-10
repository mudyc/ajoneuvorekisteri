#!/usr/bin/env node
/**
 * Streaming ingest of Traficom's open vehicle register into L0 documents.
 *
 * Normalisation is the BUILDER's job, never the reader's (§12.7): dates become
 * sortable integers here, numbers are parsed here, codes stay as codes.
 */
import { createReadStream } from 'node:fs';
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';

// kunta -> maakunta, JHS classification key (Suomi.fi koodistot).
// Derived at build time: the mapping is deterministic, the derived form is a
// handful of DENSE bitmaps versus an OR over ~17 sparse ones, and rare
// phenomena only become readable on a map at this granularity.
const { kuntaToMaakunta, maakunnat } = JSON.parse(
  readFileSync(new URL('./maakunnat.json', import.meta.url), 'utf8'));

// sahkohybridinluokka is the ONLY thing separating a plug-in from a self-charging
// hybrid: kayttovoima calls both of them '01 Bensiini'. Codes 39/44
// ("Bensiini/Sähkö") look like they should carry it but hold 944 rows in the whole
// register. Verified against CO2: class 01 reports only in the weighted NEDC2/WLTP2
// columns at 29 g/km (OVC-HEV, externally chargeable), class 02 in the plain ones
// at 118 g/km (NOVC-HEV, self-charging).
const KEYWORDS = ['ajoneuvoluokka', 'kayttovoima', 'kunta', 'vari', 'korityyppi',
                  'vaihteisto', 'ajoneuvonkaytto', 'sahkohybridinluokka'];
const BOOLS    = ['ahdin', 'sahkohybridi'];
const NUMBERS  = ['omamassa', 'iskutilavuus', 'suurinNettoteho', 'NEDC_Co2',
                  'matkamittarilukema', 'istumapaikkojenLkm', 'sylintereidenLkm'];
const TEXT     = ['merkkiSelvakielinen', 'kaupallinenNimi'];

/** YYYYMMDD with unknown parts as 0 → a sortable integer, or null. */
function normDate(v) {
  if (!v || v === '00000000') return null;
  const s = v.trim();
  if (!/^\d{8}$/.test(s)) return null;
  const y = +s.slice(0, 4);
  if (y < 1890 || y > 2030) return null;
  const m = +s.slice(4, 6) || 1;
  const d = +s.slice(6, 8) || 1;
  return y * 10000 + m * 100 + d;          // sortable; partial dates sort to month/year start
}

function normNum(v) {
  if (!v) return null;
  const n = Number(String(v).trim().replace(',', '.'));
  return Number.isFinite(n) ? n : null;
}

export async function* readVehicles(path, { limit = Infinity } = {}) {
  const rl = createInterface({
    input: createReadStream(path, { encoding: 'latin1' }),
    crlfDelay: Infinity,
  });
  let header = null, i = 0, emitted = 0;
  for await (const line of rl) {
    if (header === null) { header = line.replace(/^﻿/, '').split(';'); continue; }
    if (!line) continue;
    const f = line.split(';');
    const get = name => f[header.indexOf(name)];
    const kayttoonotto = normDate(get('kayttoonottopvm'));
    i++;
    if (kayttoonotto === null) continue;              // clustering key must exist
    const doc = { id: String(i), kayttoonotto };
    for (const k of KEYWORDS) { const v = (get(k) || '').trim(); if (v) doc[k] = v; }
    for (const k of BOOLS)    { const v = (get(k) || '').trim(); if (v === 'true' || v === 'false') doc[k] = v === 'true'; }
    for (const k of NUMBERS)  { const v = normNum(get(k)); if (v !== null) doc[k] = v; }
    for (const k of TEXT)     { const v = (get(k) || '').trim(); if (v) doc[k] = v; }

    // Derived: power-to-weight in kW per tonne. A ratio of two columns is NOT
    // decomposable — avg(a/b) != avg(a)/avg(b) — so it cannot be assembled from
    // per-bucket sums of the two columns. It has to become a column of its own,
    // and the builder is where that happens (§12.7).
    if (doc.kunta && kuntaToMaakunta[doc.kunta]) {
      doc.maakunta = kuntaToMaakunta[doc.kunta];
    }
    if (doc.suurinNettoteho > 0 && doc.omamassa > 0) {
      doc.tehoPainoSuhde = Math.round(doc.suurinNettoteho * 1000 / doc.omamassa * 10) / 10;
    }
    yield doc;
    if (++emitted >= limit) break;
  }
  rl.close();
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  const limit = Number(process.argv[3] ?? 1e6);
  let n = 0; const t0 = Date.now();
  const cov = {};
  for await (const d of readVehicles(path, { limit })) {
    n++;
    for (const k of Object.keys(d)) cov[k] = (cov[k] ?? 0) + 1;
    if (n % 500000 === 0) console.log(`  ${n.toLocaleString()} … ${((Date.now()-t0)/1000).toFixed(1)}s`);
  }
  console.log(`\n${n.toLocaleString()} documents in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  console.log('coverage:');
  for (const [k, c] of Object.entries(cov).sort((a,b)=>b[1]-a[1]))
    console.log(`  ${k.padEnd(22)} ${(c/n*100).toFixed(1)}%`);
}
