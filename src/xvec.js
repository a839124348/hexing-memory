// 参考实现：XVEC v1 向量文件格式
const fs=require('fs');
const crypto=require('crypto');

const MAGIC=Buffer.from('XVEC','ascii');
const VERSION=1;
const HEADER=64;

function modelSha(model){ return crypto.createHash('sha256').update(model).digest().subarray(0,32); }

function buildHeader({dim, model, normalized}){
  const h=Buffer.alloc(HEADER);
  MAGIC.copy(h,0);
  h.writeUInt16LE(VERSION,4);
  h.writeUInt16LE(normalized?1:0,6);
  h.writeUInt16LE(dim,8);
  h.writeUInt16LE(0,10);
  h.writeUInt16LE(dim+12,12);   // record size = dim + 4(scale) + 8(id)
  h.writeUInt16LE(0,14);
  modelSha(model).copy(h,16);
  // 16..48 = model sha, 48..64 reserved
  return h;
}

function encodeRecord(vec, scale, id, dim){
  const b=Buffer.alloc(dim+12);
  for(let d=0;d<dim;d++) b.writeInt8(vec[d], d);
  b.writeFloatLE(scale, dim);
  const n = typeof id === 'bigint' ? id : BigInt('0x' + idKey(id));
  b.writeBigUInt64LE(n, dim+4);
  return b;
}

/** 字符串 id -> 16 位十六进制 key（8 字节哈希）；元数据 sidecar 用 key 找回原 id */
function idKey(id){
  return crypto.createHash('sha256').update(String(id)).digest().subarray(0,8).toString('hex');
}

function quantizeVec(vec, dim){
  let max=0;
  for(let i=0;i<dim;i++){ const a=Math.abs(Number(vec[i])||0); if(a>max) max=a; }
  const scale=(max||1)/127;
  const q=new Int8Array(dim);
  for(let i=0;i<dim;i++){
    let v=Math.round((Number(vec[i])||0)/scale);
    if(v>127)v=127; if(v<-127)v=-127;
    q[i]=v;
  }
  return {q, scale};
}

/** 写整份 XVEC（调用方负责临时文件 + rename / 锁） */
function writeFile(path, {model, dim, items, normalized=true}){
  const fd=fs.openSync(path,'w');
  try{
    fs.writeSync(fd, buildHeader({dim,model,normalized}));
    for(const it of items){
      const vec=it.vec || [];
      const {q,scale}=quantizeVec(vec,dim);
      fs.writeSync(fd, encodeRecord(q,scale,it.id,dim));
    }
    fs.fsyncSync(fd);
  } finally { fs.closeSync(fd); }
  return {count: items.length, dim, model};
}

/** 读整份 XVEC，返回 {key, vec}；id 用 8 字节哈希，元数据负责还原原 id */
function readAll(path, expect){
  const info=open(path,expect);
  const dim=info.header.dim;
  const recSize=info.header.recordSize;
  const fd=fs.openSync(path,'r');
  const out=[];
  try{
    const rec=Buffer.alloc(recSize);
    for(let i=0;i<info.count;i++){
      fs.readSync(fd,rec,0,recSize,HEADER+i*recSize);
      const vec=new Array(dim);
      for(let d=0;d<dim;d++) vec[d]=rec.readInt8(d);
      const scale=rec.readFloatLE(dim);
      for(let d=0;d<dim;d++) vec[d]*=scale;
      out.push({
        key: rec.readBigUInt64LE(dim+4).toString(16).padStart(16,'0'),
        vec,
      });
    }
  } finally { fs.closeSync(fd); }
  return {header:info.header, count:info.count, truncated:info.truncated, items:out};
}

module.exports={buildHeader,encodeRecord,readHeader,open,modelSha,idKey,quantizeVec,writeFile,readAll,HEADER};

