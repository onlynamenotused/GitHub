/* ---------- Parameter files: copy Mimaki parameter CSVs from OneDrive (Client Folders) to the portal ---------- */
// Runs about once a day while the service desk is open. Each file is matched to a machine by the serial in the
// file itself (Info > SERIAL No1-8), not by folder or file name. Customers download them from their machine page.
const PF = {busy:false, msg:""};
function pfParse(text){
  const lines=text.split(/\r?\n/); let model=null, fw=null, hserial=null;
  for(const l of lines.slice(0,40)){ const t=l.trim();
    if(t.startsWith(";") && !t.includes("Upload") && t.length>1) model=t.slice(1).replace("EPL5_","").trim();
    const m=t.match(/<([A-Z]{1,3}\d{2}[A-Z]\d{3,4})/); if(m) hserial=m[1];
    if(t.includes("FW Ver")) fw=t.split(/[,\t]/).pop().trim(); }
  const sec={}; let cur=null;
  for(const l of lines){ const t=l.trim(); if(!t || t.startsWith(";")) continue; const p=t.split(/[,\t]/).map(x=>x.trim());
    if(p.length===1 && /^[A-Za-z][\w ]*$/.test(p[0])){ cur=p[0]; sec[cur]=sec[cur]||{}; continue; }
    if(cur && p.length>=3 && /^\d+$/.test(p[0])){ const n=parseInt(p[2].replace("+",""),10); if(!(p[1] in sec[cur])) sec[cur][p[1]]=isNaN(n)?p[2]:n; } }
  let serial=null;
  for(const name of ["Info", ...Object.keys(sec).filter(k=>k!=="Info")]){ const d=sec[name]||{}; let out="";
    for(let i=1;i<=8;i++){ const v=d["SERIAL No"+i]; if(typeof v!=="number"||v===0||v===32) break;
      if((v>=48&&v<=57)||(v>=65&&v<=90)||(v>=97&&v<=122)) out+=String.fromCharCode(v).toUpperCase(); else { out=""; break; } }
    if(out.length>=6 && /[A-Z]/.test(out)){ serial=out; break; } }
  const k=sec.Ink1||{};
  const md=v=>{ if(typeof v!=="number") return null; const y=v>>9, mo=(v>>5)&15, d=v&31; if(y<10||y>60||mo<1||mo>12||d<1||d>31) return null;
    return `20${String(y).padStart(2,"0")}-${String(mo).padStart(2,"0")}-${String(d).padStart(2,"0")}`; };
  return {serial:serial||hserial, model, fw, param_date: md(k["P.off U"])||md(k["Day Log"])};
}
async function pfRead(mcp, uri){
  let all="", page=1;
  for(let n=0;n<40;n++){
    const t=mcpText(await mcp.callTool(M365,"read_resource",{uri, startPage:page}));
    all += (n?"\n":"") + t;
    const m=/re-call with startPage=(\d+)/.exec(t.slice(-400)); if(!m || +m[1]<=page) break; page=+m[1];
  }
  return all;
}
function pfClean(raw){
  let s=raw; const i=s.indexOf(";Upload"); if(i>0) s=s.slice(i);
  s=s.split(/\r?\n/).filter(l=>!/^\s*\[(page|truncated|Sheets?)\b[^\]]*\]\s*$/i.test(l) && !/^\s*\(?last page\)?\s*$/i.test(l)).join("\r\n");
  return s.replace(/\s+$/,"")+"\r\n";
}
async function pfScan(force){
  if(PF.busy || !S.db) return;
  const meta = await S.db.doc("meta/paramscan").get().then(s=>s.exists?s.data():null).catch(()=>null);
  if(!force && meta && meta.at && Date.now()-new Date(meta.at).getTime() < 20*3600e3) return;
  const mcp = await window.claude?.use?.("mcp").catch(()=>null); if(!mcp) return;
  PF.busy=true;
  try{
    const known = ((pbRows(await psSql(mcp,"select public.desk_files_known() as k;"))[0])||{}).k || {};
    const found=[];
    for(let off=0; off<1000; off+=50){
      const it=mcpItems(await mcp.callTool(M365,"sharepoint_search",{query:"Upload Download File", fileType:"csv", folderName:"Client Folders", limit:50, offset:off}));
      found.push(...it); if(it.length<50) break;
    }
    const seen=new Set(); let added=0, skipped=0;
    for(const f of found){
      const id=f.id || String(f.uri||"").split("/").pop(); if(!id || seen.has(id)) continue; seen.add(id);
      if(!/\.csv$/i.test(f.name||"")) continue;
      const snip=String(f.content||f.summary||"");
      if(snip && !/MecaInfo|Operation|HeadLog|SystemParam/.test(snip)){ skipped++; continue; }   // log files, not parameter files
      if(known[id] && f.lastModifiedDateTime && new Date(known[id]).getTime()===new Date(f.lastModifiedDateTime).getTime()) continue;
      const content=pfClean(await pfRead(mcp, f.uri));
      if(!/\n\s*(Operation|SystemParam|Mainte)\s*\r?\n/.test(content) || content.length>1500000){ skipped++; continue; }
      const doc={id, name:f.name, modified:f.lastModifiedDateTime||null, size:content.length, content, ...pfParse(content)};
      const json=JSON.stringify(doc), tag=psTag(json);
      await psSql(mcp, `select public.desk_file_put($${tag}$${json}$${tag}$::jsonb);`); added++;
    }
    await psSql(mcp, "select public.desk_link_files();");
    await S.db.doc("meta/paramscan").set({at:new Date().toISOString(), found:seen.size, added, skipped});
    if(added) toast(`Parameter files: ${added} copied to the portal`);
    PF.msg="";
  }catch(e){ PF.msg=(e&&e.message)||"parameter file scan failed"; }
  finally{ PF.busy=false; }
}
function pfStart(){ setTimeout(()=>pfScan(false), 20000); setInterval(()=>pfScan(false), 6*3600e3); }
window.pfScan = pfScan;

