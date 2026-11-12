import {unpack,preflight,commit} from './core.mjs';
const el = id => document.getElementById(id);
let selected=null, preview=null, busy=false, connected=false;
function status(message,kind='') {el('status').textContent=message;el('status').className=kind;}
function buttons() {el('package').disabled=busy;el('preview').disabled=busy||!connected||!el('package').files.length;el('import').disabled=busy||!preview;}
function forgetPreview() {selected=null;preview=null;el('details').hidden=true;el('import').textContent='Import';buttons();}
el('package').addEventListener('change',()=>{forgetPreview();status('Click Check file & preview.');});
el('preview').addEventListener('click',async()=>{
  if (busy) return; busy=true;preview=null;buttons();const started=performance.now();
  try {
    const file=el('package').files[0];if(!file||file.size>32*1024*1024)throw new Error('Choose a prepared history file smaller than 32 MB.');
    status('Checking the file and existing DSR…');selected=await unpack(await file.text());preview=await preflight(grist.docApi,selected);
    el('period').textContent=selected.registration.Period_Start+' to '+selected.registration.Period_End;
    el('count').textContent=preview.records.toLocaleString('en-US');el('net').textContent=preview.net.toLocaleString('en-US',{style:'currency',currency:'USD'});
    el('source').textContent=selected.registration.Source_File;
    el('gaps').textContent=selected.missing.length?'No source records for '+selected.missing.join(', ')+'. These dates remain under review.':'The source contains records for every date in this period.';
    el('details').hidden=false;el('import').textContent='Import '+preview.records.toLocaleString('en-US')+' records';status('Preview checked. Click Import when ready.');
  } catch(error) {selected=null;preview=null;el('details').hidden=true;status(error.message,'error');}
  finally {busy=false;el('timing').textContent='Preview check: '+((performance.now()-started)/1000).toFixed(1)+' seconds.';buttons();}
});
el('import').addEventListener('click',async()=>{
  if(busy||!preview||!selected)return;
  busy=true;buttons();const started=performance.now(),doc=preview.doc,p=selected;preview=null;
  try {
    status('Rechecking the DSR before import…');const result=await commit(grist.docApi,p,doc,message=>status(message));
    status('Imported and checked '+result.added.toLocaleString('en-US')+' new sales records.','success');
  } catch(error) {status(error.message,'error');}
  finally {busy=false;selected=null;el('timing').textContent+=' Import and saved-data check: '+((performance.now()-started)/1000).toFixed(1)+' seconds.';buttons();}
});
function connect() {
  if(typeof grist==='undefined')status('Open this page as a custom widget inside your Grist DSR.','error');
  else {grist.ready({requiredAccess:'full'});connected=true;status('Choose a prepared history file.');buttons();}
}
if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',connect,{once:true});else connect();
