import { expect,it } from 'vitest';
import ExcelJS from 'exceljs';
import { inspectBrowserArtifact } from './workbench-artifact-policy';
it('preserves CSV TSV XLSX MIME and rejects fake/truncated ZIP while retaining unsupported raw status',async()=>{
 expect(await inspectBrowserArtifact(Buffer.from('a;b\r\n1;2'),'a.csv',10000)).toMatchObject({mimeType:'text/csv',status:'supported'});
 expect(await inspectBrowserArtifact(Buffer.from('a\tb\r\n1\t2'),'a.tsv',10000)).toMatchObject({mimeType:'text/tab-separated-values',status:'supported'});
 const book=new ExcelJS.Workbook();book.addWorksheet('Data').addRow(['a','b']);const bytes=Buffer.from(await book.xlsx.writeBuffer());
 expect(await inspectBrowserArtifact(bytes,'a.xlsx',100000)).toMatchObject({status:'supported'});
 expect(await inspectBrowserArtifact(bytes.subarray(0,bytes.length-10),'a.xlsx',100000)).toMatchObject({status:'quarantined'});
 expect(await inspectBrowserArtifact(Buffer.from('PK\x03\x04not a workbookPK\x05\x06'+'\0'.repeat(18)),'a.xlsx',10000)).toMatchObject({status:'quarantined'});
 expect(await inspectBrowserArtifact(Buffer.from('<html>Sign in</html>'),'report.csv',10000)).toMatchObject({status:'quarantined'});
 expect(await inspectBrowserArtifact(Buffer.from([1,2,3]),'unknown.bin',10000)).toMatchObject({status:'unsupported',mimeType:'application/octet-stream'});
 expect(await inspectBrowserArtifact(Buffer.from('d0cf11e0','hex'),'a.xls',10000)).toMatchObject({status:'quarantined',mimeType:'application/vnd.ms-excel'});
});
it('checks a real OLE mini-FAT workbook chain and quarantines a cycle or truncated chain',async()=>{
 const bytes=Buffer.alloc(2560),header=bytes.subarray(0,512),fat=bytes.subarray(512,1024),directory=bytes.subarray(1024,1536),miniFat=bytes.subarray(2048);
 Buffer.from('d0cf11e0a1b11ae1','hex').copy(header);header.writeUInt16LE(0x3e,24);header.writeUInt16LE(3,26);header.writeUInt16LE(0xfffe,28);header.writeUInt16LE(9,30);header.writeUInt16LE(6,32);header.writeUInt32LE(1,44);header.writeUInt32LE(1,48);header.writeUInt32LE(4096,56);header.writeUInt32LE(3,60);header.writeUInt32LE(1,64);header.writeUInt32LE(0xfffffffe,68);for(let p=76;p<512;p+=4)header.writeUInt32LE(0xffffffff,p);header.writeUInt32LE(0,76);fat.fill(0xff);fat.writeUInt32LE(0xfffffffd,0);for(let p=4;p<=12;p+=4)fat.writeUInt32LE(0xfffffffe,p);miniFat.fill(0xff);miniFat.writeUInt32LE(0xfffffffe,0);
 const entry=(at:number,name:string,type:number,start:number,size:number)=>{directory.write(name+'\0',at,'utf16le');directory.writeUInt16LE((name.length+1)*2,at+64);directory[at+66]=type;directory.writeUInt32LE(start,at+116);directory.writeBigUInt64LE(BigInt(size),at+120);};entry(0,'Root Entry',5,2,64);entry(128,'Workbook',2,0,20);
 expect(await inspectBrowserArtifact(bytes,'report.xls',10000)).toMatchObject({status:'supported'});const corrupt=Buffer.from(bytes);corrupt.writeUInt32LE(0,2048);expect(await inspectBrowserArtifact(corrupt,'report.xls',10000)).toMatchObject({status:'quarantined'});expect(await inspectBrowserArtifact(bytes.subarray(0,2300),'report.xls',10000)).toMatchObject({status:'quarantined'});
});
