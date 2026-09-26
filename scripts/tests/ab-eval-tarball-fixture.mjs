import { Buffer } from 'node:buffer';
import { gzipSync } from 'node:zlib';

const makeEntry=(name,content)=>{
  const header=Buffer.alloc(512);
  header.write(name,0,'utf8');
  header.write('0000644\0',100,'ascii');
  header.write('0000000\0',108,'ascii');
  header.write('0000000\0',116,'ascii');
  header.write(content.length.toString(8).padStart(11,'0')+'\0',124,'ascii');
  header.write('00000000000\0',136,'ascii');
  header.fill(32,148,156);
  header.write('0',156,'ascii');
  header.write('ustar\0',257,'ascii');
  header.write('00',263,'ascii');
  const checksum=header.reduce((sum,byte)=>sum+byte,0);
  header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,'ascii');
  return Buffer.concat([header,content,
    Buffer.alloc(Math.ceil(content.length/512)*512-content.length)]);
};

export const makeTarballFixture=(entries={
  'package/package.json':'{"name":"fixture","version":"1.0.0"}\n',
})=>{
  const rows=Object.entries(entries).map(([name,value])=>makeEntry(name,Buffer.from(value)));
  return gzipSync(Buffer.concat([...rows,Buffer.alloc(1024)]));
};