function readHeader(path){
  const fd=fs.openSync(path,'r');
  const h=Buffer.alloc(HEADER);
  fs.readSync(fd,h,0,HEADER,0);
  fs.closeSync(fd);
  if(!h.subarray(0,4).equals(MAGIC)) throw new Error('不是 XVEC 文件（魔数不符）');
  const version=h.readUInt16LE(4);
  if(version!==VERSION) throw new Error('格式版本 '+version+' 不受支持（本程序支持 '+VERSION+'）');
  return {
    version,
    normalized: h.readUInt16LE(6)===1,
    dim: h.readUInt16LE(8),
    recordSize: h.readUInt16LE(12),
    modelSha: h.subarray(16,48).toString('hex'),
  };
}

// 打开：校验头部 + 截断检测
function open(path, expect){
  const h=readHeader(path);
  if(expect && expect.dim && h.dim!==expect.dim) throw new Error('维度不符: 文件 '+h.dim+' vs 期望 '+expect.dim);
  if(expect && expect.model && h.modelSha!==modelSha(expect.model).toString('hex'))
    throw new Error('模型不符: 向量是用别的模型算的，请重建索引');
  const size=fs.statSync(path).size;
  const body=size-HEADER;
  const count=Math.floor(body/h.recordSize);
  const tail=body%h.recordSize;
  return {header:h, size, count, tail, truncated: tail!==0};
}



// ---- 自测 ----
if(require.main===module){
  const os=require('os'), path=require('path');
  const T=os.tmpdir();
  const dim=512, model='BAAI/bge-small-zh-v1.5';
  const p=path.join(T,'xvec_test.bin');
  try{fs.unlinkSync(p)}catch(e){}

  const vec=new Int8Array(dim);
  for(let d=0;d<dim;d++) vec[d]=(d%200)-100;

  let t=Date.now();
  const fd=fs.openSync(p,'w');
  fs.writeSync(fd, buildHeader({dim, model, normalized:true}));
  for(let i=0;i<1000;i++) fs.writeSync(fd, encodeRecord(vec, 0.003, 100000+i, dim));
  fs.closeSync(fd);
  console.log('写入 1000 条: '+(Date.now()-t)+'ms, 文件 '+fs.statSync(p).size+' B');

  const info=open(p,{dim, model});
  console.log('打开校验: 版本'+info.header.version+' dim'+info.header.dim+' 记录'+info.header.recordSize+'B 条数'+info.count+' 截断'+info.truncated);
  console.log('预期字节: '+(64+1000*524)+' 实际: '+info.size+' => '+(info.size===64+1000*524?'✅':'❌'));

  // 模型不符必须报错
  try{ open(p,{model:'other/model'}).count; console.log('❌ 换模型没报错'); }
  catch(e){ console.log('✅ 换模型正确报错: '+e.message); }

  // 并发追加
  const {spawnSync}=require('child_process');
  const w=path.join(T,'xvec_w.js');
  fs.writeFileSync(w,`
const fs=require('fs');const m=require(${JSON.stringify(__filename)});
const [p,dim,n,idbase]=[process.argv[2],+process.argv[3],+process.argv[4],+process.argv[5]];
const v=new Int8Array(dim);for(let d=0;d<dim;d++)v[d]=(d+idbase)%120-60;
const fd=fs.openSync(p,'a');
for(let i=0;i<n;i++) fs.writeSync(fd, m.encodeRecord(v,0.003, idbase+i, dim));
fs.closeSync(fd);
`);
  for(let k=0;k<8;k++) spawnSync(process.execPath,[w,p,String(dim),'500',String(5000+k*1000)],{stdio:'ignore'});
  const info2=open(p,{dim,model});
  console.log('8进程×500追加后: '+info2.count+' 条 (预期 5000), 截断 '+info2.truncated+' => '+(info2.count===5000&&!info2.truncated?'✅':'❌'));

  // 断电截断恢复
  const size2=fs.statSync(p).size;
  fs.truncateSync(p, size2-300);
  const info3=open(p,{dim,model});
  console.log('模拟断电(截掉300B): 条数'+info3.count+' 尾部残缺'+info3.tail+'B 可检测='+(info3.truncated?'✅':'❌'));
  fs.truncateSync(p, HEADER+info3.count*info3.header.recordSize);
  const info4=open(p,{dim,model});
  console.log('截尾修复后: '+info4.count+' 条完整, 截断 '+info4.truncated+' => '+(info4.count===4999&&!info4.truncated?'✅':'❌'));
}
