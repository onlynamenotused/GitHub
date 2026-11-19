/* ---------- FreshBooks invoices & estimates to the portal (summary only: date, number, reference, status) ---------- */
// Every 3 hours while the service desk is open. Drafts are never sent. Last 2 years only.
const FBS = {busy:false, last:0, msg:""};
function fbsInvStatus(v){
  const p=String(v.payment_status||"").toLowerCase(), d=String(v.dispute_status||"").toLowerCase();
  if(d && d!=="null" && d!=="none") return "disputed";
  if(p==="paid") return "paid";
  if(v.is_overdue) return "overdue";
  if(p==="partial") return "partial";
  return "unpaid";
}
async function fbsCollect(mcp, kind, since){
  const tool=await fbTool(mcp, kind==="invoices"?"list_invoices":"list_estimates");
  const meta={intent:"Service desk: copy invoice/estimate summaries to the customer portal", correlation_id:"hd-portal-fb-"+todayStr()};
  const rows=[];
  for(let page=1; page<=40; page++){
    const r=fbJson(await mcp.callTool(FB, tool, {fb_meta:meta, business_uuid:FB_BIZ, page, per_page:100}));
    const list=(kind==="invoices"?r.invoices:r.estimates)||[]; if(!list.length) break;
    for(const v of list){
      if(String(v.create_date||"")<since) continue;
      if(kind==="invoices"){
        if(String(v.display_status||"").toLowerCase()==="draft" || !v.client) continue;
        rows.push({id:v.invoice_id, client_id:v.client.client_id, number:v.invoice_number, issued:v.create_date, due:v.due_date||"", reference:v.po_number||"", status:fbsInvStatus(v)});
      } else {
        const st=String(v.status||"").toLowerCase(); if(!st || st==="draft" || !v.client_id) continue;
        rows.push({id:v.estimate_id, client_id:v.client_id, number:v.estimate_number, issued:v.create_date, reference:v.po_number||"", status:st});
      }
    }
    if(page>=(r.total_pages||1)) break;
  }
  return rows;
}
async function fbsSync(force){
  if(FBS.busy || (!force && Date.now()-FBS.last < 3*3600e3)) return;
  const mcp = await window.claude?.use?.("mcp").catch(()=>null); if(!mcp) return;
  FBS.busy=true;
  try{
    const since=addDays(todayStr(), -730);
    for(const kind of ["invoices","estimates"]){
      const rows=await fbsCollect(mcp, kind, since);
      const json=JSON.stringify(rows), tag=psTag(json);
      await psSql(mcp, `select public.desk_fb_put('${kind}', $${tag}$${json}$${tag}$::jsonb, '${since}'::date);`);
    }
    FBS.last=Date.now(); FBS.msg="";
  }catch(e){ FBS.msg=(e&&e.message)||"FreshBooks copy failed"; }
  finally{ FBS.busy=false; }
}
function fbsStart(){ setTimeout(()=>fbsSync(true), 30000); setInterval(()=>fbsSync(false), 30*60e3); }
window.fbsSync = fbsSync;

