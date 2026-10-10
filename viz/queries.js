/**
 * Every visualisation query, one builder per data key.
 *
 * The page used to fetch a precomputed aggregates.json. Now each chart asks for
 * the keys it needs and those queries run against the artifact in the browser,
 * so the numbers on screen are the ones the index just produced. Builders are
 * memoised and may depend on each other; a chart that needs three keys still
 * pays for each underlying query once per session.
 *
 * Costs are recorded per query so the page can show what the index charged.
 */
/**
 * EU:n ajoneuvoluokat ryhmiteltyinä niin kuin ihminen ne nimeää. Koodit ovat
 * aineiston omia: M = henkilöliikenne, N = tavara, O = perävaunu, L = kaksi- ja
 * kolmipyöräiset, T ja C = traktorit, G-pääte = maastoversio. MUU-luokka
 * (418 087 ajoneuvoa) jätetään ryhmittelyn ulkopuolelle, koska se ei kerro
 * mitään; se näkyy vain "kaikki ajoneuvot" -valinnassa.
 */
export const LUOKAT = {
  kaikki:        { nimi: 'kaikki ajoneuvot',    codes: null },
  henkiloauto:   { nimi: 'henkilöautot',        codes: ['M1', 'M1G'] },
  peravaunu:     { nimi: 'perävaunut',          codes: ['O1', 'O2', 'O3', 'O4'] },
  pakettiauto:   { nimi: 'pakettiautot',        codes: ['N1', 'N1G'] },
  traktori:      { nimi: 'traktorit',           codes: ['T', 'T1', 'T2', 'T3', 'T4', 'T5',
                                                        'C1', 'C2', 'C3', 'C4', 'C5', 'LTR'] },
  moottoripyora: { nimi: 'moottoripyörät',      codes: ['L3', 'L3e', 'L4', 'L4e', 'L5', 'L5e', 'L7e'] },
  mopo:          { nimi: 'mopot',               codes: ['L1', 'L1e', 'L2', 'L2e', 'L6e'] },
  kuormaauto:    { nimi: 'kuorma-autot',        codes: ['N2', 'N2G', 'N3', 'N3G'] },
  matkailuauto:  { nimi: 'matkailuautot',       codes: ['MA'] },
  tyokone:       { nimi: 'moottorityökoneet',   codes: ['MTK'] },
  linjaauto:     { nimi: 'linja-autot',         codes: ['M2', 'M3'] },
};

/**
 * Merkit joilla on tarpeeksi volyymia kestomatriisiin. Luettelo on kiinteä,
 * koska vaihtoehto olisi enumeroida kentän 15 651 arvoa.
 */
export const KESTO_KYNNYKSET = [100000, 200000, 300000];

export const KESTO_MERKIT = ['Volvo', 'Mercedes-Benz', 'BMW', 'Skoda', 'Audi', 'Subaru', 'Saab',
  'Volkswagen', 'Honda', 'Seat', 'Mitsubishi', 'Toyota', 'Ford', 'Lexus', 'Opel', 'Citroen',
  'Mazda', 'Kia', 'Peugeot', 'Nissan', 'Hyundai', 'Renault', 'Suzuki', 'Fiat'];

