/**
 * HTTP Range transport over an artifact split into parts.
 *
 * Hosts that cap file size (GitHub blocks over 100 MiB) cannot hold a large
 * artifact whole. The split is a plain byte split; this transport maps a global
 * byte range onto the parts that cover it and concatenates the pieces, so the
 * reader sees one continuous file and nothing in the format changes.
 *
 * A range that straddles a part boundary becomes two requests, but they are
 * independent and issued together — the cost model counts DEPENDENT round trips,
 * so a wave is still one round however many parts it touches.
 */
export class ChunkedHttpTransport {
  constructor(manifestUrl, { maxParallel = 24 } = {}) {
    this.manifestUrl = manifestUrl;
    this.maxParallel = maxParallel;
    this.size = null;
    this.reset();
  }

  reset() { this.stats = { rounds: 0, reads: 0, bytes: 0 }; }

  async open() {
    if (this.size !== null) return this;
    const r = await fetch(this.manifestUrl);
    if (!r.ok) throw new Error(`${this.manifestUrl}: HTTP ${r.status}`);
    const m = await r.json();
    if (m.format !== 'l0-split-1') throw new Error(`${this.manifestUrl}: unknown format ${m.format}`);
    this.size = m.size; this.part = m.part; this.parts = m.parts;
    this.base = new URL(m.name, this.manifestUrl).href;
    return this;
  }

  async close() {}
  async sizeOf() { return this.size; }

  async readTail(length) {
    if (this.size === null) await this.open();
    const offset = Math.max(0, this.size - length);
    return this.readRange(offset, Math.min(length, this.size));
  }

  async readRange(offset, length) {
    const [b] = await this._raw([{ offset, length }]);
    this.stats.rounds += 1;
    return b;
  }

  async readWave(ranges) {
    if (ranges.length === 0) return [];
    const bufs = await this._raw(ranges);
    this.stats.rounds += 1;
    return bufs;
  }

  _url(i) { return `${this.base}.${String(i).padStart(3, '0')}`; }

  async _raw(ranges) {
    // Cut every logical range at the part boundaries it crosses.
    const jobs = [];
    ranges.forEach(({ offset, length }, i) => {
      let at = offset, left = length, seq = 0;
      while (left > 0) {
        const p = Math.floor(at / this.part);
        const within = at - p * this.part;
        const take = Math.min(left, this.part - within);
        jobs.push({ i, seq: seq++, p, within, take });
        at += take; left -= take;
      }
    });

    const got = new Array(jobs.length);
    let next = 0;
    const worker = async () => {
      while (next < jobs.length) {
        const k = next++;
        const { p, within, take } = jobs[k];
        const res = await fetch(this._url(p), {
          headers: { Range: `bytes=${within}-${within + take - 1}` },
        });
        if (res.status === 200) {
          throw new Error(
            `${this._url(p)}: server ignored Range and sent the whole part ` +
            `(HTTP 200). This host cannot serve the artifact.`);
        }
        if (res.status !== 206) throw new Error(`part ${p} ${within}+${take}: HTTP ${res.status}`);
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length !== take) throw new Error(`part ${p} ${within}+${take}: got ${buf.length}`);
        this.stats.reads += 1;
        this.stats.bytes += buf.length;
        got[k] = buf;
      }
    };
    await Promise.all(Array.from({ length: Math.min(this.maxParallel, jobs.length) }, worker));

    const out = ranges.map(() => []);
    jobs.forEach((j, k) => { out[j.i][j.seq] = got[k]; });
    return out.map(pieces => pieces.length === 1 ? pieces[0] : Buffer.concat(pieces));
  }
}
