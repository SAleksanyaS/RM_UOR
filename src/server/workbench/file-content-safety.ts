import { inflateRawSync } from 'node:zlib';
import { DOMParser } from '@xmldom/xmldom';
import type { FileLimits, FilePurpose } from './files';
import { WorkbenchHttpError } from './protocol';

const invalid = () => new WorkbenchHttpError(422, 'INVALID_FILE', 'The file is invalid or unsupported');
const decoder = new TextDecoder('utf-8', { fatal: true });
function textStructure(bytes: Buffer): string { const value = bytes.toString('latin1'); if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || /^\s*(?:MZ|<!doctype\s+html|<html|<script|<svg)/i.test(value)) throw invalid(); return value; }
function text(bytes: Uint8Array): string { const value = decoder.decode(bytes); if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(value) || /^\s*(?:MZ|<!doctype\s+html|<html|<script|<svg)/i.test(value)) throw invalid(); return value; }
function csvSafety(value: string): void {
  const line = value.split(/\r?\n/, 1)[0], counts = new Map([ [',', 0], [';', 0], ['\t', 0] ]); let quoted = false;
  for (let i = 0; i < line.length; i++) { if (line[i] === '"') { if (quoted && line[i + 1] === '"') i++; else quoted = !quoted; } else if (!quoted && counts.has(line[i])) counts.set(line[i], counts.get(line[i])! + 1); }
  const ranked = [...counts].sort((a, b) => b[1] - a[1]); if (ranked[0][1] && ranked[0][1] === ranked[1][1]) throw invalid();
  const delimiter = ranked[0][0]; let rows = 0, columns = 0, length = 0, closed = false, nonempty = false; quoted = false;
  const cell = () => { if (++columns > 100) throw invalid(); length = 0; closed = false; };
  const row = () => { cell(); if (nonempty && ++rows > 20001) throw invalid(); columns = 0; nonempty = false; };
  for (let i = 0; i < value.length; i++) {
    const c = value[i];
    if (quoted) { if (c === '"') { if (value[i + 1] === '"') { length++; i++; } else { quoted = false; closed = true; } } else { length++; if (c.trim()) nonempty = true; } }
    else if (c === delimiter) cell();
    else if (c === '\n' || c === '\r') { if (c === '\r' && value[i + 1] === '\n') i++; row(); }
    else if (c === '"') { if (length || closed) throw invalid(); quoted = true; }
    else { if (closed) throw invalid(); length++; if (c.trim()) nonempty = true; }
    if (length > 10000) throw invalid();
  }
  if (quoted) throw invalid(); if (length || columns || closed) row(); if (!rows) throw invalid();
}
const crcTable = Array.from({ length: 256 }, (_, value) => { for (let bit = 0; bit < 8; bit++) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1; return value >>> 0; });
function crc32(bytes: Uint8Array): number { let crc = 0xffffffff; for (const byte of bytes) crc = crcTable[(crc ^ byte) & 255] ^ crc >>> 8; return (crc ^ 0xffffffff) >>> 0; }
/** Inspect and bound actual inflation before any workbook/JSON object model is allocated. */
function archive(bytes: Buffer, expandedLimit: number, restore: boolean): Map<string, Buffer> {
  let end = -1; for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65557); i--) if (bytes.readUInt32LE(i) === 0x06054b50 && i + 22 + bytes.readUInt16LE(i + 20) === bytes.length) { end = i; break; }
  if (end < 0) throw invalid(); const count = bytes.readUInt16LE(end + 10), offset = bytes.readUInt32LE(end + 16);
  if (!count || count > 4096 || bytes.readUInt16LE(end + 4) || bytes.readUInt16LE(end + 6) || bytes.readUInt16LE(end + 8) !== count || offset + bytes.readUInt32LE(end + 12) !== end) throw invalid();
  const entries = new Map<string, Buffer>(), ranges: Array<[number, number]> = []; let cursor = offset, total = 0;
  for (let index = 0; index < count; index++) {
    if (cursor + 46 > end || bytes.readUInt32LE(cursor) !== 0x02014b50) throw invalid();
    const flags = bytes.readUInt16LE(cursor + 8), method = bytes.readUInt16LE(cursor + 10), compressed = bytes.readUInt32LE(cursor + 20), size = bytes.readUInt32LE(cursor + 24), nameLength = bytes.readUInt16LE(cursor + 28), extraLength = bytes.readUInt16LE(cursor + 30), next = cursor + 46 + nameLength + extraLength + bytes.readUInt16LE(cursor + 32), local = bytes.readUInt32LE(cursor + 42);
    if (next > end || flags & ~0x080e || flags & 1 || ![0, 8].includes(method) || [compressed, size, local].includes(0xffffffff) || (bytes.readUInt32LE(cursor + 38) >>> 16 & 0xf000) === 0xa000 || size > expandedLimit - total) throw invalid();
    const name = decoder.decode(bytes.subarray(cursor + 46, cursor + 46 + nameLength));
    if (!name || /[\\:\x00-\x1f]/.test(name) || name.startsWith('/') || name.split('/').some((part, i, all) => part === '.' || part === '..' || !part && i !== all.length - 1) || entries.has(name)) throw invalid();
    if (restore ? !(name === 'manifest.json' || name === 'records.json' || name === 'files/' || /^files\/[a-f0-9]{64}$/.test(name)) : !(/^(?:\[Content_Types\]\.xml|_rels\/|docProps\/|xl\/)/.test(name) && !/vba|macro|embedding|externalLink|activeX|oleObject/i.test(name) && (name.endsWith('/') || /\.(?:xml|rels)$/.test(name)))) throw invalid();
    if (restore && name !== 'records.json' && size > 32 * 1024 ** 2) throw invalid();
    if (local + 30 > offset || bytes.readUInt32LE(local) !== 0x04034b50 || bytes.readUInt16LE(local + 6) !== flags || bytes.readUInt16LE(local + 8) !== method) throw invalid();
    const localNameLength = bytes.readUInt16LE(local + 26), localExtra = bytes.readUInt16LE(local + 28), start = local + 30 + localNameLength + localExtra, finish = start + compressed;
    if (finish > offset || decoder.decode(bytes.subarray(local + 30, local + 30 + localNameLength)) !== name || start > offset) throw invalid();
    if (!(flags & 8) && (bytes.readUInt32LE(local + 14) !== bytes.readUInt32LE(cursor + 16) || bytes.readUInt32LE(local + 18) !== compressed || bytes.readUInt32LE(local + 22) !== size)) throw invalid();
    // ZIP64 extra fields are unsupported, even when 32-bit fields look small.
    for (const [from, length] of [[cursor + 46 + nameLength, extraLength], [local + 30 + localNameLength, localExtra]]) { let at = from; while (at < from + length) { if (at + 4 > from + length || bytes.readUInt16LE(at) === 1) throw invalid(); const size = bytes.readUInt16LE(at + 2); at += 4 + size; if (at > from + length) throw invalid(); } }
    const output = method === 8 ? inflateRawSync(bytes.subarray(start, finish), { maxOutputLength: Math.max(1, Math.min(size + 1, expandedLimit - total + 1)) }) : bytes.subarray(start, finish);
    if (output.length !== size || crc32(output) !== bytes.readUInt32LE(cursor + 16)) throw invalid();
    ranges.push([local, finish]); entries.set(name, output); total += output.length; cursor = next;
  }
  ranges.sort((a, b) => a[0] - b[0]); if (ranges[0][0] !== 0 || ranges.some((range, index) => index > 0 && range[0] < ranges[index - 1][1]) || cursor !== end) throw invalid();
  if (restore ? !entries.has('manifest.json') || !entries.has('records.json') : !entries.has('[Content_Types].xml') || !entries.has('xl/workbook.xml')) throw invalid();
  return entries;
}
type XmlBudget = { rows: number; cells: number };
/** Linear lexical allocation gate, not a replacement XML parser. No paired-body searches. */
function boundXmlStructure(xml: string, worksheet: boolean, budget: XmlBudget): void {
  const stack: string[] = []; let offset = 0, rowDepth = 0, columns = 0, elements = 0;
  while (offset < xml.length) {
    const start = xml.indexOf('<', offset); if (start < 0) break;
    if (xml.startsWith('<!--', start) || xml.startsWith('<![CDATA[', start) || xml.startsWith('<?', start)) {
      const closing = xml.startsWith('<!--', start) ? '-->' : xml.startsWith('<![CDATA[', start) ? ']]>' : '?>';
      const finish = xml.indexOf(closing, start + 2); if (finish < 0) throw invalid(); offset = finish + closing.length; continue;
    }
    if (xml.startsWith('<!', start)) throw invalid();
    const closing = xml[start + 1] === '/'; let cursor = start + (closing ? 2 : 1), nameEnd = cursor;
    while (nameEnd < xml.length && !/[\s/>]/.test(xml[nameEnd])) nameEnd++;
    const qualifiedName = xml.slice(cursor, nameEnd); if (!qualifiedName) throw invalid();
    let quote = '';
    for (cursor = nameEnd; cursor < xml.length; cursor++) {
      const char = xml[cursor];
      if (quote) { if (char === quote) quote = ''; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
      else if (char === '<') throw invalid();
    }
    if (cursor === xml.length || quote) throw invalid();
    const localName = qualifiedName.slice(qualifiedName.lastIndexOf(':') + 1), selfClosed = xml[cursor - 1] === '/';
    if (closing) {
      if (stack.pop() !== qualifiedName) throw invalid();
      if (worksheet && localName === 'row') rowDepth = 0;
    } else {
      if (++elements > 8000000 || stack.length >= 64) throw invalid();
      if (worksheet && localName === 'row') { if (rowDepth || ++budget.rows > 20001) throw invalid(); rowDepth = stack.length + 1; columns = 0; }
      if (worksheet && localName === 'c' && (!rowDepth || ++columns > 100 || ++budget.cells > 2000100)) throw invalid();
      if (!selfClosed) stack.push(qualifiedName);
      else if (worksheet && localName === 'row') rowDepth = 0;
    }
    offset = cursor + 1;
  }
  if (stack.length) throw invalid();
}
function coordinateBounds(value: string): void {
  for (const match of value.matchAll(/\$?([A-Za-z]+)\$?(\d+)/g)) {
    let column = 0; for (const letter of match[1].toUpperCase()) { column = column * 26 + letter.charCodeAt(0) - 64; if (column > 100) throw invalid(); }
    if (Number(match[2]) < 1 || Number(match[2]) > 20001) throw invalid();
  }
}
function workbookSafety(entries: Map<string, Buffer>): void {
  const budget: XmlBudget = { rows: 0, cells: 0 };
  for (const [name, bytes] of entries) {
    if (name.endsWith('/')) continue;
    const xml = text(bytes), worksheet = /^xl\/worksheets\/[^/]+\.xml$/.test(name);
    boundXmlStructure(xml, worksheet, budget);
    const parser = new DOMParser({ onError: () => { throw invalid(); } });
    const document = parser.parseFromString(xml, 'application/xml'); if (!document.documentElement) throw invalid();
    const elements = document.getElementsByTagName('*');
    for (let index = 0; index < elements.length; index++) {
      const element = elements.item(index)!, localName = element.localName;
      if (localName === null) throw invalid();
      // localName/attribute values come from the XML parser, including namespace prefixes and entities.
      if (['f', 'formula', 'externalReference'].includes(localName) || element.getAttribute('TargetMode')?.toLowerCase() === 'external' || /macroEnabled|vbaProject/i.test(element.getAttribute('ContentType') ?? '')) throw invalid();
      if (['si', 'is', 'v'].includes(localName) && (element.textContent?.length ?? 0) > 10000) throw invalid();
      if (!worksheet) continue;
      for (let attrIndex = 0; attrIndex < element.attributes.length; attrIndex++) {
        const attribute = element.attributes.item(attrIndex)!;
        if (attribute.localName === null || !['r', 'ref', 'sqref'].includes(attribute.localName)) continue;
        if (localName === 'row' && attribute.localName === 'r') { if (!/^\d+$/.test(attribute.value) || Number(attribute.value) < 1 || Number(attribute.value) > 20001) throw invalid(); }
        else coordinateBounds(attribute.value);
      }
    }
  }
}
function pngSafety(bytes: Buffer): void {
  if (!bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) throw invalid(); let at = 8, data = false, header = false;
  while (at < bytes.length) {
    if (at + 12 > bytes.length) throw invalid(); const length = bytes.readUInt32BE(at), end = at + 12 + length, kind = bytes.toString('ascii', at + 4, at + 8); if (end > bytes.length || crc32(bytes.subarray(at + 4, end - 4)) !== bytes.readUInt32BE(end - 4)) throw invalid();
    if (!header) { if (kind !== 'IHDR' || length !== 13 || !bytes.readUInt32BE(at + 8) || !bytes.readUInt32BE(at + 12)) throw invalid(); header = true; }
    else if (kind === 'IHDR') throw invalid();
    if (kind === 'IDAT') data = true; if (kind === 'IEND') { if (length || !data || end !== bytes.length) throw invalid(); return; } at = end;
  }
  throw invalid();
}
function jpegSafety(bytes: Buffer): void {
  if (bytes.length < 8 || bytes.readUInt16BE(0) !== 0xffd8 || bytes.readUInt16BE(bytes.length - 2) !== 0xffd9) throw invalid(); let at = 2, frame = false;
  while (at + 4 <= bytes.length - 2) {
    if (bytes[at++] !== 0xff) throw invalid(); while (bytes[at] === 0xff) at++; const marker = bytes[at++]; if (marker === 0xda) { if (!frame) throw invalid(); const length = bytes.readUInt16BE(at); if (length < 2 || at + length >= bytes.length - 2) throw invalid(); return; }
    if ([0xd8,0xd9,0x00].includes(marker)) throw invalid(); const length = bytes.readUInt16BE(at); if (length < 2 || at + length > bytes.length - 2) throw invalid();
    if ([0xc0,0xc1,0xc2].includes(marker)) { if (length < 8 || !bytes.readUInt16BE(at + 3) || !bytes.readUInt16BE(at + 5)) throw invalid(); frame = true; } at += length;
  }
  throw invalid();
}
/** Opaque evidence is stored only; no document rendering, macro execution or network access. */
export async function validateFileContent(purpose: FilePurpose, name: string, mediaType: string, bytes: Buffer, limits: FileLimits): Promise<void> {
  try {
    const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
    if (purpose === 'workspace-restore') { if (extension !== '.zip' || mediaType !== 'application/zip') throw invalid(); archive(bytes, limits.restoreExpandedBytes, true); return; }
    if(purpose==='goal-import'&&extension==='.zip'&&mediaType==='application/zip'){archive(bytes,limits.restoreExpandedBytes,true);return;}
    if(purpose==='goal-import'&&extension==='.json'&&mediaType==='application/json'){
      const value:unknown=JSON.parse(text(bytes));if(value===null||typeof value!=='object')throw invalid();
      const pending:Array<{value:unknown;depth:number}>=[{value,depth:0}];let count=0;
      while(pending.length){const next=pending.pop()!;if(next.depth>64||++count>1000000)throw invalid();if(typeof next.value==='number'&&!Number.isFinite(next.value))throw invalid();if(next.value&&typeof next.value==='object'){for(const[key,item]of Object.entries(next.value)){if(['__proto__','prototype','constructor'].includes(key))throw invalid();pending.push({value:item,depth:next.depth+1});}}}
      return;
    }
    if (extension === '.csv' && mediaType === 'text/csv') { if (purpose === 'goal-import') textStructure(bytes); else csvSafety(text(bytes)); return; }
    if (extension === '.xlsx' && mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') { workbookSafety(archive(bytes, 64 * 1024 ** 2, false)); return; }
    if (purpose === 'evidence' && extension === '.txt' && mediaType === 'text/plain') { text(bytes); return; }
    if (purpose === 'evidence' && extension === '.pdf' && mediaType === 'application/pdf') { if (!/^%PDF-(?:1\.[0-9]|2\.0)(?:\r|\n)/.test(bytes.subarray(0, 16).toString('ascii')) || !/%%EOF\s*$/.test(bytes.subarray(-1024).toString('ascii')) || bytes.indexOf(Buffer.from('obj')) < 0 || bytes.indexOf(Buffer.from('endobj')) < 0) throw invalid(); return; }
    if (purpose === 'evidence' && extension === '.png' && mediaType === 'image/png') { pngSafety(bytes); return; }
    if (purpose === 'evidence' && ['.jpg', '.jpeg'].includes(extension) && mediaType === 'image/jpeg') { jpegSafety(bytes); return; }
    throw invalid();
  } catch (error) { if (error instanceof WorkbenchHttpError) throw error; throw invalid(); }
}
