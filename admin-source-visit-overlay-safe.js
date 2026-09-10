(() => {
  'use strict';

  // Safe, idempotent Admin-only overlay for current store name + visit dates.
  // Read-only: no API writes, no photo/upload changes, no backend changes.
  const SOURCE_ID='1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
  const SOURCE_SHEET='STORE IDENTITY & SCHEDULE';
  const CALLBACK='__smfAdminSourceMasterSafeCallback';
  const byLegacyKey=new Map();
  let requested=false;
  let scheduled=false;

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
    x=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/);
    if(x){const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];return `${m[Number(x[1])-1]} ${Number(x[2])}`;}
    return s;
  }
  function setText(node,value){
    if(!node)return;
    const next=String(value??'');
    if(node.textContent!==next)node.textContent=next;
  }
  function cellValue(cell){return cell&&Object.prototype.hasOwnProperty.call(cell,'v')?cell.v:''}

  function apply(){
    scheduled=false;
    const table=document.querySelector('#storeTableWrap table.adminTable');
    if(!table)return;
    const heads=[...table.querySelectorAll('thead th')];
    setText(heads[2],'Scheduled Visit');
    setText(heads[5],'Actual Visit');

    for(const row of table.querySelectorAll('tbody tr.adminStoreRow')){
      const src=byLegacyKey.get(text(row.dataset.key));
      if(!src)continue;
      const cells=row.querySelectorAll('td');
      if(cells.length<6)continue;
      const name=cells[0].querySelector('b');
      if(name&&src.name)setText(name,src.name);
      setText(cells[2],dateText(src.scheduled)||'—');
      setText(cells[5],dateText(src.actual)||'—');
    }
  }
  function scheduleApply(){
    if(scheduled)return;
    scheduled=true;
    setTimeout(apply,0);
  }

  function ingest(resp){
    try{
      if(!resp||resp.status==='error'||!resp.table)return;
      const cols=(resp.table.cols||[]).map(c=>text(c.label));
      const idx={};cols.forEach((h,i)=>{if(h)idx[h]=i});
      const need=['Current Store Name','Scheduled Deployment Date','Actual Visit Date','Legacy Store Key'];
      if(need.some(h=>idx[h]==null))return;
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
      scheduleApply();
    }catch(_){/* never break Admin */}
  }
  window[CALLBACK]=ingest;

  function requestSource(){
    if(requested)return;
    requested=true;
    const s=document.createElement('script');
    const params=new URLSearchParams({sheet:SOURCE_SHEET,tqx:`responseHandler:${CALLBACK}`});
    s.src=`https://docs.google.com/spreadsheets/d/${encodeURIComponent(SOURCE_ID)}/gviz/tq?${params.toString()}&_=${Date.now()}`;
    s.async=true;
    s.referrerPolicy='no-referrer';
    s.onerror=()=>{requested=false};
    document.head.appendChild(s);
  }

  const stores=document.getElementById('tab_stores');
  if(stores)new MutationObserver(scheduleApply).observe(stores,{childList:true,subtree:true});
  document.addEventListener('click',e=>{
    const target=e.target.closest?.('[data-tab="stores"],#adminRefresh');
    if(!target)return;
    requestSource();
    scheduleApply();
  },true);

  requestSource();
  scheduleApply();
})();
