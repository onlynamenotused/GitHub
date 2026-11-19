/* ---------- Portal bookings: publish free times to the portal, turn portal bookings into tickets ---------- */
const PB = {lastPub:0, busy:false, lastNum:0, msg:""};
const PB_HOURS = [2, 4.5];   // fault visit, service/installation visit
const PB_KIND = {service:{type:"request",subtype:"pm",label:"PM service"}, install:{type:"request",subtype:"installation",label:"Installation"}, fault:{type:"incident",subtype:"",label:"Incident"}};
function pbRows(txt){
  let s = txt; try{ const o=JSON.parse(txt); if(o && typeof o.result==="string") s=o.result; }catch(e){}
  const m = s.match(/<untrusted-data-[^>]+>\s*(\[[\s\S]*?\])\s*<\/untrusted-data/); if(m) s=m[1];
  else { const i=s.indexOf("[{"), j=s.lastIndexOf("}]"); if(i>=0 && j>i) s=s.slice(i,j+2); }
  try{ return JSON.parse(s); }catch(e){ PB.msg="Couldn't read the portal's reply"; return []; }
}
function pbLocal(iso){ const p=new Date(new Date(iso).getTime()+8*3600e3).toISOString(); return {d:p.slice(0,10), m:hm2m(p.slice(11,16))}; }
const pbIso=(d,m)=>`${d}T${m2hm(m)}:00+08:00`;
async function pbMake(mcp, b){
  const done=(st,num,note)=>psSql(mcp, `select public.desk_booking_done(${+b.id}, '${st}', ${num?+num:"null"}, $pbn$${String(note||"").replace(/\$/g,"")}$pbn$);`);
  const had=S.tickets.find(t=>t.portalBooking===b.id);
  if(had) return done(had.schedDate?"booked":"clash", had.num||+had.id, "");
  const a=pbLocal(b.start), z=pbLocal(b.end), slot={d:a.d, s:a.m, e:z.m}, hrs=(z.m-a.m)/60;
  let clash="";
  try{ const c=clashes(slot,[...await outlookBusy(a.d,a.d), ...deskBusy()],0); if(c.length) clash=c[0].why; }
  catch(e){ clash="Outlook couldn't be checked"; }
  const k=PB_KIND[b.kind]||PB_KIND.service;
  const num=Math.max(nextNum(), PB.lastNum+1); PB.lastNum=num;
  const when=`${fmtDay(a.d)} ${fmtTime(m2hm(a.m))}`;
  const doc={num, customer:b.client_name, clientId:(+b.client_id<9000000?+b.client_id:null), newClientId:(/^NC-/.test(b.desk_ref||"")?b.desk_ref:null),
    assetId:b.machine_id||"", brand:b.brand||"", model:b.model||"", type:k.type, subtype:k.subtype,
    summary:`${b.client_name} / ${b.model||"machine"} / ${k.label}`, description:b.description||"", errorCode:"",
    status:"new", created:todayStr(), channel:"portal", source:"Booked in the customer portal", portalBooking:b.id,
    contactInfo:{contact:b.contact||"", phone:b.phone||"", email:b.email||"", src:"Portal booking", fetched:todayStr()},
    notes: clash ? `Customer picked ${when} in the portal, but it now clashes with: ${clash}. Not booked: arrange another time with the customer.` : `Customer booked ${when} in the portal.`,
    lines:[], linked:[], sample:false, schedHours:hrs};
  await S.db.doc("tickets/"+num).set(doc);
  if(!clash) await bookTicket({id:String(num), ...doc}, {schedDate:a.d, schedTime:m2hm(a.m), schedHours:hrs});
  await done(clash?"clash":"booked", num, clash?"We'll be in touch to arrange another time.":"");
  toast(`Portal booking from ${b.client_name}: ticket ${num}${clash?" (time clashes – not booked)":" booked for "+when}`);
}
async function pbTick(force){
  if(PB.busy || !PS.hashes || !(S.loaded&&S.loaded.tickets)) return;
  const mcp = await window.claude?.use?.("mcp").catch(()=>null); if(!mcp) return;
  PB.busy=true;
  try{
    const rows=pbRows(await psSql(mcp, "select public.desk_pending_bookings() as j;"));
    const list=(rows[0]&&rows[0].j)||[];
    for(const b of list){ try{ await pbMake(mcp,b); }catch(e){ PB.msg="Booking "+b.id+": "+((e&&e.message)||e); } }
    if(force || list.length || Date.now()-PB.lastPub > 30*60e3){
      const set=bkSet(), from=todayStr(), to=addDays(from, (+set.horizonDays||21)+(+set.leadDays||1)+14);
      const busy=[...await outlookBusy(from,to), ...deskBusy()], slots=[];
      for(const h of PB_HOURS) findSlots(busy,h,40,{horizon:+set.horizonDays||21}).forEach(s=>slots.push({start:pbIso(s.d,s.s), end:pbIso(s.d,s.e), hours:h}));
      const json=JSON.stringify(slots), tag=psTag(json);
      await psSql(mcp, `select public.desk_publish_slots($${tag}$${json}$${tag}$::jsonb) as n;`);
      PB.lastPub=Date.now(); PB.msg="";
    }
  }catch(e){ PB.msg=(e&&e.message)||"portal booking check failed"; }
  finally{ PB.busy=false; }
}
function pbStart(){ setTimeout(()=>pbTick(true), 8000); setInterval(()=>pbTick(false), 120000); }

