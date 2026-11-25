/*
 * mp4fix.js — turn a fragmented MP4 (what browsers' MediaRecorder writes) into a
 * regular MP4 with a full sample table and the real duration in its header.
 *
 * Why: MediaRecorder MP4 files have duration 0 in `mvhd` and keep the samples in
 * many moof/mdat fragments (~one per keyframe interval). Phone galleries and some
 * players then show only the first fragment, e.g. "4 seconds".
 *
 * The output is ftyp + moov + mdat ("fast start"). Media bytes are not copied in
 * memory: the result Blob references slices of the input Blob, so long 1080p
 * recordings stay cheap on phones.
 *
 * Usage: const fixed = await defragMp4(blob);   // returns the input unchanged if it is not fragmented
 */
(function (root) {
  "use strict";

  const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "mvex", "moof", "traf", "edts", "dinf"]);

  // ---------- reading ----------
  function str4(u8, p) { return String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]); }

  function parseBoxes(u8, start, end, base) {
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    const out = [];
    let p = start;
    while (p + 8 <= end) {
      let size = dv.getUint32(p);
      const type = str4(u8, p + 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; }
      else if (size === 0) size = end - p;
      if (size < hdr || p + size > end) break;
      const box = { type, start: p, size, hdr, end: p + size, fileStart: base + p };
      if (CONTAINERS.has(type)) box.children = parseBoxes(u8, p + hdr, p + size, base);
      out.push(box);
      p += size;
    }
    return out;
  }
  const kid = (box, type) => (box.children || []).find(b => b.type === type);
  const kids = (box, type) => (box.children || []).filter(b => b.type === type);

  async function readTopLevel(blob) {
    const boxes = [];
    let p = 0;
    while (p + 8 <= blob.size) {
      const h = new Uint8Array(await blob.slice(p, Math.min(p + 16, blob.size)).arrayBuffer());
      const dv = new DataView(h.buffer);
      let size = dv.getUint32(0);
      const type = str4(h, 4);
      let hdr = 8;
      if (size === 1) { size = Number(dv.getBigUint64(8)); hdr = 16; }
      else if (size === 0) size = blob.size - p;
      if (size < hdr) break;
      size = Math.min(size, blob.size - p); // a recording cut short may have a truncated last box
      boxes.push({ type, start: p, size, hdr });
      p += size;
    }
    return boxes;
  }

  // ---------- writing ----------
  class W {
    constructor() { this.parts = []; this.len = 0; }
    u8(v) { this.parts.push([1, v]); this.len += 1; }
    u16(v) { this.parts.push([2, v]); this.len += 2; }
    u24(v) { this.parts.push([3, v]); this.len += 3; }
    u32(v) { this.parts.push([4, v >>> 0]); this.len += 4; }
    i32(v) { this.parts.push([5, v | 0]); this.len += 4; }
    u64(v) { this.parts.push([8, v]); this.len += 8; }
    bytes(b) { this.parts.push([0, b]); this.len += b.length; }
    type(t) { this.bytes(new Uint8Array([...t].map(c => c.charCodeAt(0)))); }
    done() {
      const out = new Uint8Array(this.len), dv = new DataView(out.buffer);
      let p = 0;
      for (const [k, v] of this.parts) {
        if (k === 0) { out.set(v, p); p += v.length; }
        else if (k === 1) out[p++] = v;
        else if (k === 2) { dv.setUint16(p, v); p += 2; }
        else if (k === 3) { out[p] = (v >>> 16) & 255; out[p + 1] = (v >>> 8) & 255; out[p + 2] = v & 255; p += 3; }
        else if (k === 4) { dv.setUint32(p, v); p += 4; }
        else if (k === 5) { dv.setInt32(p, v); p += 4; }
        else if (k === 8) { dv.setBigUint64(p, BigInt(v)); p += 8; }
      }
      return out;
    }
  }
  function box(type, ...payload) {
    const len = payload.reduce((n, b) => n + b.length, 0);
    const w = new W(); w.u32(8 + len); w.type(type);
    for (const b of payload) w.bytes(b);
    return w.done();
  }
  function fullBox(type, version, flags, body) {
    const w = new W(); w.u8(version); w.u24(flags); w.bytes(body);
    return box(type, w.done());
  }

  // ---------- main ----------
  async function defragMp4(blob) {
    const top = await readTopLevel(blob);
    const moovTop = top.find(b => b.type === "moov");
    const ftypTop = top.find(b => b.type === "ftyp");
    const moofsTop = top.filter(b => b.type === "moof");
    if (!moovTop || !ftypTop || moofsTop.length === 0) return blob; // already a normal MP4 (or not MP4)

    const moovU8 = new Uint8Array(await blob.slice(moovTop.start, moovTop.start + moovTop.size).arrayBuffer());
    const moov = parseBoxes(moovU8, 0, moovU8.length, moovTop.start)[0];
    const mdv = new DataView(moovU8.buffer);

    // Track info + trex defaults.
    const tracks = new Map();
    for (const trak of kids(moov, "trak")) {
      const tkhd = kid(trak, "tkhd");
      const v = moovU8[tkhd.start + tkhd.hdr];
      const id = mdv.getUint32(tkhd.start + tkhd.hdr + 4 + (v ? 16 : 8));
      const mdia = kid(trak, "mdia");
      const mdhd = kid(mdia, "mdhd");
      const mv = moovU8[mdhd.start + mdhd.hdr];
      const timescale = mdv.getUint32(mdhd.start + mdhd.hdr + 4 + (mv ? 16 : 8));
      const hdlr = kid(mdia, "hdlr");
      const handler = str4(moovU8, hdlr.start + hdlr.hdr + 8);
      tracks.set(id, { id, trak, timescale, handler, samples: [], chunks: [], defaults: { dur: 0, size: 0, flags: 0 } });
    }
    const mvex = kid(moov, "mvex");
    for (const trex of mvex ? kids(mvex, "trex") : []) {
      const p = trex.start + trex.hdr + 4;
      const t = tracks.get(mdv.getUint32(p));
      if (t) t.defaults = { dur: mdv.getUint32(p + 8), size: mdv.getUint32(p + 12), flags: mdv.getUint32(p + 16) };
    }

    // Walk every fragment and collect samples (absolute file offsets).
    const order = []; // chunks in original file order: { track, offset, size }
    for (const mt of moofsTop) {
      const u8 = new Uint8Array(await blob.slice(mt.start, mt.start + mt.size).arrayBuffer());
      const dv = new DataView(u8.buffer);
      const moof = parseBoxes(u8, 0, u8.length, mt.start)[0];
      for (const traf of kids(moof, "traf")) {
        const tfhd = kid(traf, "tfhd");
        let p = tfhd.start + tfhd.hdr;
        const tf = dv.getUint32(p) & 0xffffff; p += 4;
        const t = tracks.get(dv.getUint32(p)); p += 4;
        if (!t) continue;
        let base = mt.start;
        if (tf & 0x1) { base = Number(dv.getBigUint64(p)); p += 8; }
        if (tf & 0x2) p += 4;
        const def = { ...t.defaults };
        if (tf & 0x8) { def.dur = dv.getUint32(p); p += 4; }
        if (tf & 0x10) { def.size = dv.getUint32(p); p += 4; }
        if (tf & 0x20) { def.flags = dv.getUint32(p); p += 4; }

        let dataPos = base;
        for (const trun of kids(traf, "trun")) {
          let q = trun.start + trun.hdr;
          const ver = u8[q];
          const fl = dv.getUint32(q) & 0xffffff; q += 4;
          const n = dv.getUint32(q); q += 4;
          if (fl & 0x1) { dataPos = base + dv.getInt32(q); q += 4; }
          let firstFlags = null;
          if (fl & 0x4) { firstFlags = dv.getUint32(q); q += 4; }
          const chunkStart = dataPos;
          let chunkSize = 0;
          for (let i = 0; i < n; i++) {
            const dur = fl & 0x100 ? dv.getUint32((q += 4) - 4) : def.dur;
            const size = fl & 0x200 ? dv.getUint32((q += 4) - 4) : def.size;
            let flags = fl & 0x400 ? dv.getUint32((q += 4) - 4) : def.flags;
            if (i === 0 && firstFlags !== null) flags = firstFlags;
            let cto = 0;
            if (fl & 0x800) { cto = ver ? dv.getInt32(q) : dv.getUint32(q); q += 4; }
            t.samples.push({ dur, size, sync: !(flags & 0x10000), cto });
            chunkSize += size;
          }
          dataPos += chunkSize;
          if (n > 0) {
            // Drop a chunk that runs past the end of the file (recording cut mid-write).
            if (chunkStart + chunkSize > blob.size) { t.samples.length -= n; continue; }
            const c = { track: t, offset: chunkStart, size: chunkSize, count: n };
            t.chunks.push(c);
            order.push(c);
          }
        }
      }
    }
    if (order.length === 0) return blob;

    // Movie timescale and durations.
    const mvhd = kid(moov, "mvhd");
    const mvV = moovU8[mvhd.start + mvhd.hdr];
    const movieScale = mdv.getUint32(mvhd.start + mvhd.hdr + 4 + (mvV ? 16 : 8));
    let movieDur = 0;
    for (const t of tracks.values()) {
      t.mediaDur = t.samples.reduce((n, s) => n + s.dur, 0);
      t.movieDur = Math.round(t.mediaDur * movieScale / t.timescale);
      movieDur = Math.max(movieDur, t.movieDur);
    }

    const copy = b => moovU8.slice(b.start, b.end);

    function patchDuration(b, durOffsetV0, durOffsetV1, value) {
      const u = copy(b), dv = new DataView(u.buffer);
      const v = u[b.hdr];
      if (v) dv.setBigUint64(b.hdr + durOffsetV1, BigInt(value));
      else dv.setUint32(b.hdr + durOffsetV0, Math.min(value, 0xffffffff));
      return u;
    }

    function buildTrak(t, chunkOffsets) {
      const parts = [];
      for (const c of t.trak.children) {
        if (c.type === "tkhd") parts.push(patchDuration(c, 4 + 16, 4 + 24, t.movieDur));
        else if (c.type === "edts") {
          const elst = kid(c, "elst");
          if (!elst) continue;
          const u = copy(elst), dv = new DataView(u.buffer);
          const v = u[elst.hdr];
          const n = dv.getUint32(elst.hdr + 4);
          if (n === 1) { // single segment: make it span the whole track
            const p = elst.hdr + 8;
            if (v) dv.setBigUint64(p, BigInt(t.movieDur)); else dv.setUint32(p, t.movieDur);
          }
          parts.push(box("edts", u));
        }
        else if (c.type === "mdia") parts.push(buildMdia(c, t, chunkOffsets));
        else parts.push(copy(c));
      }
      return box("trak", ...parts);
    }
    function buildMdia(mdia, t, chunkOffsets) {
      const parts = [];
      for (const c of mdia.children) {
        if (c.type === "mdhd") parts.push(patchDuration(c, 4 + 12, 4 + 20, t.mediaDur));
        else if (c.type === "minf") {
          const mp = [];
          for (const m of c.children) mp.push(m.type === "stbl" ? buildStbl(m, t, chunkOffsets) : copy(m));
          parts.push(box("minf", ...mp));
        }
        else parts.push(copy(c));
      }
      return box("mdia", ...parts);
    }
    function buildStbl(stbl, t, chunkOffsets) {
      const S = t.samples;
      // stts (run-length of durations)
      const stts = [];
      for (const s of S) { const l = stts[stts.length - 1]; if (l && l[1] === s.dur) l[0]++; else stts.push([1, s.dur]); }
      let w = new W(); w.u32(stts.length); for (const [n, d] of stts) { w.u32(n); w.u32(d); }
      const parts = [copy(kid(stbl, "stsd")), fullBox("stts", 0, 0, w.done())];
      // ctts
      if (S.some(s => s.cto !== 0)) {
        const neg = S.some(s => s.cto < 0);
        const runs = [];
        for (const s of S) { const l = runs[runs.length - 1]; if (l && l[1] === s.cto) l[0]++; else runs.push([1, s.cto]); }
        w = new W(); w.u32(runs.length); for (const [n, o] of runs) { w.u32(n); neg ? w.i32(o) : w.u32(o); }
        parts.push(fullBox("ctts", neg ? 1 : 0, 0, w.done()));
      }
      // stss (only if some samples are not sync)
      if (S.some(s => !s.sync)) {
        const idx = []; S.forEach((s, i) => { if (s.sync) idx.push(i + 1); });
        w = new W(); w.u32(idx.length); for (const i of idx) w.u32(i);
        parts.push(fullBox("stss", 0, 0, w.done()));
      }
      // stsc (samples per chunk, run-length)
      const stsc = [];
      t.chunks.forEach((c, i) => { const l = stsc[stsc.length - 1]; if (!l || l[1] !== c.count) stsc.push([i + 1, c.count]); });
      w = new W(); w.u32(stsc.length); for (const [first, n] of stsc) { w.u32(first); w.u32(n); w.u32(1); }
      parts.push(fullBox("stsc", 0, 0, w.done()));
      // stsz
      w = new W(); w.u32(0); w.u32(S.length); for (const s of S) w.u32(s.size);
      parts.push(fullBox("stsz", 0, 0, w.done()));
      // co64 (64-bit chunk offsets)
      w = new W(); w.u32(t.chunks.length); for (const c of t.chunks) w.u64(chunkOffsets.get(c));
      parts.push(fullBox("co64", 0, 0, w.done()));
      // keep sgpd/sbgp etc. out (they describe fragments); keep nothing else
      return box("stbl", ...parts);
    }

    function buildMoov(chunkOffsets) {
      const parts = [];
      for (const c of moov.children) {
        if (c.type === "mvhd") parts.push(patchDuration(c, 4 + 12, 4 + 20, movieDur));
        else if (c.type === "trak") {
          const id = [...tracks.values()].find(t => t.trak === c);
          if (id && id.samples.length) parts.push(buildTrak(id, chunkOffsets));
        }
        else if (c.type === "mvex") continue; // no longer fragmented
        else parts.push(copy(c));
      }
      return box("moov", ...parts);
    }

    // Layout: ftyp, moov, mdat. Build moov once with dummy offsets to learn its size (co64 is fixed width).
    const ftyp = new Uint8Array(await blob.slice(ftypTop.start, ftypTop.start + ftypTop.size).arrayBuffer());
    const dummy = new Map(order.map(c => [c, 0]));
    const moovSize = buildMoov(dummy).length;
    const mediaBytes = order.reduce((n, c) => n + c.size, 0);
    const large = mediaBytes + 8 > 0xffffffff;
    const mdatHdr = new W();
    if (large) { mdatHdr.u32(1); mdatHdr.type("mdat"); mdatHdr.u64(mediaBytes + 16); }
    else { mdatHdr.u32(mediaBytes + 8); mdatHdr.type("mdat"); }
    const mdatHead = mdatHdr.done();

    const offsets = new Map();
    let pos = ftyp.length + moovSize + mdatHead.length;
    for (const c of order) { offsets.set(c, pos); pos += c.size; }
    const moovOut = buildMoov(offsets);

    const pieces = [ftyp, moovOut, mdatHead, ...order.map(c => blob.slice(c.offset, c.offset + c.size))];
    return new Blob(pieces, { type: "video/mp4" });
  }

  root.defragMp4 = defragMp4;
  if (typeof module !== "undefined") module.exports = { defragMp4 };
})(typeof window !== "undefined" ? window : globalThis);
