// Probe 6: TWO producers both matching the predicate, interleaved in
// file order, independent producer_seq spaces. Is the numeric cursor
// still lossless / terminating?
const fs=require('node:fs'),path=require('node:path'),os=require('node:os');
const root = path.resolve(__dirname, '..', '..', '..');
const {createWorkspace}=require(path.join(root,'xtrace-host/src/workspace'));
const {createEvidenceIndex}=require(path.join(root,'xtrace-host/src/evidence-index'));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'arch-cur6-'));
const ws=createWorkspace(tmp);
const dir=path.join(tmp,'traces','cap-two');fs.mkdirSync(dir,{recursive:true});
const ev=(p,seq)=>JSON.stringify({schema_version:3,producer_id:p,process_epoch:'1',
 producer_seq:String(seq),writer_seq:'1',config_generation:'1',mono_time_us:String(seq),
 wall_time_us:String(seq),pid:1,tid:1,category:'reverse',phase:'call',api:'Document.cookie.set',
 args:[],stack:[],attribution:{status:'unresolved'},
 causality:{kind:'singleton',call_id:`s:${seq}`,parent_id:null,depth:0,duration_us:null}});
const lines=[];let a=0,b=0;
for(let i=0;i<30;i++){a++;lines.push(ev('rtx:1:1',a));b++;lines.push(ev('rtw:2:1',b));}
fs.writeFileSync(path.join(dir,'trace.ndjson'),lines.join('\n')+'\n');
fs.writeFileSync(path.join(dir,'trace.manifest.json'),JSON.stringify({schema_version:3,
 capture_id:'cap-two',accounting_model:'2',observation_coverage:'partial',
 terminal:{state:'complete'},counts:{eligible:String(lines.length)},producers:[]}));
const index=createEvidenceIndex(path.join(ws.dir('index'),'index.db'));
const rb=index.rebuildFromDir(path.join(tmp,'traces'));
const id=rb[0].captureId;
const truth=lines.length; // every row matches the api predicate
let cursor=null,sum=0,pages=0;const seen=[];
const t0=Date.now();
for(;;){
  const s=index.scanEvents(id,{fromSeq:cursor,maxRows:3,maxBytes:1<<20,
    predicates:{api:'Document.cookie.set'}});
  sum+=s.rows.length;seen.push(...s.rows.map(r=>`${r.producer_id}#${r.producer_seq}`));
  pages++;
  if(s.window_complete)break;
  const next=s.next_cursor;
  if(next===cursor){console.log(JSON.stringify({verdict:'NON-MONOTONIC CURSOR (same cursor twice)',
    pages,sum,truth,unique:new Set(seen).size,duplicates:seen.length-new Set(seen).size,
    ms:Date.now()-t0}));process.exit(0);}
  cursor=next;
  if(pages>500){console.log(JSON.stringify({verdict:'PAGINATION DID NOT TERMINATE (>500 pages)',
    pages,sum,truth,unique:new Set(seen).size,duplicates:seen.length-new Set(seen).size,
    ms:Date.now()-t0}));process.exit(0);}
}
console.log(JSON.stringify({verdict:sum===truth&&new Set(seen).size===truth?'lossless':'LOSSY/DUPLICATING',
 pages,sum,truth,unique:new Set(seen).size,duplicates:seen.length-new Set(seen).size,
 lost:truth-new Set(seen).size,ms:Date.now()-t0},null,1));
index.close();
