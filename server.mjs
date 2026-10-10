import http from 'node:http';
import {readFile} from 'node:fs/promises';
import {randomBytes, randomInt} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {questions} from './questions.mjs';

export function createGameServer({questionMs=15000,revealMs=3500}={}) {
 const rooms=new Map();
 const fail=(message,status=400)=>{throw Object.assign(new Error(message),{status});};
 function advance(r){
  const now=Date.now();
  if(r.phase==='question' && (now>=r.deadline || r.players.every(p=>r.answers.has(p.id)))){
   r.phase='reveal';r.deadline=now+revealMs;
  } else if(r.phase==='reveal' && now>=r.deadline){
   r.index++;r.answers=new Map();r.phase=r.index>=10?'finished':'question';r.started=now;r.deadline=now+questionMs;
  }
 }
 function view(r,p){
  advance(r);const q=r.deck?.[r.index];
  return {code:r.code,phase:r.phase,host:r.host===p.id,me:p.id,serverTime:Date.now(),deadline:r.deadline,index:r.index,total:10,
   players:r.players.map(x=>({id:x.id,name:x.name,score:x.score,answered:r.answers.has(x.id)})),
   question:q&&['question','reveal'].includes(r.phase)?{text:q[0],options:q[1]}:null,
   correct:r.phase==='reveal'?q[2]:null,myAnswer:r.answers.get(p.id)?.choice??null};
 }
 const server=http.createServer(async(req,res)=>{
  res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
  try{
   const url=new URL(req.url,'http://localhost');
   if(url.pathname.startsWith('/api/')){
    res.setHeader('Content-Type','application/json; charset=utf-8');
    let b={};
    if(req.method==='POST'){
     if(req.headers.origin && new URL(req.headers.origin).host!==req.headers.host)fail('İstek reddedildi.',403);
     let raw='';for await(const chunk of req){raw+=chunk;if(raw.length>4096)fail('İstek çok büyük.',413);}
     try{b=JSON.parse(raw||'{}');}catch{fail('Geçersiz istek.');}
    }
    if(req.method==='POST'&&['/api/create','/api/join'].includes(url.pathname)){
     const name=typeof b.name==='string'?b.name.trim():'';if(!name||name.length>20)fail('1–20 karakterlik bir ad yaz.');
     let r;
     if(url.pathname==='/api/create'){
      if(rooms.size>=500)fail('Sunucu dolu. Daha sonra tekrar dene.',503);
      let code;do{code=Array.from({length:6},()=> 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[randomInt(32)]).join('');}while(rooms.has(code));
      r={code,players:[],host:null,phase:'lobby',index:0,answers:new Map(),touched:Date.now()};rooms.set(code,r);
     }else{r=rooms.get(String(b.code||'').toUpperCase());if(!r)fail('Oda bulunamadı.',404);if(r.phase!=='lobby')fail('Bu oyun başlamış.');if(r.players.length>=5)fail('Oda dolu (en fazla 5 kişi).');}
     const p={id:randomBytes(8).toString('hex'),token:randomBytes(24).toString('hex'),name,score:0};r.players.push(p);r.host??=p.id;r.touched=Date.now();
     res.end(JSON.stringify({token:p.token,code:r.code,state:view(r,p)}));return;
    }
    const code=req.method==='GET'?url.searchParams.get('code'):b.code;
    const token=req.headers.authorization?.replace(/^Bearer /,'');const r=rooms.get(code);const p=r?.players.find(x=>x.token===token);
    if(!p)fail('Oturum bulunamadı. Yeniden katıl.',401);r.touched=Date.now();advance(r);
    if(req.method==='POST'&&url.pathname==='/api/start'){
     if(r.host!==p.id)fail('Oyunu yalnızca oda sahibi başlatabilir.',403);
     if(!['lobby','finished'].includes(r.phase))fail('Oyun zaten başladı.');
     if(r.players.length<4)fail('Başlamak için en az 4 oyuncu gerekli.');
     r.deck=[...questions];for(let i=r.deck.length-1;i>0;i--){const j=randomInt(i+1);[r.deck[i],r.deck[j]]=[r.deck[j],r.deck[i]];}
     r.deck=r.deck.slice(0,10);r.players.forEach(x=>x.score=0);r.index=0;r.answers=new Map();r.phase='question';r.started=Date.now();r.deadline=r.started+questionMs;
    }else if(req.method==='POST'&&url.pathname==='/api/answer'){
     if(r.phase!=='question'||b.index!==r.index||Date.now()>=r.deadline)fail('Bu sorunun süresi doldu.');
     if(!Number.isInteger(b.choice)||b.choice<0||b.choice>3)fail('Geçersiz cevap.');
     if(r.answers.has(p.id))fail('Cevabını zaten verdin.');
     const points=b.choice===r.deck[r.index][2]?500+Math.round(500*Math.max(0,(r.deadline-Date.now())/questionMs)):0;
     r.answers.set(p.id,{choice:b.choice,points});p.score+=points;
    }else if(!(req.method==='GET'&&url.pathname==='/api/state'))fail('İşlem bulunamadı.',404);
    res.end(JSON.stringify(view(r,p)));return;
   }
   const files={'/':['index.html','text/html; charset=utf-8'],'/app.js':['app.js','text/javascript; charset=utf-8'],'/style.css':['style.css','text/css; charset=utf-8']};
   const file=files[url.pathname];if(!file)fail('Bulunamadı.',404);
   res.setHeader('Content-Type',file[1]);res.end(await readFile(new URL('./public/'+file[0],import.meta.url)));
  }catch(e){res.statusCode=e.status||500;res.setHeader('Content-Type','application/json; charset=utf-8');res.end(JSON.stringify({error:e.status?e.message:'Sunucu hatası.'}));}
 });
 const cleanup=setInterval(()=>{for(const [code,r]of rooms)if(Date.now()-r.touched>2*60*60*1000)rooms.delete(code);},60000);cleanup.unref();server.on('close',()=>clearInterval(cleanup));return server;
}
if(process.argv[1]===fileURLToPath(import.meta.url)){createGameServer().listen(Number(process.env.PORT)||3000,'0.0.0.0',()=>console.log('Bilgi Arena port '+(process.env.PORT||3000)+' üzerinde çalışıyor.'));}
