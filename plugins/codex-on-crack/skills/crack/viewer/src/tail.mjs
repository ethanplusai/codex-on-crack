import fs from 'node:fs/promises';
import {realpathSync} from 'node:fs';
import path from 'node:path';
import {Adapter} from './adapter.mjs';
export class Tail {
 constructor(file,index,details,normalized=false){this.normalized=normalized;this.file=file;try{this.file=path.join(realpathSync(path.dirname(file)),path.basename(file));}catch{}this.index=index;this.details=details;this.reset();this.status='Waiting'}
 reset(){this.adapter=new Adapter({source:`source-${this.index}`,details:this.details,normalized:this.normalized});this.offset=0;this.pending=Buffer.alloc(0);this.line=0;this.ino=null;this.discard=false}
 async poll(){
  let handle;
  try{
   if(await fs.realpath(this.file)!==this.file)throw Error('Source path changed');
   handle=await fs.open(this.file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);const st=await handle.stat();if(!st.isFile())throw Error('Not a file');
   if(this.ino!==null&&(st.ino!==this.ino||st.size<this.offset))this.reset();this.ino=st.ino;
   let budget=8*1024*1024;
   while(this.offset<st.size&&budget>0){const length=Math.min(256*1024,st.size-this.offset,budget);const b=Buffer.alloc(length);const {bytesRead}=await handle.read(b,0,length,this.offset);if(!bytesRead)break;this.offset+=bytesRead;budget-=bytesRead;
    const chunk=Buffer.concat([this.pending,b.subarray(0,bytesRead)]);let start=0,end;
    while((end=chunk.indexOf(10,start))!==-1){this.line++;const line=chunk.subarray(start,end);if(!this.discard&&line.length){try{this.adapter.ingest(JSON.parse(line.toString('utf8')),this.line)}catch{this.adapter.errors++}}this.discard=false;start=end+1}
    this.pending=chunk.subarray(start);if(this.pending.length>8*1024*1024){this.pending=Buffer.alloc(0);this.discard=true;this.adapter.errors++}
   }
   this.status=this.offset<st.size?'Loading':'Watching';this.checkedAt=new Date().toISOString();
  }catch{this.status='Unavailable'}finally{await handle?.close()}
 }
}
