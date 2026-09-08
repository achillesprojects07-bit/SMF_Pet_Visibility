(() => {
  'use strict';

  // Admin interaction-only guard. Prevents accidental text/drag selection across
  // dynamic dashboard/table UI while preserving intentional selection in notes,
  // codes and form controls. No API calls and no data writes.
  const ALLOW='input,textarea,select,.userCode,.storeDetail p,.allowTextSelection';
  const inAdmin=target=>Boolean(target?.closest?.('#adminApp'));
  const allowed=target=>Boolean(target?.closest?.(ALLOW));

  document.addEventListener('selectstart',e=>{
    if(inAdmin(e.target)&&!allowed(e.target))e.preventDefault();
  },true);

  document.addEventListener('dragstart',e=>{
    if(inAdmin(e.target)&&!allowed(e.target))e.preventDefault();
  },true);

  // Safari/WebKit can retain an accidental selection after a drag gesture even
  // when later movement is harmless. Clear only non-editable Admin selections.
  document.addEventListener('pointerup',e=>{
    if(!inAdmin(e.target)||allowed(e.target))return;
    const s=window.getSelection?.();
    if(s&&!s.isCollapsed)s.removeAllRanges();
  },true);
})();
