import {parseHistory} from './data.mjs?v=3';

// Keep only one array entry in text form. Nested braces and escaped quotes can
// cross byte chunks; JSON.parse still validates each complete value.
class JSONReader {
  constructor(stream, progress) {
    this.reader = stream.getReader();
    this.decoder = new TextDecoder('utf-8', {fatal: true});
    this.buffer = ''; this.offset = 0; this.done = false; this.progress = progress;
  }
  async available() {
    while (this.offset === this.buffer.length && !this.done) {
      const {value, done} = await this.reader.read();
      this.buffer = done ? this.decoder.decode() : this.decoder.decode(value, {stream: true});
      this.offset = 0; this.done = done; this.progress();
    }
    return this.offset < this.buffer.length;
  }
  async peek() {
    while (await this.available()) {
      while (this.offset < this.buffer.length && /[\x20\t\r\n]/.test(this.buffer[this.offset])) this.offset++;
      if (this.offset < this.buffer.length) return this.buffer[this.offset];
    }
    return '';
  }
  async expect(character) {
    if (await this.peek() !== character) throw new Error('Invalid or incomplete JSON. Check that the export finished downloading.');
    this.offset++;
  }
  async value(maxLength = 32_000_000) {
    const first = await this.peek();
    if (!first || ',]}:'.includes(first)) throw new Error('Invalid or incomplete JSON.');
    const compound = first === '{' || first === '[', quoted = first === '"';
    const parts = []; let length = 0, depth = 0, string = false, escaped = false, finished = false;
    do {
      const start = this.offset;
      while (this.offset < this.buffer.length) {
        const character = this.buffer[this.offset];
        if (!compound && !quoted && /[\x20\t\r\n,\]}]/.test(character)) { finished = true; break; }
        this.offset++;
        if (string) {
          if (escaped) escaped = false;
          else if (character === '\\') escaped = true;
          else if (character === '"') { string = false; if (quoted) { finished = true; break; } }
        } else if (character === '"') string = true;
        else if (compound) {
          if (character === '{' || character === '[') depth++;
          else if (character === '}' || character === ']') {
            if (--depth === 0) { finished = true; break; }
          }
        }
      }
      length += this.offset - start;
      if (length > maxLength) throw new Error('A single JSON record is too large to read safely. Export smaller Timeline segments.');
      parts.push(this.buffer.slice(start, this.offset));
      if (finished) break;
    } while (await this.available());
    if ((compound || quoted) && !finished) throw new Error('Invalid or incomplete JSON.');
    this.valueLength = length;
    try { return JSON.parse(parts.join('')); }
    catch { throw new Error('Invalid JSON. Check that the export is complete.'); }
  }
  async array(visit) {
    await this.expect('[');
    if (await this.peek() === ']') { this.offset++; return; }
    while (true) {
      visit(await this.value());
      if (await this.peek() === ']') { this.offset++; return; }
      await this.expect(',');
    }
  }
}

export async function readHistory(file, append, progress = () => {}) {
  const head = new Uint8Array(await file.slice(0, 2).arrayBuffer());
  let bytes = 0, total = 0, skipped = 0;
  let stream = file.stream().pipeThrough(new TransformStream({transform(chunk, controller) { bytes += chunk.byteLength; controller.enqueue(chunk); }}));
  if (head[0] === 0x1f && head[1] === 0x8b) {
    if (typeof DecompressionStream === 'undefined') throw new Error('Gzip is unavailable in this browser. Unzip the JSON first.');
    stream = stream.pipeThrough(new DecompressionStream('gzip'));
  }
  const notify = () => progress({bytes, size: file.size, total});
  const reader = new JSONReader(stream, notify), metadata = {}, keys = new Set();
  let collection;
  const add = parsed => { append(parsed.points); total += parsed.points.length; skipped += parsed.skipped; };
  async function records(key) {
    if (collection) throw new Error('This file contains multiple history collections. Export one history format per file.');
    collection = key;
    let batch = [], characters = 0;
    const flush = () => { if (batch.length) { add(parseHistory({[key]: batch, ...(key === 'features' ? {type: 'FeatureCollection'} : {})}, {allowEmpty: true})); batch = []; characters = 0; } };
    await reader.array(record => {
      batch.push(record); characters += reader.valueLength;
      if (batch.length === 1000 || characters >= 1_000_000) flush();
    });
    flush();
  }
  try {
    if (await reader.peek() === '[') await records('timelineObjects');
    else {
      await reader.expect('{');
      if (await reader.peek() !== '}') while (true) {
        const key = await reader.value();
        if (typeof key !== 'string' || keys.has(key)) throw new Error('Invalid JSON: object keys must be unique strings.');
        keys.add(key); await reader.expect(':');
        if (['locations', 'semanticSegments', 'timelineObjects', 'features'].includes(key)) await records(key);
        else {
          // Delta history stores three numeric arrays instead of independent
          // records. Preserve the existing bounded decoder for that format.
          const value = await reader.value(key === 'data' ? 512_000_000 : undefined);
          if (['format', 'base', 'data', 'type'].includes(key)) metadata[key] = value;
        }
        if (await reader.peek() === '}') break;
        await reader.expect(',');
      }
      await reader.expect('}');
    }
    if (await reader.peek()) throw new Error('Invalid JSON: unexpected content after the history.');
    if (collection === 'features' && metadata.type !== 'FeatureCollection') throw new Error('Unsupported GeoJSON. Use a FeatureCollection of timestamped points.');
    if (!collection) add(parseHistory(metadata));
    if (!total) throw new Error('No valid timestamped locations were found in this file.');
    notify();
    return {skipped};
  } finally { await reader.reader.cancel().catch(() => {}); }
}
