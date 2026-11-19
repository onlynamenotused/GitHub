/* ---------- Portal sync: every change here is copied to the portal database (Supabase) ---------- */
const SB = "Supabase", SB_PROJECT = "sfuuzcgwbbhdjqzrchvv";
const PS_COLLS = ["newclients","assets","tickets","kb","inventory"];   // order matters: customers -> machines -> tickets
const PS = {hashes:null, live:{}, dirty:new Map(), gone:new Map(), timer:null, busy:false, state:"wait", msg:"", at:"", fails:0};
function psHash(o){ const s=JSON.stringify(o); let h=2166136261; for(let i=0;i<s.length;i++){ h^=s.charCodeAt(i); h=Math.imul(h,16777619); } return (h>>>0).toString(36); }
function psFlag(){
  const b=$("#psFlag"); if(!b) return;
  const n=[...PS.dirty.values()].reduce((a,m)=>a+m.size,0)+[...PS.gone.values()].reduce((a,s)=>a+s.size,0);
  b.dataset.state=PS.state;
  b.textContent = PS.state==="err" ? "Portal: not synced" : n ? `Portal: ${n} to send` : PS.state==="ok" ? "Portal: synced" : "Portal: …";
  b.title = PS.state==="err" ? `Couldn't reach the portal database: ${PS.msg}. Click to retry.` : PS.at ? `Last sent to the portal ${PS.at}. Click to send everything again.` : "Copies tickets, machines, customers, KB and parts to portal.highwaydigital.com.au";
}
// Called from each collection listener with the raw snapshot
function psObserve(coll, snap){
  const docs = {}; snap.docs.forEach(d=>{ docs[d.id]=d.data(); });
  PS.live[coll] = {docs, fresh:!snap.metadata.fromCache};
  psDiff(coll);
}
function psDiff(coll){
  const L=PS.live[coll]; if(!L || !PS.hashes) return;
  const H=PS.hashes[coll]||{};
  const dirty=PS.dirty.get(coll)||new Map(); const gone=PS.gone.get(coll)||new Set();
  for(const [id,data] of Object.entries(L.docs)){ const h=psHash(data); if(H[id]!==h) dirty.set(id,{data,h}); else dirty.delete(id); gone.delete(id); }
  if(L.fresh) for(const id of Object.keys(H)) if(!(id in L.docs)) gone.add(id);   // only trust deletions from a live (non-cache) snapshot
  PS.dirty.set(coll,dirty); PS.gone.set(coll,gone);
  psFlag(); psSchedule();
}
function psSchedule(ms=3000){ clearTimeout(PS.timer); PS.timer=setTimeout(psFlush, ms); }
function psTag(s){ let t; do{ t="ps"+Math.random().toString(36).slice(2,8); }while(s.includes("$"+t+"$")); return t; }
async function psSql(mcp, q){
  const r = await mcp.callTool(SB, "execute_sql", {project_id:SB_PROJECT, query:q});
  const txt = mcpText(r);
  if(r && r.isError) throw new Error(txt.slice(0,200)||"Supabase error");
  if(/"error"|ERROR:/.test(txt) && !/desk_sync|desk_remove/.test(txt)) throw new Error(txt.slice(0,200));
  return txt;
}
async function psFlush(){
  if(PS.busy || !PS.hashes) return;
  const work=PS_COLLS.some(c=>(PS.dirty.get(c)?.size)||(PS.gone.get(c)?.size)); if(!work){ if(PS.state!=="err") PS.state="ok"; psFlag(); return; }
  const mcp = await window.claude?.use?.("mcp").catch(()=>null);
  if(!mcp){ PS.state="err"; PS.msg="the Supabase connector isn't available in this view"; psFlag(); return; }
  PS.busy=true; PS.state="busy"; psFlag();
  try{
    for(const coll of PS_COLLS){
      const dirty=PS.dirty.get(coll); const H=(PS.hashes[coll]=PS.hashes[coll]||{});
      while(dirty && dirty.size){
        const batch=[...dirty.entries()].slice(0,40);
        const json=JSON.stringify(batch.map(([id,x])=>({id, data:x.data})));
        const tag=psTag(json);
        await psSql(mcp, `select public.desk_sync('${coll}', $${tag}$${json}$${tag}$::jsonb) as n;`);
        batch.forEach(([id,x])=>{ H[id]=x.h; dirty.delete(id); });
        psFlag();
      }
      const gone=PS.gone.get(coll);
      for(const id of [...(gone||[])]){
        const tag=psTag(id);
        await psSql(mcp, `select public.desk_remove('${coll}', $${tag}$${id}$${tag}$);`);
        delete H[id]; gone.delete(id);
      }
    }
    await S.db.doc("meta/portalsync").set({hashes:PS.hashes, at:new Date().toISOString()});
    PS.state="ok"; PS.fails=0; PS.at=new Date().toLocaleString("en-AU",{dateStyle:"short",timeStyle:"short"});
  }catch(e){
    PS.state="err"; PS.msg=(e&&e.message)||"unknown error"; PS.fails++;
    psSchedule(Math.min(300000, 15000*2**Math.min(PS.fails,4)));   // retry with back-off, up to 5 min
  }finally{ PS.busy=false; psFlag(); }
}
function psStart(db){
  try{ const st=document.createElement('style'); st.textContent='.psflag{border:0;cursor:pointer;font-family:var(--mono)}.psflag[data-state=ok]{background:var(--ok-soft);color:var(--ok)}.psflag[data-state=err]{background:var(--inc-soft);color:var(--inc)}'; document.head.appendChild(st); }catch(e){}
  db.doc("meta/portalsync").onSnapshot(s=>{
    if(PS.hashes) return;                     // only need it once; afterwards we're the writer
    const d=s.exists?s.data():null; PS.hashes=(d&&d.hashes)||{}; PS.at=d&&d.at?new Date(d.at).toLocaleString("en-AU",{dateStyle:"short",timeStyle:"short"}):"";
    PS_COLLS.forEach(psDiff);
  }, ()=>{ PS.state="err"; PS.msg="couldn't read sync state"; psFlag(); });
  setTimeout(()=>{ const b=$("#psFlag"); if(b) b.onclick=()=>{ if(PS.state!=="err"){ PS.hashes={}; PS_COLLS.forEach(psDiff); toast("Sending everything to the portal"); } PS.fails=0; psFlush(); }; psFlag(); },0);
}

