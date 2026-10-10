# ajoneuvorekisteri

Traficomin avoin ajoneuvorekisteri L0-indeksiksi, ja selainsivu joka kysyy sitä
suoraan HTTP Range -pyynnöillä ilman palvelinta.

5 288 425 ajoneuvoa yhdessä artefaktissa. Jokainen kuvaaja on yksi tai muutama
aggregaatiokysely, ja sivu näyttää mitä kukin maksoi.

## Yksi kuvaaja kerrallaan

Sivu **ei** lataa esilaskettuja tuloksia. Luvut lasketaan artefaktista silloin
kun kuvaaja valitaan, ja siksi kuvaajia näytetään yksi kerrallaan: kaikkien
kyselyjen ajaminen yhdellä sivunlatauksella maksoi mitattuna **540 MB ja 3,2 s**.

Valitsin on sivun yläreunassa. **Seuraava**-nappi siirtyy järjestyksessä
eteenpäin, nuolinäppäimet ja `n` toimivat myös. Valinta tallentuu osoitteeseen
(`?chart=s-fuel`), joten yksittäiseen kuvaajaan voi linkittää.

Jo haetut avaimet jäävät muistiin: moni kuvaaja jakaa saman pohjakyselyn, joten
toinen katselukerta näyttää `muistista · 0 kyselyä`.

## Käyttö

```sh
npm test                          # L0:n testit, 93 kpl
node tools/ingest-vehicles.js     # lähdedata -> data/vehicles-v5.l0
python3 pyserve.py . 8300         # <juuri> <portti>, Range-kelpoinen
# http://localhost:8300/viz/index.html
```

Tavallinen `python3 -m http.server` **ei kelpaa**: se vastaa Range-pyyntöön
200:lla, ja lukija hylkää sellaisen vastauksen tarkoituksella.

Artefaktin voi valita osoitteesta: `?art=vehicles.l0`.

## Hakemistot

| | |
| --- | --- |
| `viz/` | sivu, kyselyt (`queries.js`) ja staattiset kuntarajat |
| `tools/` | ingest, artefaktin rakennus ja pilkkominen |
| `src/` | L0:n ydin — **kopio** L0-projektista, ei MML- tai Traficom-kohtainen |
| `test/` | L0:n testit |
| `data/` | artefaktit, **ei versionhallinnassa** |

## Mitattua

Alueiden yhdistäminen kuljetuksessa oli tämän työn tärkein korjaus. Suuren
kardinaliteetin `terms`-aggregaatio pyytää kymmeniätuhansia pieniä tavualueita
— yhdessä kyselyssä mitattuna **96 521 kappaletta**. Levyltä se on 0,5 s, mutta
HTTP:n yli jokainen on oma pyyntönsä.

| kuvaaja | ennen | jälkeen |
| --- | --- | --- |
| Porschet Suomessa | 56 680 ms, 215,8 MB | **10 ms, 114,0 MB** |
| Merkkien kärkisijat | 7 847 ms | **10 ms** |
| Mittarilukema merkeittäin | 7 736 ms | **10 ms** |

`HttpTransport` yhdistää nyt alle 64 kB:n päässä toisistaan olevat alueet
yhdeksi pyynnöksi ja leikkaa palaset takaisin. Tavuja kuluu vähemmän eikä
enemmän, koska päällekkäiset pikkuluvut sulautuvat.

## GitHub Pages

Artefakti rakennetaan julkaisua varten uusiksi: **2 371 MB -> 581 MB**.

```sh
node tools/rebuild-compact.js lahde.l0 data/vehicles-web.l0
node tools/split-artifact.js data/vehicles-web.l0 45    # -> 13 osaa a 45 MiB
git add -f data/vehicles-web.l0.0?? data/vehicles-web.l0.json
```

Mistä säästö tulee:

| | | |
| --- | --- | --- |
| tallennuslohkot olivat raakaa JSONia | 1 832 MB | -> 100 MB |
| 6 kenttää joita mikään kysely ei nimeä | | pois |
| väärin arvatut tyypit (`kunta` = "740") | | tyypit luetaan lähteestä |

Tallennetut kentät karsittiin kahteen, koska **sivu ei lue niitä koskaan**:
jokainen kuvaaja on `size: 0` -aggregaatio, joka vastataan bittikartoista ja
lajitelluista sarakkeista. Artefakti on siis aggregaatiokäyttöön — yksittäistä
ajoneuvoa ei voi hakea esiin.

**Koko ratkesi, kaista ei.** Kyselyt lukevat samoja sarakkeita kuin ennenkin,
joten yksittäisen kuvaajan hinta ei muuttunut lainkaan: `s-traits` on edelleen
318 MB, koska kuusi keskiarvoa lukee kahdeksan numeerisen sarakkeen läpi.
Pagesin kaistaraja on 100 GB/kk, eli noin 300 raskainta kuvaajalatausta
kuukaudessa. Sarakkeiden delta+varint-koodaus antaisi mitattuna 8x, mutta se on
muutos rakentajaan ja lukijaan.

## Lisenssit

| | |
| --- | --- |
| koodi (`viz/`, `tools/`, `src/`, `test/`) | MIT — [`LICENSE`](LICENSE) |
| ajoneuvoaineisto (`data/`) | CC BY 4.0 — [`data/LICENSE`](data/LICENSE) |
| väestötiedot (`viz/data/vaesto2025.json`) | CC BY 4.0 — [Tilastokeskus, StatFin 11ra](https://pxdata.stat.fi/PxWeb/pxweb/fi/StatFin/StatFin__vaerak/statfin_vaerak_pxt_11ra.px/) |

**Sisältää Traficomin ajoneuvojen avointa dataa, poiminta 30.6.2026.**
