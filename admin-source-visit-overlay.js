(() => {
  'use strict';

  // Admin-only presentation overlay.
  // Source Master remains the management truth for store identity/schedule/actual visit.
  // The embedded snapshot is an immediate deterministic fallback if Google gviz is slow
  // or blocked; live gviz replaces it when available. No writes are performed here.

  const SOURCE_ID='1_qtlUdaytLA_zR03rqBh8RYP-MWjYKVaRoABZvYFBlg';
  const SOURCE_SHEET='STORE IDENTITY & SCHEDULE';
  const CALLBACK='__smfAdminSourceMasterCallback';
  const byLegacyKey=new Map();
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
    x=s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})(?:\s.*)?$/);
    if(x){const m=['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];return `${m[Number(x[1])-1]} ${Number(x[2])}`;}
    return s;
  }

  // Deterministic current snapshot for Team 2. This prevents blank/wrong dates when
  // the public Google Visualization endpoint is cached or temporarily unavailable.
  const FALLBACK=[
    ['Team 2|Sept 2|1|Kap\'s Trading Corp','Kap\'s Trading Corp','2026-09-02','2026-09-03'],
    ['Team 2|Sept 2|2|ASJ Pet Food Supply','ASJ Pet Food Supply','2026-09-02','2026-09-03'],
    ['Team 2|Sept 2|3|TML Tradings Corp','TML Tradings Corp','2026-09-02','2026-09-09'],
    ['Team 2|Sept 2|4|MTB Minimart Pet Supply','MTB Minimart Pet Supply','2026-09-02','2026-09-03'],
    ['Team 2|Sept 2|5|GOLDEN FUR VETERINARY CENTER','GOLDEN FUR VETERINARY CENTER','2026-09-02','2026-09-03'],
    ['Team 2|Sept 2|6|Joseph and Angela Petshop','Joseph and Angela Petshop','2026-09-02','2026-09-03'],
    ['Team 2|Sept 3|7|102 Petshop & Grooming','102 Petshop & Grooming','2026-09-03','2026-09-05'],
    ['Team 2|Sept 3|8|Eagle Stag Agrivet Supplies','King & Leon Poultry and Pet Supply','2026-09-03','2026-09-03'],
    ['Team 2|Sept 3|9|Farmer Ponce Poultry Supply','Farmer Ponce Poultry Supply','2026-09-03','2026-09-05'],
    ['Team 2|Sept 3|10|Four Nels Poultry Supply','Four Nels Poultry Supply','2026-09-03','2026-09-05'],
    ['Team 2|Sept 3|11|Marvic Mielle Pet Supplies','Marvic Mielle Pet Supplies','2026-09-03','2026-09-05'],
    ['Team 2|Sept 3|12|Famous Breeds Pet Supply','Famous Breeds Pet Supply','2026-09-03','2026-09-05'],
    ['Team 2|Sept 4|13|Dans General Merchandise','Dans General Merchandise','2026-09-04','2026-09-06'],
    ['Team 2|Sept 4|14|DMS Trading','DMS Trading','2026-09-04','2026-09-06'],
    ['Team 2|Sept 4|15|JKP Trading P/S','JKP Trading P/S','2026-09-04','2026-09-07'],
    ['Team 2|Sept 4|16|AJ Chloe Petshop','Mommy Yoona pet supplies Acc','2026-09-04','2026-09-09'],
    ['Team 2|Sept 4|17|CENTRAL PET STATION ANIMAL PET CLINIC','A.D.C Petshop','2026-09-04','2026-09-07'],
    ['Team 2|Sept 5|18|Fourpaws Veterinary And Grooming Clinic','Fourpaws Veterinary And Grooming Clinic','2026-09-05','2026-09-06'],
    ['Team 2|Sept 5|19|Blue Fin Pet Grooming And Veterinary Clinic','Blue Fin Pet Grooming And Veterinary Clinic','2026-09-05','2026-09-08'],
    ['Team 2|Sept 5|20|Mount Sinai Veterinary Practice','Mount Sinai Veterinary Practice','2026-09-05','2026-09-06'],
    ['Team 2|Sept 5|21|Pink Farm 24 Hour Pet Grooming And Veterinary Clinic','Pink Farm 24 Hour Pet Grooming And Veterinary Clinic','2026-09-05','2026-09-08'],
    ['Team 2|Sept 7|22|Pv Manimal Shelter Veterinary Clinic','Pv Manimal Shelter Veterinary Clinic','2026-09-07','2026-09-08'],
    ['Team 2|Sept 7|23|Censig Vet Pet Grooming And Veterinary Clinic','Censig Vet Pet Grooming And Veterinary Clinic','2026-09-07','2026-09-08'],
    ['Team 2|Sept 7|24|Petshield Veterinary Clinic And Grooming Center','Petshield Veterinary Clinic And Grooming Center','2026-09-07','2026-09-08'],
    ['Team 2|Sept 7|25|Dvm Animal Clinic','Dvm Animal Clinic','2026-09-07','2026-09-08'],
    ['Team 2|Sept 7|26|Moksha Pet by Shaira','Moksha Pet by Shaira','2026-09-07','2026-09-08'],
    ['Team 2|Sept 8|27|Pet Wise Ph','Pet Wise Ph','2026-09-08','2026-09-09'],
    ['Team 2|Sept 8|28|R Maneja','R Maneja','2026-09-08','2026-09-09'],
    ['Team 2|Sept 8|29|JVC Store','JVC Store','2026-09-08','2026-09-09'],
    ['Team 2|Sept 8|30|R&A Poultry Supply','R&A Poultry Supply','2026-09-08','2026-09-09'],
    ['Team 2|Sept 8|31|Luzon Coop - Ayala Alabang','Luzon Coop - Ayala Alabang','2026-09-08','2026-09-09'],
    ['Team 2|Sept 9|32|Princess J Minimart','Princess J Minimart','2026-09-09','2026-09-05'],
    ['Team 2|Sept 9|33|Golden Pet Home','Golden Pet Home','2026-09-09','2026-09-05'],
    ['Team 2|Sept 9|34|Farm To Table Meatshop','Farm To Table Meatshop','2026-09-04','2026-09-06'],
    ['Team 2|Sept 9|35|Ka Keki Store','Ka Keki Store','2026-09-09','2026-09-06'],
    ['Team 2|Sept 9|36|Nics Consumer Goods Trading','Nics Consumer Goods Trading','2026-09-04','2026-09-06'],
    ['Team 2|Sept 9|37|Carmelite Minimart','Carmelite Minimart','2026-09-09','2026-09-06'],
    ['Team 2|Sept 9|38|Kerchin Convenience Store','Kerchin Convenience Store','2026-09-04','2026-09-06'],
    ['Team 2|Sept 9|39|Washington Food Hub','Washington Food Hub','2026-09-09','2026-09-06'],
    ['Team 2|Sept 10|40|Atoy\'S Pet Shop & Feeds Store','Atoy\'S Pet Shop & Feeds Store','2026-09-10',''],
    ['Team 2|Sept 10|41|Calle Real Mini Grocery','Calle Real Mini Grocery','2026-09-10','2026-09-09'],
    ['Team 2|Sept 10|42|Mighty Waggers Pet Shop','Mighty Waggers Pet Shop','2026-09-10','2026-09-09'],
    ['Team 2|Sept 10|43|Wolf moon Pet shop','Wolf moon Pet shop','2026-09-10','2026-09-09'],
    ['Team 2|Sept 10|44|Feather and Fur Pet Shop','Feather and Fur Pet Shop','2026-09-10','2026-09-09'],
    ['Team 2|Sept 10|45|Rhinoa\'s Poultry Supply','Rhinoa\'s Poultry Supply','2026-09-10','2026-09-09'],
    ['Team 2|Sept 10|46|Roy Poultry Supply','Roy Poultry Supply','2026-09-10','2026-09-09'],
    ['Team 2|Sept 10|47|Delton Poultry Supply','Delton Poultry Supply','2026-09-10','2026-09-09']
  ];
  for(const [key,name,scheduled,actual] of FALLBACK)byLegacyKey.set(key,{name,scheduled,actual});

  function cellValue(cell){return cell&&Object.prototype.hasOwnProperty.call(cell,'v')?cell.v:''}
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
      apply();
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

  function apply(){
    const table=document.querySelector('#storeTableWrap table.adminTable');
    if(!table)return;
    const heads=[...table.querySelectorAll('thead th')];
    if(heads[2])heads[2].textContent='Scheduled Visit';
    if(heads[5])heads[5].textContent='Actual Visit';

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

  const run=()=>{apply();requestSource();requestAnimationFrame(apply);setTimeout(apply,60);setTimeout(apply,250)};
  const stores=document.getElementById('tab_stores');
  if(stores)new MutationObserver(run).observe(stores,{childList:true,subtree:true});
  document.addEventListener('click',e=>{if(e.target.closest('[data-tab="stores"],#adminRefresh'))run()},true);
  run();
})();
