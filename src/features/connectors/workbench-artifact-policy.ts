import JSZip from 'jszip';
export const browserArtifactMime = {csv:'text/csv',tsv:'text/tab-separated-values',xlsx:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',xls:'application/vnd.ms-excel'} as const;
export type ArtifactInspection={mimeType:string;status:'supported'|'unsupported'|'quarantined';reason:string|null};
/** Content classification is independent of raw capture and never executes active document content. */
export async function inspectBrowserArtifact(bytes:Buffer,name:string,maxBytes:number):Promise<ArtifactInspection>{
 const extension=/\.([a-z0-9]{1,8})$/i.exec(name)?.[1]?.toLowerCase(),mimeType=browserArtifactMime[extension as keyof typeof browserArtifactMime]??'application/octet-stream';
 const bad=(reason:string):ArtifactInspection=>({mimeType,status:'quarantined',reason});
 if(!bytes.length||bytes.length>maxBytes)return bad('ARTIFACT_SIZE');
 const head=bytes.subarray(0,2048).toString('utf8').replace(/^\uFEFF/,'');
 if(/^\s*(?:<!doctype\s+html|<html|<form|<\?xml)/i.test(head))return bad('LOGIN_OR_XML_CONTENT');
 if(extension==='csv'||extension==='tsv')return bytes.includes(0)?bad('BINARY_TABLE'):{mimeType,status:'supported',reason:null};
 if(extension==='xlsx'){
  try{
   // Check declared expansion before JSZip allocates/decompresses anything. ZIP64/multipart are conservatively quarantined.
   let end=-1;for(let i=bytes.length-22;i>=Math.max(0,bytes.length-65558);i--)if(bytes.readUInt32LE(i)===0x06054b50&&i+22+bytes.readUInt16LE(i+20)===bytes.length){end=i;break;}
   if(end<0||bytes.readUInt16LE(end+4)||bytes.readUInt16LE(end+6))return bad('INVALID_ZIP_DIRECTORY');
   const count=bytes.readUInt16LE(end+10),directorySize=bytes.readUInt32LE(end+12),offset=bytes.readUInt32LE(end+16);if(!count||count>2000||offset+directorySize!==end)return bad('INVALID_ZIP_DIRECTORY');
   let at=offset,expanded=0;for(let n=0;n<count;n++){
    if(at+46>end||bytes.readUInt32LE(at)!==0x02014b50)return bad('INVALID_ZIP_DIRECTORY');
    const size=bytes.readUInt32LE(at+24),compressed=bytes.readUInt32LE(at+20),local=bytes.readUInt32LE(at+42);expanded+=size;
    if(expanded>Math.min(100*1024*1024,maxBytes*30)||size>30*1024*1024||local+30>offset||bytes.readUInt32LE(local)!==0x04034b50||local+30+bytes.readUInt16LE(local+26)+bytes.readUInt16LE(local+28)+compressed>offset)return bad('ZIP_LIMIT_OR_STRUCTURE');
    const nameLength=bytes.readUInt16LE(at+28),entryName=bytes.subarray(at+46,at+46+nameLength).toString();if(/(^\/|\\|(^|\/)\.\.(\/|$))/.test(entryName))return bad('ZIP_PATH');at+=46+nameLength+bytes.readUInt16LE(at+30)+bytes.readUInt16LE(at+32);
   }if(at!==end)return bad('INVALID_ZIP_DIRECTORY');
   const zip=await JSZip.loadAsync(bytes,{checkCRC32:true});if(!zip.file('[Content_Types].xml')||!zip.file('xl/workbook.xml')||!zip.file('_rels/.rels'))return bad('XLSX_PART_MISSING');
   return{mimeType,status:'supported',reason:null};
  }catch{return bad('INVALID_ZIP_CRC_OR_STRUCTURE');}
 }
 if(extension==='xls')return validOle(bytes)?{mimeType,status:'supported',reason:null}:bad('INVALID_OLE_STRUCTURE');
 return{mimeType,status:'unsupported',reason:'UNSUPPORTED_FORMAT'};
}
function validOle(bytes:Buffer):boolean{
 try{
  if(bytes.length<1024||bytes.subarray(0,8).toString('hex')!=='d0cf11e0a1b11ae1'||bytes.readUInt16LE(28)!==0xfffe)return false;
  const major=bytes.readUInt16LE(26),shift=bytes.readUInt16LE(30),sector=2**shift;if(!((major===3&&shift===9)||(major===4&&shift===12))||bytes.length%sector)return false;
  const sectors=bytes.length/sector-1,free=0xffffffff,end=0xfffffffe,fatMarker=0xfffffffd;
  const at=(id:number)=>{if(id>=sectors)throw Error('sector');return (id+1)*sector;};
  // Extended DIFAT remains unsupported rather than accepting an unverified chain.
  if(bytes.readUInt32LE(72)!==0)return false;
  const fatCount=bytes.readUInt32LE(44);if(!fatCount||fatCount>109)return false;
  const fat:number[]=[];const fatIds=new Set<number>();for(let i=0;i<fatCount;i++){const id=bytes.readUInt32LE(76+i*4);if(fatIds.has(id))return false;fatIds.add(id);for(let p=at(id);p<at(id)+sector;p+=4)fat.push(bytes.readUInt32LE(p));}
  for(const id of fatIds)if(fat[id]!==fatMarker)return false;
  const chain=(start:number)=>{const ids:number[]=[],seen=new Set<number>();for(let id=start;id!==end;id=fat[id]){if(id===free||id>=sectors||seen.has(id)||ids.length>=sectors)throw Error('chain');at(id);seen.add(id);ids.push(id);}return ids;};
  const directory=Buffer.concat(chain(bytes.readUInt32LE(48)).map(id=>bytes.subarray(at(id),at(id)+sector)));if(!directory.length)return false;
  const entries:Array<{type:number;name:string;size:number;start:number}>=[];
  for(let p=0;p+128<=directory.length;p+=128){const type=directory[p+66],nameLength=directory.readUInt16LE(p+64);if(!type)continue;if(nameLength<2||nameLength>64||nameLength%2)return false;const name=directory.subarray(p,p+nameLength-2).toString('utf16le'),size=Number(directory.readBigUInt64LE(p+120));if(!Number.isSafeInteger(size)||size>bytes.length)return false;entries.push({type,name,size,start:directory.readUInt32LE(p+116)});}
  const roots=entries.filter(e=>e.type===5);if(roots.length!==1)return false;const root=roots[0],miniShift=bytes.readUInt16LE(32);if(miniShift!==6||bytes.readUInt32LE(56)!==4096)return false;
  const rootIds=root.size?chain(root.start):[];if(rootIds.length*sector<root.size)return false;
  const miniFatCount=bytes.readUInt32LE(64),miniFatIds=miniFatCount?chain(bytes.readUInt32LE(60)):[];if(miniFatIds.length!==miniFatCount)return false;
  const miniFat:number[]=[];for(const id of miniFatIds)for(let p=at(id);p<at(id)+sector;p+=4)miniFat.push(bytes.readUInt32LE(p));
  const streamSize=(start:number)=>{let count=0;const visited=new Set<number>();for(let id=start;id!==end;id=miniFat[id]){if(id>=Math.ceil(root.size/64)||id>=miniFat.length||visited.has(id))throw Error('mini chain');visited.add(id);count++;}return count*64;};
  let workbook=false;for(const e of entries.filter(e=>e.type===2)){if(e.size){const capacity=e.size<4096?streamSize(e.start):chain(e.start).length*sector;if(capacity<e.size)return false;}if(/^(Workbook|Book)$/.test(e.name)&&e.size>0)workbook=true;}
  return workbook;
 }catch{return false;}
}
