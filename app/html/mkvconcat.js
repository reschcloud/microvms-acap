/*
 * MkvConcat – fügt mehrere Matroska-Dateien (z. B. Axis-Exporte) im Browser
 * zu EINER Datei zusammen, ohne neu zu kodieren.
 *
 * - Liest die Eingaben als Stream (ReadableStream), es muss nie eine ganze Datei
 *   in den Speicher passen; die Ausgabe wird als Blob aufgebaut (der Browser
 *   lagert große Blobs auf die Festplatte aus).
 * - Zeitstempel werden fortlaufend umgeschrieben; Lücken zwischen den Teilen
 *   werden entfernt (nahtlose Wiedergabe).
 * - Erzeugt SeekHead, Duration, DateUTC und Cues -> sauber spulbare Datei.
 * - Voraussetzung: alle Teile haben dieselben Spuren/Codec-Parameter.
 *   Andernfalls wird ein MkvConcatIncompatibleError geworfen.
 */
(function (global) {
  'use strict';

  const ID = {
    EBML: 0x1A45DFA3, Segment: 0x18538067, SeekHead: 0x114D9B74, Info: 0x1549A966,
    Tracks: 0x1654AE6B, Cluster: 0x1F43B675, Cues: 0x1C53BB6B, Tags: 0x1254C367,
    Chapters: 0x1043A770, Attachments: 0x1941A469, Void: 0xEC, CRC32: 0xBF,
    TimecodeScale: 0x2AD7B1, Timecode: 0xE7, SimpleBlock: 0xA3, BlockGroup: 0xA0, Block: 0xA1,
    TrackEntry: 0xAE, TrackNumber: 0xD7, TrackType: 0x83, CodecID: 0x86, CodecPrivate: 0x63A2,
    Video: 0xE0, PixelWidth: 0xB0, PixelHeight: 0xBA, Audio: 0xE1, SamplingFrequency: 0xB5, Channels: 0x9F,
    Seek: 0x4DBB, SeekID: 0x53AB, SeekPosition: 0x53AC,
    Duration: 0x4489, DateUTC: 0x4461, MuxingApp: 0x4D80, WritingApp: 0x5741, Title: 0x7BA9,
    CuePoint: 0xBB, CueTime: 0xB3, CueTrackPositions: 0xB7, CueTrack: 0xF7, CueClusterPosition: 0xF1,
  };
  const LEVEL1 = new Set([ID.SeekHead, ID.Info, ID.Tracks, ID.Cluster, ID.Cues, ID.Tags,
    ID.Chapters, ID.Attachments, ID.Segment, ID.EBML]);

  class MkvConcatIncompatibleError extends Error {}

  // ------------------------------------------------------------ Reader

  class StreamReader {
    constructor(stream, onBytes) {
      this.reader = stream.getReader();
      this.chunks = [];      // Uint8Array-Queue
      this.avail = 0;
      this.pos = 0;          // absolute Position im Stream
      this.done = false;
      this.onBytes = onBytes;
    }
    async fill(n) {
      while (this.avail < n && !this.done) {
        const { value, done } = await this.reader.read();
        if (done) { this.done = true; break; }
        if (value && value.length) {
          this.chunks.push(value);
          this.avail += value.length;
          if (this.onBytes) this.onBytes(value.length);
        }
      }
      return this.avail >= n;
    }
    peekBytes(n) {
      const out = new Uint8Array(n);
      let o = 0;
      for (const c of this.chunks) {
        const take = Math.min(c.length, n - o);
        out.set(c.subarray(0, take), o);
        o += take;
        if (o >= n) break;
      }
      return out;
    }
    async read(n) {
      if (!(await this.fill(n))) throw new Error('Unexpected end of file');
      const out = new Uint8Array(n);
      let o = 0;
      while (o < n) {
        const c = this.chunks[0];
        const take = Math.min(c.length, n - o);
        out.set(c.subarray(0, take), o);
        o += take;
        if (take === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(take);
      }
      this.avail -= n;
      this.pos += n;
      return out;
    }
    async skip(n) {
      while (n > 0) {
        if (!(await this.fill(1))) throw new Error('Unexpected end of file');
        const c = this.chunks[0];
        const take = Math.min(c.length, n);
        if (take === c.length) this.chunks.shift(); else this.chunks[0] = c.subarray(take);
        this.avail -= take;
        this.pos += take;
        n -= take;
      }
    }
    async eof() { return !(await this.fill(1)); }
    /** Element-ID lesen, ohne zu konsumieren. null bei EOF. */
    async peekId() {
      if (!(await this.fill(1))) return null;
      const len = vintLen(this.peekBytes(1)[0]);
      if (len > 4) throw new Error('Invalid EBML ID');
      if (!(await this.fill(len))) return null;
      const b = this.peekBytes(len);
      let id = 0;
      for (let i = 0; i < len; i++) id = id * 256 + b[i];
      return { id, len };
    }
    async readHeader() {
      const p = await this.peekId();
      if (!p) return null;
      await this.read(p.len);
      await this.fill(1);
      const first = this.peekBytes(1)[0];
      const slen = vintLen(first);
      const sb = await this.read(slen);
      let size = sb[0] & (0xFF >> slen);
      let allOnes = size === (0xFF >> slen);
      for (let i = 1; i < slen; i++) { size = size * 256 + sb[i]; if (sb[i] !== 0xFF) allOnes = false; }
      return { id: p.id, size: allOnes ? -1 : size, headerLen: p.len + slen };
    }
  }

  function vintLen(b) {
    for (let i = 0; i < 8; i++) if (b & (0x80 >> i)) return i + 1;
    throw new Error('Invalid EBML VINT');
  }

  // ------------------------------------------------------------ Parsing helper (Puffer)

  function* children(buf, start = 0, end = buf.length) {
    let p = start;
    while (p < end) {
      const il = vintLen(buf[p]);
      let id = 0;
      for (let i = 0; i < il; i++) id = id * 256 + buf[p + i];
      p += il;
      const sl = vintLen(buf[p]);
      let size = buf[p] & (0xFF >> sl);
      for (let i = 1; i < sl; i++) size = size * 256 + buf[p + i];
      p += sl;
      yield { id, start: p, end: p + size };
      p += size;
    }
  }
  function readUint(buf, s, e) { let v = 0; for (let i = s; i < e; i++) v = v * 256 + buf[i]; return v; }
  function readFloat(buf, s, e) {
    const dv = new DataView(buf.buffer, buf.byteOffset + s, e - s);
    return e - s === 4 ? dv.getFloat32(0) : dv.getFloat64(0);
  }
  const hex = (buf, s, e) => Array.from(buf.subarray(s, e), (b) => b.toString(16).padStart(2, '0')).join('');
  const str = (buf, s, e) => new TextDecoder().decode(buf.subarray(s, e)).replace(/\0+$/, '');

  /** Spur-Signatur für den Kompatibilitätsvergleich + Nummer der Videospur. */
  function analyzeTracks(buf) {
    const sig = [];
    let videoTrack = null;
    for (const te of children(buf)) {
      if (te.id !== ID.TrackEntry) continue;
      const t = {};
      for (const c of children(buf, te.start, te.end)) {
        if (c.id === ID.TrackNumber) t.num = readUint(buf, c.start, c.end);
        else if (c.id === ID.TrackType) t.type = readUint(buf, c.start, c.end);
        else if (c.id === ID.CodecID) t.codec = str(buf, c.start, c.end);
        else if (c.id === ID.CodecPrivate) t.priv = hex(buf, c.start, c.end);
        else if (c.id === ID.Video) {
          for (const v of children(buf, c.start, c.end)) {
            if (v.id === ID.PixelWidth) t.w = readUint(buf, v.start, v.end);
            if (v.id === ID.PixelHeight) t.h = readUint(buf, v.start, v.end);
          }
        } else if (c.id === ID.Audio) {
          for (const a of children(buf, c.start, c.end)) {
            if (a.id === ID.SamplingFrequency) t.sr = readFloat(buf, a.start, a.end);
            if (a.id === ID.Channels) t.ch = readUint(buf, a.start, a.end);
          }
        }
      }
      if (t.type === 1 && videoTrack == null) videoTrack = t.num;
      sig.push([t.num, t.type, t.codec, t.priv || '', t.w || '', t.h || '', t.sr || '', t.ch || ''].join('|'));
    }
    return { signature: sig.join(';'), videoTrack };
  }

  /** Track-Nummer, relative Zeit und Keyframe-Flag eines (Simple)Blocks. */
  function blockInfo(buf, s) {
    const tl = vintLen(buf[s]);
    let track = buf[s] & (0xFF >> tl);
    for (let i = 1; i < tl; i++) track = track * 256 + buf[s + i];
    let rel = (buf[s + tl] << 8) | buf[s + tl + 1];
    if (rel & 0x8000) rel -= 0x10000;
    const flags = buf[s + tl + 2];
    return { track, rel, key: (flags & 0x80) !== 0 };
  }

  // ------------------------------------------------------------ Writer helpers

  function idBytes(id) {
    const out = [];
    while (id > 0) { out.unshift(id & 0xFF); id = Math.floor(id / 256); }
    return out;
  }
  function size8(n) {
    const b = new Uint8Array(8);
    b[0] = 0x01;
    let v = BigInt(n);
    for (let i = 7; i >= 1; i--) { b[i] = Number(v & 0xFFn); v >>= 8n; }
    return b;
  }
  function concatBytes(parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  function el(id, payload) {
    return concatBytes([Uint8Array.from(idBytes(id)), size8(payload.length), payload]);
  }
  function uintEl(id, v) {
    const b = new Uint8Array(8);
    let x = BigInt(Math.max(0, Math.round(v)));
    for (let i = 7; i >= 0; i--) { b[i] = Number(x & 0xFFn); x >>= 8n; }
    return el(id, b);
  }
  function intEl(id, v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, BigInt(v));
    return el(id, b);
  }
  function floatEl(id, v) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, v);
    return el(id, b);
  }
  const strEl = (id, s) => el(id, new TextEncoder().encode(s));

  // ------------------------------------------------------------ Hauptfunktion

  /**
   * @param {Array<() => Promise<ReadableStream>>} sources  Liefert je Teil einen Stream.
   * @param {object} [opts]
   * @param {number} [opts.startTimeMs]  Wanduhrzeit des Exportbeginns (für DateUTC)
   * @param {string} [opts.title]
   * @param {(info:{part:number, parts:number, bytes:number}) => void} [opts.onProgress]
   * @returns {Promise<{blob: Blob, durationMs: number, gaps: number}>}
   */
  async function concat(sources, opts = {}) {
    const onProgress = opts.onProgress || (() => {});
    let tracksBytes = null;
    let signature = null;
    let videoTrack = null;
    let timecodeScale = null;

    const outBlobs = [];      // Cluster-Daten als Blobs
    let pending = [];         // noch nicht als Blob verpackte Bytes
    let pendingLen = 0;
    let clusterBytes = 0;     // Länge aller ausgegebenen Cluster
    const cues = [];          // {time, pos}
    let offset = 0;           // Zeit-Offset des aktuellen Teils (TimecodeScale-Einheiten)
    let totalBytes = 0;

    const flush = () => {
      if (pending.length) { outBlobs.push(new Blob(pending)); pending = []; pendingLen = 0; }
    };
    const emit = (bytes) => {
      pending.push(bytes); pendingLen += bytes.length; clusterBytes += bytes.length;
      if (pendingLen > 8 * 1024 * 1024) flush();
    };

    for (let partIdx = 0; partIdx < sources.length; partIdx++) {
      const stream = await sources[partIdx]();
      const r = new StreamReader(stream, (n) => {
        totalBytes += n;
        onProgress({ part: partIdx + 1, parts: sources.length, bytes: totalBytes });
      });

      let partBase = null;    // erster Cluster-Timecode dieses Teils
      let maxAbs = null;      // größte Blockzeit (absolut, Quelle)
      let lastV = null; let minDelta = Infinity;  // für die Framedauer
      let partTracks = null;

      // Top-Level
      while (!(await r.eof())) {
        const h = await r.readHeader();
        if (!h) break;
        if (h.id === ID.EBML) { await r.skip(h.size); continue; }
        if (h.id !== ID.Segment) { if (h.size < 0) break; await r.skip(h.size); continue; }

        // Segment-Kinder (Segmentgröße wird ignoriert, ein Segment pro Datei)
        while (!(await r.eof())) {
          const c = await r.readHeader();
          if (!c) break;
          if (c.id === ID.Info) {
            const buf = await r.read(c.size);
            let ts = 1000000;
            for (const x of children(buf)) if (x.id === ID.TimecodeScale) ts = readUint(buf, x.start, x.end);
            if (timecodeScale == null) timecodeScale = ts;
            else if (ts !== timecodeScale) throw new MkvConcatIncompatibleError('Different TimecodeScale');
          } else if (c.id === ID.Tracks) {
            const buf = await r.read(c.size);
            const a = analyzeTracks(buf);
            partTracks = a;
            if (signature == null) {
              signature = a.signature; videoTrack = a.videoTrack;
              tracksBytes = el(ID.Tracks, buf);
            } else if (a.signature !== signature) {
              throw new MkvConcatIncompatibleError('Recordings use different track/codec parameters');
            }
          } else if (c.id === ID.Cluster) {
            if (!partTracks) throw new Error('Cluster before Tracks');
            // Cluster-Kinder einlesen
            const end = c.size >= 0 ? r.pos + c.size : Infinity;
            let tc = 0;
            const blocks = [];
            while (r.pos < end) {
              if (c.size < 0) {
                const p = await r.peekId();
                if (!p || LEVEL1.has(p.id)) break;
              }
              const ch = await r.readHeader();
              if (!ch) break;
              if (ch.id === ID.Timecode) {
                const b = await r.read(ch.size); tc = readUint(b, 0, b.length);
              } else if (ch.id === ID.SimpleBlock || ch.id === ID.BlockGroup) {
                const body = await r.read(ch.size);
                let info;
                if (ch.id === ID.SimpleBlock) info = blockInfo(body, 0);
                else {
                  for (const x of children(body)) if (x.id === ID.Block) info = blockInfo(body, x.start);
                  if (info) info.key = false;
                }
                blocks.push({ id: ch.id, body, info });
              } else {
                await r.skip(ch.size);   // Position, PrevSize, Void, CRC ...
              }
            }
            if (!blocks.length) continue;
            if (partBase == null) partBase = tc;
            const newTc = tc - partBase + offset;

            const parts = [uintEl(ID.Timecode, newTc)];
            let cueTime = null;
            for (const b of blocks) {
              parts.push(el(b.id, b.body));
              if (!b.info) continue;
              const abs = tc + b.info.rel;
              if (maxAbs == null || abs > maxAbs) maxAbs = abs;
              if (b.info.track === videoTrack) {
                if (cueTime == null && b.info.key) cueTime = newTc + b.info.rel;
                if (lastV != null && abs !== lastV) minDelta = Math.min(minDelta, Math.abs(abs - lastV));
                lastV = abs;
              }
            }
            if (cueTime != null) cues.push({ time: Math.max(0, cueTime), pos: clusterBytes });
            emit(el(ID.Cluster, concatBytes(parts)));
          } else if (c.size >= 0) {
            await r.skip(c.size);        // SeekHead, Cues, Tags, Chapters, Void ...
          } else {
            throw new Error(`Unknown-size element not supported (0x${c.id.toString(16)})`);
          }
        }
      }

      if (partBase != null && maxAbs != null) {
        // nächster Teil schließt nahtlos an: letzte Blockzeit + eine Framedauer
        let frame = minDelta;
        if (!(frame > 0 && frame < 1000)) frame = Math.round(40 * 1e6 / (timecodeScale || 1e6));
        offset = maxAbs - partBase + offset + frame;
      }
    }

    if (!tracksBytes) throw new Error('No video data found in export');
    flush();

    // --- Kopf + Cues bauen (jetzt sind alle Größen bekannt)
    const durationMs = offset * (timecodeScale / 1e6);
    const infoParts = [
      uintEl(ID.TimecodeScale, timecodeScale),
      floatEl(ID.Duration, offset),
      strEl(ID.MuxingApp, 'MkvConcat'),
      strEl(ID.WritingApp, 'Micro VMS'),
    ];
    if (opts.startTimeMs != null) {
      const ns = (BigInt(Math.round(opts.startTimeMs)) - BigInt(Date.UTC(2001, 0, 1))) * 1000000n;
      infoParts.push(intEl(ID.DateUTC, ns));
    }
    if (opts.title) infoParts.push(strEl(ID.Title, opts.title));
    const info = el(ID.Info, concatBytes(infoParts));

    const seekEntry = (id, pos) => el(ID.Seek, concatBytes([el(ID.SeekID, Uint8Array.from(idBytes(id))), uintEl(ID.SeekPosition, pos)]));
    const buildSeekHead = (infoPos, tracksPos, cuesPos) =>
      el(ID.SeekHead, concatBytes([seekEntry(ID.Info, infoPos), seekEntry(ID.Tracks, tracksPos), seekEntry(ID.Cues, cuesPos)]));
    const seekLen = buildSeekHead(0, 0, 0).length;          // feste Länge (8-Byte-Werte)
    const prefix = seekLen + info.length + tracksBytes.length;
    const seekHead = buildSeekHead(seekLen, seekLen + info.length, prefix + clusterBytes);

    const cuesEl = el(ID.Cues, concatBytes(cues.map((c) => el(ID.CuePoint, concatBytes([
      uintEl(ID.CueTime, c.time),
      el(ID.CueTrackPositions, concatBytes([uintEl(ID.CueTrack, videoTrack || 1), uintEl(ID.CueClusterPosition, prefix + c.pos)])),
    ])))));

    const segmentSize = prefix + clusterBytes + cuesEl.length;
    const ebmlHeader = el(ID.EBML, concatBytes([
      uintEl(0x4286, 1), uintEl(0x42F7, 1), uintEl(0x42F2, 4), uintEl(0x42F3, 8),
      strEl(0x4282, 'matroska'), uintEl(0x4287, 4), uintEl(0x4285, 2),
    ]));
    const segHeader = concatBytes([Uint8Array.from(idBytes(ID.Segment)), size8(segmentSize)]);

    const blob = new Blob([ebmlHeader, segHeader, seekHead, info, tracksBytes, ...outBlobs, cuesEl],
      { type: 'video/x-matroska' });
    return { blob, durationMs, parts: sources.length };
  }

  global.MkvConcat = { concat, MkvConcatIncompatibleError };
})(typeof window !== 'undefined' ? window : globalThis);
