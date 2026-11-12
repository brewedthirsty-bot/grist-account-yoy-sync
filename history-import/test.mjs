import test from 'node:test';
import assert from 'node:assert/strict';
import {SALES,IMPORTS,dateSeconds,validate,unpack,preflight,actions,commit} from './core.mjs';
const copy=x=>structuredClone(x);
const columnar=rows=>Object.fromEntries([...new Set(['id',...rows.flatMap(Object.keys)])].map(k=>[k,rows.map(r=>r[k])]));
function fixture(missing=false) {
  const row=['history:'+'a'.repeat(32),'2020-07-01','example-key','','',1.25,9,10,1,1,0.72,0,-2,'toast:fishers:legacy-name:2020-Q3',2,2,null];
  const registration={Source_Key:row[13],Source_File:'synthetic-example.csv',Period_Start:'2020-07-01',Period_End:missing?'2020-07-02':'2020-07-01',Location:'Fishers Nickel Plate District',Raw_Rows:2,Eligible_Selections:null,Excluded_Rows:1,Void_Rows:null,Deferred_Rows:null,Daily_Sales_Rows:1,Quantity:1.25,Item_Net_Sales:9,Dates_Without_Records:missing?'2020-07-02':'',Source_Encoding:'utf-8',Source_SHA256:'b'.repeat(64)};
  const p={version:1,columns:[...SALES],rows:[row],registration,totals:{Quantity:1.25,Net_Sales:9,Gross_Sales:10,Toast_Discount_Field:1,Refund_Amount:0,Tax:0.72,Void_Amount:-2},baseline:{sales_rows:1,import_rows:1,net:10,quantity:2}};
  const tables=[{id:1,tableId:'Daily_Sales'},{id:2,tableId:'Imports'}];
  const numeric=new Set(['Quantity','Net_Sales','Gross_Sales','Gross_Less_Net','Toast_Discount_Field','Tax','Refund_Amount','Void_Amount','First_CSV_Row','Last_CSV_Row','Source_Selections','Raw_Rows','Eligible_Selections','Excluded_Rows','Void_Rows','Deferred_Rows','Daily_Sales_Rows','Item_Net_Sales']);
  const dates=new Set(['Source_Business_Date','Period_Start','Period_End']);
  const columns=[];
  for(const [i,fields]of [SALES,IMPORTS].entries())for(const colId of fields)columns.push({id:columns.length+1,parentId:i+1,colId,isFormula:false,type:dates.has(colId)?'Date':numeric.has(colId)?'Numeric':'Text'});
  const old={...registration,id:1,Source_Key:'toast:fishers:legacy-name:2020-Q2',Period_Start:dateSeconds('2020-06-30'),Period_End:dateSeconds('2020-06-30'),Quantity:2,Item_Net_Sales:10};
  const calendar=[{id:1,Date:dateSeconds('2020-07-01'),Has_Item_Records:false,Sales_Data_Loaded:false,Day_Review_Reason:'',Item_Net_Sales:null}];
  if(missing)calendar.push({id:2,Date:dateSeconds('2020-07-02'),Has_Item_Records:false,Sales_Data_Loaded:false,Day_Review_Reason:'No source records',Item_Net_Sales:null});
  const data={Imports:[old],Calendar:calendar,Items:[{id:1,Item_Key:'example-key'}],_grist_Tables:tables,_grist_Tables_column:columns};
  const existing={id:1,Daily_Key:'existing-untouched',Source_Business_Date:dateSeconds('2020-06-30'),Net_Sales:10,Quantity:2,Manual_Notes:'Keep this note'};
  const api={doc:'synthetic-dsr',writes:[],facts:[copy(existing)],async getDocName(){return this.doc;},async fetchTable(name){return columnar(data[name]);},async applyUserActions(list,options){
    this.writes.push({list:copy(list),options});
    assert.equal(list.length,2);assert.equal(list[0][0],'BulkAddOrUpdateRecord');assert.equal(list[1][0],'AddOrUpdateRecord');
    const a=list[0], n=a[2].Daily_Key.length, ids=[];
    for(let i=0;i<n;i++) { const r={Daily_Key:a[2].Daily_Key[i],...Object.fromEntries(Object.entries(a[3]).map(([k,v])=>[k,v[i]]))};
      if(!this.facts.some(x=>x.Daily_Key===r.Daily_Key)){r.id=this.facts.length+1;this.facts.push(r);ids.push(r.id);}
    }
    const s=list[1];data.Imports.push({...s[2],...s[3],id:data.Imports.length+1});
    for(const d of data.Calendar){d.Sales_Data_Loaded=true;const matched=this.facts.filter(r=>r.Source_Business_Date===d.Date);d.Has_Item_Records=matched.length>0;d.Item_Net_Sales=matched.length?matched.reduce((sum,r)=>sum+r.Net_Sales,0):null;}
    return {retValues:[{addRecordIds:ids,updateRecordIds:[],recordIds:ids.map(id=>[id])},{recordIds:[data.Imports.length],action:'ADD'}]};
  }};
  return {raw:p,parsed:validate(p),api,data,existing};
}
test('preserves fractional quantity, negative void and null historical counts',()=>{
  const x=fixture();assert.equal(x.parsed.records[0].Quantity,1.25);assert.equal(x.parsed.records[0].Void_Amount,-2);assert.equal(x.parsed.records[0].Source_Selections,null);
});
test('rejects nonexistent dates and dates outside the source window',()=>{
  assert.throws(()=>dateSeconds('2020-02-30'));
  const x=fixture();x.raw.rows[0][1]='2020-08-01';assert.throws(()=>validate(x.raw),/outside/);
});
test('rejects duplicate daily keys',()=>{const x=fixture();x.raw.rows.push(copy(x.raw.rows[0]));x.raw.registration.Daily_Sales_Rows=2;x.raw.registration.Raw_Rows=3;assert.throws(()=>validate(x.raw),/Duplicate/);});
test('rejects an invented historical selection count',()=>{const x=fixture();x.raw.rows[0][16]=0;assert.throws(()=>validate(x.raw),/unknown/);});
test('rejects a changed amount or false source total',()=>{
  const x=fixture();x.raw.rows[0][6]=9.01;assert.throws(()=>validate(x.raw),/Net-sales/);
  const y=fixture();y.raw.totals.Net_Sales=10;assert.throws(()=>validate(y.raw),/Net_Sales/);
});
test('checks the package SHA256 before trusting its data',async()=>{
  const x=fixture(),payload_json=JSON.stringify(x.raw);
  await assert.rejects(()=>unpack(JSON.stringify({format:'fdr-dsr-history/1',payload_json,payload_sha256:'0'.repeat(64)})),/checksum/);
  const digest=await crypto.subtle.digest('SHA-256',new TextEncoder().encode(payload_json));
  const hash=Buffer.from(digest).toString('hex');assert.equal((await unpack(JSON.stringify({format:'fdr-dsr-history/1',payload_json,payload_sha256:hash}))).records.length,1);
});
test('previews from small control tables without fetching Daily_Sales',async()=>{
  const x=fixture(),seen=[],fetch=x.api.fetchTable.bind(x.api);x.api.fetchTable=async name=>{seen.push(name);return fetch(name);};
  assert.equal((await preflight(x.api,x.parsed)).records,1);assert(!seen.includes('Daily_Sales'));assert.equal(x.api.writes.length,0);
});
test('blocks an already imported source before any write',async()=>{const x=fixture();x.data.Imports[0].Source_Key=x.parsed.registration.Source_Key;await assert.rejects(()=>preflight(x.api,x.parsed),/already registered/);assert.equal(x.api.writes.length,0);});
test('blocks changed baseline counts and amounts',async()=>{
  const x=fixture();x.data.Imports[0].Daily_Sales_Rows=2;await assert.rejects(()=>preflight(x.api,x.parsed),/baseline/);
  const y=fixture();y.data.Imports[0].Item_Net_Sales=11;await assert.rejects(()=>preflight(y.api,y.parsed),/baseline/);
});
test('blocks overlapping registered periods',async()=>{const x=fixture();x.data.Imports[0].Period_End=x.parsed.start;await assert.rejects(()=>preflight(x.api,x.parsed),/overlaps/);});
test('blocks unregistered sales already present in the date window',async()=>{const x=fixture();x.data.Calendar[0].Has_Item_Records=true;await assert.rejects(()=>preflight(x.api,x.parsed),/already exist/);});
test('blocks missing items, duplicate calendar dates and formula errors',async()=>{
  const x=fixture();x.data.Items=[];await assert.rejects(()=>preflight(x.api,x.parsed),/item is missing/);
  const y=fixture();y.data.Calendar.push(copy(y.data.Calendar[0]));await assert.rejects(()=>preflight(y.api,y.parsed),/duplicate dates/);
  const z=fixture();z.data.Calendar[0].Has_Item_Records=['E','Test'];await assert.rejects(()=>preflight(z.api,z.parsed),/already exist/);
});
test('blocks column-type changes and writes into formula columns',async()=>{
  const x=fixture();x.data._grist_Tables_column.find(c=>c.colId==='Dates_Without_Records').type='Date';await assert.rejects(()=>preflight(x.api,x.parsed),/Text data column/);
  const y=fixture();y.data._grist_Tables_column.find(c=>c.colId==='Net_Sales').isFormula=true;await assert.rejects(()=>preflight(y.api,y.parsed),/data column/);
});
test('requires unresolved review for an absent day',async()=>{const x=fixture(true);x.data.Calendar[1].Day_Review_Reason='';await assert.rejects(()=>preflight(x.api,x.parsed),/review is not set/);});
test('writes only the two existing destination tables with updates disabled',()=>{
  const x=fixture(true),a=actions(x.parsed);assert.equal(a.length,2);
  for(const item of a){assert.equal(item[4].update,false);assert.equal(item[4].add,true);assert.equal(item[4].on_many,'none');}
  assert.equal(typeof a[0][3].Source_Business_Date[0],'number');assert.equal(a[1][3].Dates_Without_Records,'2020-07-02');assert.equal(a[0][3].Source_Selections[0],null);
  assert(!a.some(x=>/Table|Column|Remove|Delete/.test(x[0])));
});
test('commits once, verifies saved totals and keeps prior records intact',async()=>{
  const x=fixture(true),before=copy(x.api.facts[0]);const preview=await preflight(x.api,x.parsed);
  const result=await commit(x.api,x.parsed,preview.doc);assert.equal(result.added,1);assert.equal(x.api.writes.length,1);
  assert.deepEqual(x.api.facts[0],before);assert.equal(x.api.writes[0].options.parseStrings,false);assert.equal(x.data.Imports[1].Dates_Without_Records,'2020-07-02');assert.equal(x.data.Calendar[1].Item_Net_Sales,null);
  await assert.rejects(()=>commit(x.api,x.parsed,preview.doc),/already registered/);assert.equal(x.api.writes.length,1);assert.equal(x.api.facts.length,2);
});
test('blocks a different document after preview',async()=>{const x=fixture();await assert.rejects(()=>commit(x.api,x.parsed,'a-different-document'),/document changed/);assert.equal(x.api.writes.length,0);});
test('does not automatically retry a timeout or ambiguous response',async()=>{
  const x=fixture();x.api.applyUserActions=async()=>{x.api.writes.push('attempt');throw new Error('timeout');};
  await assert.rejects(()=>commit(x.api,x.parsed,x.api.doc),/not confirmed/);assert.equal(x.api.writes.length,1);
  const y=fixture();y.api.applyUserActions=async()=>{y.api.writes.push('attempt');return {};};
  await assert.rejects(()=>commit(y.api,y.parsed,y.api.doc),/did not confirm/);assert.equal(y.api.writes.length,1);
});
test('never reports success when the saved daily total differs',async()=>{
  const x=fixture(),apply=x.api.applyUserActions.bind(x.api);x.api.applyUserActions=async(...args)=>{const r=await apply(...args);x.data.Calendar[0].Item_Net_Sales=8;return r;};
  await assert.rejects(()=>commit(x.api,x.parsed,x.api.doc),/Daily net sales/);assert.equal(x.api.writes.length,1);
});