export function makeQueries(reader, MK) {
  const cache = new Map();          // key -> Promise
  const costs = [];
  const cat = reader.catalog;
  const M1 = { term: { ajoneuvoluokka: 'M1' } };
  const KUNTA = { kunnat: { terms: { field: 'kunta', size: 400, min_doc_count: 1 } } };
  const hasCyl = !!cat.fields.sylintereidenLkm;

  /**
   * Aika jakautuu kahtia. `io` on se osa jota odotetaan verkolta, `cpu` kaikki
   * muu: bittikartta-algebra, popcount, ämpäröinti, tulosten purku. Indeksin
   * koko väite on että jälkimmäinen on pieni, ja sen näkee vain mittaamalla.
   */
  // Tilastot ovat kuljetuskohtaisia, joten kaksi rinnakkaista kyselyä kirjaisi
  // toistensa tavut ja odotusajan. Mittaukset ajetaan siksi peräkkäin; rinnakkaisuus
  // yhden kyselyn SISÄLLÄ on se joka merkitsee, ei kyselyiden välillä.
  let gate = Promise.resolve();
  async function timed(label, body) {
    const mine = gate.then(() => run(label, body));
    gate = mine.catch(() => {});
    return mine;
  }
  async function run(label, body) {
    reader.resetStats();
    const t0 = performance.now();
    const res = await reader.search(body);
    const s = reader.transport.stats;
    // Ei pyöristetä kokonaisluvuiksi: selaimen kello on karkea, ja pyöristys
    // näyttäisi alle millisekunnin laskennan nollana eli ilmaisena.
    const ms = performance.now() - t0;
    const io = Math.min(ms, s.fetchMs ?? 0);
    costs.push({ label, ms, io, cpu: Math.max(0, ms - io), rounds: s.rounds,
                 reads: s.reads, bytes: s.bytes, query: body });
    return res;
  }
  const rollup = buckets => {
    const m = {};
    for (const b of buckets) { const k = MK.kuntaToMaakunta[b.key]; if (k) m[k] = (m[k] ?? 0) + b.doc_count; }
    return m;
  };
  const byYear = (res, sub, name) => res.aggregations.v.buckets.map(b => ({
    year: b.key, n: b.doc_count,
    [name]: Object.fromEntries(b[sub].buckets.map(x => [x.key, x.doc_count])) }));
  const HIST = (min, max, aggs) => ({ v: { histogram: { field: 'kayttoonotto', interval: 'year', min, max, ...(aggs ? { aggs } : {}) } } });

  const B = {
    // ---- baselines, shared by the maps ------------------------------------
    async _baseAll() { return timed('kaikki ajoneuvot / kunta', { query: { match_all: {} }, size: 0, aggs: KUNTA }); },
    async _baseM1()  { return timed('M1 / kunta', { query: M1, size: 0, aggs: KUNTA }); },

    async totals() {
      const [a, m] = await Promise.all([get('_baseAll'), get('_baseM1')]);
      return { all: a.hits.total.value, m1: m.hits.total.value };
    },
    async totByKunta() {
      const a = await get('_baseAll');
      return Object.fromEntries(a.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count]));
    },
    async m1ByKunta() {
      const m = await get('_baseM1');
      return Object.fromEntries(m.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count]));
    },
    async allByMaakunta() { return rollup((await get('_baseAll')).aggregations.kunnat.buckets); },
    async m1ByMaakunta()  { return rollup((await get('_baseM1')).aggregations.kunnat.buckets); },

    // ---- 0. survivors per model year --------------------------------------
    async countsByYear() {
      const res = await timed('M1 × käyttöönottovuosi', { query: M1, size: 0, aggs: HIST(1945, 2026) });
      return res.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count }));
    },

    // ---- 1. fuel by year ---------------------------------------------------
    // Hybrids hide inside '01 Bensiini'; sahkohybridinluokka separates them, and
    // a diesel-restricted copy lets the petrol split fall out by subtraction.
    async fuelByYear() {
      const HYB = size => ({ lk: { terms: { field: 'sahkohybridinluokka', size } } });
      const [fuel, hyb, hybD] = await Promise.all([
        timed('käyttövoima × vuosi', { query: M1, size: 0,
          aggs: HIST(1960, 2026, { voima: { terms: { field: 'kayttovoima', size: 8 } } }) }),
        timed('hybridiluokka × vuosi', { query: M1, size: 0, aggs: HIST(1960, 2026, HYB(6)) }),
        timed('hybridiluokka × vuosi (diesel)',
          { query: { bool: { filter: [M1, { term: { kayttovoima: '02' } }] } }, size: 0,
            aggs: HIST(1960, 2026, HYB(6)) }),
      ]);
      const idx = res => Object.fromEntries(res.aggregations.v.buckets.map(
        b => [b.key, Object.fromEntries(b.lk.buckets.map(x => [x.key, x.doc_count]))]));
      const H = idx(hyb), HD = idx(hybD);
      return fuel.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
        voima: Object.fromEntries(b.voima.buckets.map(x => [x.key, x.doc_count])),
        hyb: H[b.key] ?? {}, hybDiesel: HD[b.key] ?? {} }));
    },

    // ---- 2. electrification -------------------------------------------------
    async electricByYear() {
      const res = await timed('sähköautot × vuosi × kunta',
        { query: { bool: { filter: [M1, { term: { kayttovoima: '04' } }] } }, size: 0,
          aggs: HIST(2015, 2026, { kunnat: { terms: { field: 'kunta', size: 400 } } }) });
      return byYear(res, 'kunnat', 'kunta');
    },
    async m1ByYearKunta() {
      const res = await timed('M1 × vuosi × kunta (nimittäjä)', { query: M1, size: 0,
        aggs: HIST(2015, 2026, { kunnat: { terms: { field: 'kunta', size: 400 } } }) });
      return res.aggregations.v.buckets.map(b => ({ year: b.key,
        kunta: Object.fromEntries(b.kunnat.buckets.map(x => [x.key, x.doc_count])) }));
    },

    // ---- 3. traits ----------------------------------------------------------
    async traits() {
      const res = await timed('massa/kuutiot/CO₂/teho × vuosi', { query: M1, size: 0,
        aggs: HIST(1950, 2026, {
          massa: { avg: { field: 'omamassa' } }, kuutiot: { avg: { field: 'iskutilavuus' } },
          teho: { avg: { field: 'suurinNettoteho' } }, co2: { avg: { field: 'NEDC_Co2' } },
          syl: { avg: { field: hasCyl ? 'sylintereidenLkm' : 'iskutilavuus' } },
          istuimet: { avg: { field: 'istumapaikkojenLkm' } },
          kori: { terms: { field: 'korityyppi', size: 12 } } }) });
      return res.aggregations.v.buckets.map(b => ({ year: b.key, n: b.doc_count,
        massa: b.massa.value, kuutiot: b.kuutiot.value, teho: b.teho.value, co2: b.co2.value,
        syl: b.syl.value, istuimet: b.istuimet.value,
        kori: b.kori.buckets.map(x => ({ key: x.key, n: x.doc_count })) }));
    },

    // ---- 4. colours ---------------------------------------------------------
    async colours() {
      const res = await timed('värit × vuosi', { query: M1, size: 0,
        aggs: HIST(1960, 2026, { vari: { terms: { field: 'vari', size: 14 } } }) });
      return byYear(res, 'vari', 'vari');
    },

    // ---- 4b. brand ranks ----------------------------------------------------
    async merkkiByYear() {
      const res = await timed('merkit × vuosi', { query: M1, size: 0,
        aggs: HIST(1960, 2026, { merkki: { terms: { field: 'merkkiSelvakielinen', size: 40 } } }) });
      return byYear(res, 'merkki', 'merkki');
    },

    // ---- 4c. Porsche --------------------------------------------------------
    async porsche() {
      const ANY = { term: { merkkiSelvakielinen: 'Porsche' } };
      const P = { bool: { filter: [ANY, { terms: { ajoneuvoluokka: ['M1', 'M1G'] } }] } };
      const [lk, mallit, vuodet] = await Promise.all([
        timed('porsche / ajoneuvoluokka', { query: ANY, size: 0,
          aggs: { lk: { terms: { field: 'ajoneuvoluokka', size: 20 } } } }),
        timed('porsche-mallit', { query: P, size: 0,
          aggs: { m: { terms: { field: 'kaupallinenNimi', size: 500, min_doc_count: 1 } } } }),
        timed('porsche-mallit × vuosi', { query: P, size: 0,
          aggs: HIST(1950, 2026, { m: { terms: { field: 'kaupallinenNimi', size: 20 } } }) }),
      ]);
      return {
        total: mallit.hits.total.value, kaikki: lk.hits.total.value,
        luokat: Object.fromEntries(lk.aggregations.lk.buckets.map(x => [x.key, x.doc_count])),
        mallit: Object.fromEntries(mallit.aggregations.m.buckets.map(x => [x.key, x.doc_count])),
        vuodet: byYear(vuodet, 'm', 'mallit'),
      };
    },

    // ---- 5. V8 / big engines -------------------------------------------------
    async v8() {
      const q = hasCyl
        ? { bool: { filter: [M1, { range: { sylintereidenLkm: { gte: 8 } } }] } }
        : { bool: { filter: [M1, { range: { iskutilavuus: { gte: 5000 } } }] } };
      const res = await timed(hasCyl ? 'V8 / kunta' : 'isolohkoiset ≥5000 cm³ / kunta',
        { query: q, size: 0, aggs: KUNTA });
      return { total: res.hits.total.value, byCylinders: hasCyl,
        kunta: Object.fromEntries(res.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count])),
        maakunta: rollup(res.aggregations.kunnat.buckets) };
    },

    // ---- 6. exotic brands ----------------------------------------------------
    async exotic() {
      const GROUPS = {
        super:  ['Ferrari','FERRARI','Lamborghini','McLaren','Aston Martin','ASTON MARTIN','ASTON-MARTIN','Maserati','Bugatti','BUGATTI','DE TOMASO','De Tomaso'],
        luksus: ['Rolls-Royce','Rolls-Royce MFC','Bentley','Maybach'],
        porsche:['Porsche'],
      };
      const out = {};
      for (const [g, brands] of Object.entries(GROUPS)) {
        const res = await timed(`${g} / kunta`,
          { query: { terms: { merkkiSelvakielinen: brands } }, size: 0, aggs: KUNTA });
        out[g] = { total: res.hits.total.value, brands,
          kunta: Object.fromEntries(res.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count])),
          maakunta: rollup(res.aggregations.kunnat.buckets) };
      }
      return out;
    },

    // ---- 7. brand mileage ----------------------------------------------------
    /**
     * Mittarilukemamatriisi merkki x kohorttivuosi.
     *
     * Kysely merkkiä kohti, ei yhtä terms-alaämpäriä kaikista. Alaämpäri olisi
     * ollut kaksi kyselyä, mutta se suunnittelee yhden tavualueen jokaiselle
     * kentän arvolle — merkkejä on 15 651, eli 15 675 aluetta ja 103 MB. Nimetyt
     * merkit maksavat 44 aluetta ja 93 MB. Sama luku, eri muoto.
     *
     * Nimittäjä on oma avaimensa, joten kynnyksen vaihto maksaa vain osoittajan.
     */
    async kestoDenom() { return kestoRows({ gte: 10000, lte: 1000000 }, 'kohortti / merkki, mittarilukema luettu'); },

    async brandKm() {
      // kayttoonotto is numeric YYYYMMDD, not an ISO string. The mileage window
      // drops unread and rolled-over odometers, which otherwise dominate the mean.
      const cohort = { bool: { filter: [M1,
        { range: { kayttoonotto: { gte: 20100101, lt: 20110101 } } },
        { range: { matkamittarilukema: { gte: 10000, lte: 1000000 } } }] } };
      const res = await timed('mittarilukema / merkki (kohortti 2010)', { query: cohort, size: 0,
        aggs: { merkit: { terms: { field: 'merkkiSelvakielinen', size: 4000, min_doc_count: 300 },
                aggs: { km: { stats: { field: 'matkamittarilukema' } } } } } });
      return res.aggregations.merkit.buckets.filter(b => b.km.count >= 300)
        .map(b => ({ merkki: b.key, n: b.km.count, avg: b.km.avg, min: b.km.min, max: b.km.max }))
        .sort((a, b) => b.avg - a.avg);
    },
  };

  /** Yksi histogram-kysely merkkiä kohti; { merkki: { vuosi: n } }. */
  async function kestoRows(rng, label) {
    const hist = { v: { histogram: { field: 'kayttoonotto', interval: 'year', min: 1990, max: 2026 } } };
    const out = {};
    for (const m of KESTO_MERKIT) {
      const res = await timed(label, { query: { bool: { filter: [M1,
          { term: { merkkiSelvakielinen: m } },
          { range: { matkamittarilukema: rng } }] } }, size: 0, aggs: hist });
      out[m] = Object.fromEntries(res.aggregations.v.buckets.map(b => [b.key, b.doc_count]));
    }
    return out;
  }

  // Yksi rakentaja kynnystä kohti.

  // Yksi rakentaja luokkaryhmää kohti. Jokainen on yksi terms-kysely: OR luokan
  // bittikartoista, ämpärit kunnittain, yksi kierros. Vasta valittu ryhmä ajetaan.
  for (const [g, def] of Object.entries(LUOKAT)) {
    if (!def.codes) continue;                       // kaikki = totByKunta
    B['kunta_' + g] = async () => {
      const res = await timed(def.nimi + ' / kunta',
        { query: { terms: { ajoneuvoluokka: def.codes } }, size: 0, aggs: KUNTA });
      return Object.fromEntries(res.aggregations.kunnat.buckets.map(b => [b.key, b.doc_count]));
    };
  }

  for (const t of KESTO_KYNNYKSET) {
    B['kestoYli' + t] = async () =>
      kestoRows({ gte: t, lte: 1000000 }, `kohortti / merkki, yli ${t / 1000} 000 km`);
  }

  function get(key) {
    if (!cache.has(key)) cache.set(key, B[key]());
    return cache.get(key);
  }

  return {
    costs,
    meta: { docCount: cat.docCount, version: cat.version, contentHash: cat.contentHash,
            sections: Object.keys(cat.sections).length,
            catalogBytes: JSON.stringify(cat).length, hasCylinders: hasCyl },
    has: key => key in B,
    /** Fill `target[key]` for every requested key, running only what is missing. */
    async load(target, keys) {
      await Promise.all(keys.map(async k => { target[k] = await get(k); }));
      return target;
    },
  };
}
