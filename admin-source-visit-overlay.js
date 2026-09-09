(() => {
  'use strict';

  // Admin-only presentation overlay.
  // Reads the public Source Master sheet and overlays management identity/schedule
  // fields onto the Admin store list by immutable Legacy Store Key.
  // It does not write to Sheets, POE, photos, Drive, inventory, or upload code.

  const SOURCE_ID='1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
  const SOURCE_SHEET='STORE IDENTITY & SCHEDULE';
  const CALLBACK='__smfAdminSourceMasterCallback';
  const byLegacyKey=new Map();
  let loaded=false;
  let requested=false;

  function text(v){return v==null?'':String(v).trim()}
  function dateText(v){
    if(v==null||v==='')return '';
    if(v instanceof Date&&!Number.isNaN(v.getTime())){
      const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
      return `${m[v.getMonth()]} ${v.getDate()}`;
    }
    const s=text(v);
    let x=s.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if(x){const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];return `${m[Number(x[2])-1]} ${Number(x[3])}`;}
    x=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    if(x){const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];return `${m[Number(x[1])-1]} ${Number(x[2])}`;}
    return s;
  }

  function cellValue(cell){
    if(!cell)return '';
    if(Object.prototype.hasOwnProperty.call(cell,'v'))return cell.v;
    return '';
  }

  function ingest(resp){
    try{
      if(!resp||resp.status==='error'||!resp.table)return;
      const cols=(resp.table.cols||[]).map(c=>text(c.label));
      const idx={};cols.forEach((h,i)=>{if(h)idx[h]=i});
      const need=['Current Store Name','Scheduled Deployment Date','Actual Visit Date','Legacy Store Key'];
      if(need.some(h=>idx[h]==null))return;
      byLegacyKey.clear();
      for(const r of (resp.table.rows||[])){
        const c=r.c||[];
        const key=text(cellValue(c[idx['Legacy Store Key']]));
        if(!key)continue;
        byLegacyKey.set(key,{
          name:text(cellValue(c[idx['Current Store Name']])),
          scheduled:cellValue(c[idx['Scheduled Deployment Date']]),
          actual:cellValue(c[idx['Actual Visit Date']])
        });
      }
      loaded=true;
      apply();
    }catch(_){/* presentation overlay must never break Admin */}
  }

  window[CALLBACK]=ingest;

  function requestSource(){
    if(requested)return;
    requested=true;
    const s=document.createElement('script');
    const params=new URLSearchParams({sheet:SOURCE_SHEET,tqx:`responseHandler:${CALLBACK}`});
    s.src=`https://docs.google.com/spreadsheets/d/${encodeURIComponent(SOURCE_ID)}/gviz/tq?${params.toString()}`;
    s.async=true;
    s.referrerPolicy='no-referrer';
    s.onerror=()=>{requested=false};
    document.head.appendChild(s);
  }

  function apply(){
    if(!loaded)return;
    const table=document.querySelector('#storeTableWrap table.adminTable');
    if(!table)return;
    const heads=[...table.querySelectorAll('thead th')];
    const dayHead=heads.find(h=>h.textContent.trim()==='Day');
    const completedHead=heads.find(h=>h.textContent.trim()==='Completed');
    if(dayHead)dayHead.textContent='Scheduled Visit';
    if(completedHead)completedHead.textContent='Actual Visit';

    for(const row of table.querySelectorAll('tbody tr.adminStoreRow')){
      const src=byLegacyKey.get(text(row.dataset.key));
      if(!src)continue;
      const cells=row.querySelectorAll('td');
      if(cells.length<6)continue;
      const name=cells[0].querySelector('b');
      if(name&&src.name)name.textContent=src.name;
      cells[2].textContent=dateText(src.scheduled)||'—';
      cells[5].textContent=dateText(src.actual)||'—';
    }
  }

  const run=()=>{requestSource();apply();requestAnimationFrame(apply);setTimeout(apply,50)};
  const stores=document.getElementById('tab_stores');
  if(stores)new MutationObserver(run).observe(stores,{childList:true,subtree:true});
  document.addEventListener('click',e=>{if(e.target.closest('[data-tab="stores"],#adminRefresh'))run()},true);
  run();
})();
