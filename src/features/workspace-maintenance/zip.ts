import {inflateRawSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import JSZip from 'jszip';
import {MAX_BUNDLE_BYTES,MAX_EXPANDED_BYTES,MAX_FILE_BYTES} from './contracts';
export const sha256=(value:Uint8Array|string)=>createHash('sha256').update(value).digest('hex');
const allowed=(name:string)=>name==='manifest.json'||name==='records.json'||name==='files/'||/^files\/[a-f0-9]{64}$/.test(name);
/** Inspect raw central directory before inflating any archive member. ZIP64/encryption/symlinks are unsupported. */
export function inspectPortableZip(bytes:Buffer){
 if(bytes.length>MAX_BUNDLE_BYTES||bytes.length<22)throw new Error('Размер переносимой копии превышает64МБ или файл повреждён');
 let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65557);i--)if(bytes.readUInt32LE(i)===0x06054b50){end=i;break;}
 if(end<0||end+22+bytes.readUInt16LE(end+20)!==bytes.length)throw new Error('Некорректное завершение ZIP');
 const count=bytes.readUInt16LE(end+10),centralSize=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);
 if(bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6)||count>4096||count===65535||offset+centralSize!==end)throw new Error('Неподдержанный ZIP или слишком много файлов');
 const names=new Set<string>();let cursor=offset,total=0;
 for(let index=0;index<count;index++){
  if(cursor+46>end||bytes.readUInt32LE(cursor)!==0x02014b50)throw new Error('Повреждён каталог ZIP');
  const flags=bytes.readUInt16LE(cursor+8),method=bytes.readUInt16LE(cursor+10),compressed=bytes.readUInt32LE(cursor+20),size=bytes.readUInt32LE(cursor+24),nameLength=bytes.readUInt16LE(cursor+28),extra=bytes.readUInt16LE(cursor+30),comment=bytes.readUInt16LE(cursor+32),attributes=bytes.readUInt32LE(cursor+38),localOffset=bytes.readUInt32LE(cursor+42);
  if(cursor+46+nameLength+extra+comment>end||flags&1||![0,8].includes(method)||compressed===0xffffffff||size===0xffffffff||localOffset===0xffffffff||(attributes>>>16&0xf000)===0xa000)throw new Error('Неподдержанное содержимое ZIP');
  const name=bytes.subarray(cursor+46,cursor+46+nameLength).toString('utf8');
  if(!allowed(name)||names.has(name)||size>(name==='records.json'?MAX_EXPANDED_BYTES:MAX_FILE_BYTES))throw new Error('Недопустимый путь, повтор или размер файла в ZIP');
  if(localOffset+30>offset||bytes.readUInt32LE(localOffset)!==0x04034b50)throw new Error('Повреждён заголовок ZIP');
  const localNameLength=bytes.readUInt16LE(localOffset+26),localExtraLength=bytes.readUInt16LE(localOffset+28);const localName=bytes.subarray(localOffset+30,localOffset+30+localNameLength).toString('utf8');
  if(localName!==name||localOffset+30+localNameLength+localExtraLength>offset||bytes.readUInt16LE(localOffset+8)!==method)throw new Error('Пути ZIP не совпадают');
  const dataStart=localOffset+30+localNameLength+localExtraLength;if(dataStart+compressed>offset)throw new Error('Файл ZIP выходит за область данных');try{const output=method===8?inflateRawSync(bytes.subarray(dataStart,dataStart+compressed),{maxOutputLength:Math.max(1,size+1)}):bytes.subarray(dataStart,dataStart+compressed);if(output.length!==size)throw new Error();}catch{throw new Error('Размер распакованного файла не совпадает с каталогом ZIP');}
  names.add(name);total+=size;if(total>MAX_EXPANDED_BYTES)throw new Error('Распакованная копия превышает256МБ');cursor+=46+nameLength+extra+comment;
 }
 if(cursor!==end||!names.has('manifest.json')||!names.has('records.json'))throw new Error('В ZIP отсутствуют обязательные файлы');return names;
}
export async function loadPortableZip(bytes:Buffer){const names=inspectPortableZip(bytes),zip=await JSZip.loadAsync(bytes,{checkCRC32:true});for(const[name,file]of Object.entries(zip.files))if(!names.has(name)||('unsafeOriginalName' in file&&file.unsafeOriginalName!==name))throw new Error('Нормализация ZIP изменила путь');return zip;}
export function assertJsonSafety(value:unknown){let nodes=0;function visit(item:unknown,depth:number){if(depth>64||++nodes>1000000)throw new Error('Слишком сложная структура переносимых данных');if(Array.isArray(item)){for(const child of item)visit(child,depth+1);}else if(item&&typeof item==='object')for(const[key,child]of Object.entries(item)){if(['__proto__','prototype','constructor'].includes(key))throw new Error('Недопустимое поле в переносимых данных');if(/^(password|accessToken|refreshToken|privateKey|certificatePem|cookie|authorization|curatorCode)$/i.test(key)&&child)throw new Error('Копия содержит секретное поле; перенесите доступ отдельно');if(/(?:url|href|endpoint)$/i.test(key)&&typeof child==='string'&&child){if(!/^https?:\/\//i.test(child))throw new Error('Недопустимая ссылка в переносимых данных');const url=new URL(child);if(url.username||url.password)throw new Error('Ссылка содержит учётные данные; перенесите доступ отдельно');}visit(child,depth+1);}}visit(value,0);}
