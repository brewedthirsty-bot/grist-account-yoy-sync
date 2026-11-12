export const SALES = ['Daily_Key','Source_Business_Date','Item_Key','Service','Source_Category','Quantity','Net_Sales','Gross_Sales','Gross_Less_Net','Toast_Discount_Field','Tax','Refund_Amount','Void_Amount','Source_Key','First_CSV_Row','Last_CSV_Row','Source_Selections'];
export const IMPORTS = ['Source_Key','Source_File','Period_Start','Period_End','Location','Raw_Rows','Eligible_Selections','Excluded_Rows','Void_Rows','Deferred_Rows','Daily_Sales_Rows','Quantity','Item_Net_Sales','Dates_Without_Records','Source_Encoding','Source_SHA256'];
const LOCATION = 'Fishers Nickel Plate District';
const METRICS = ['Quantity','Net_Sales','Gross_Sales','Toast_Discount_Field','Refund_Amount','Tax','Void_Amount'];
const NUMERIC = new Set(['Quantity','Net_Sales','Gross_Sales','Gross_Less_Net','Toast_Discount_Field','Tax','Refund_Amount','Void_Amount','First_CSV_Row','Last_CSV_Row','Source_Selections','Raw_Rows','Eligible_Selections','Excluded_Rows','Void_Rows','Deferred_Rows','Daily_Sales_Rows','Item_Net_Sales']);
const DATES = new Set(['Source_Business_Date','Period_Start','Period_End']);
const check = (ok,message) => { if (!ok) throw new Error(message); };
export function cents(n) {
  check(typeof n === 'number' && Number.isFinite(n), 'An amount or quantity is not a finite number.');
  const value = Math.round(n * 100);
  check(Number.isSafeInteger(value) && Math.abs(n * 100 - value) < 0.00001, 'An amount or quantity has unsupported precision.');
  return value;
}
export function dateSeconds(text) {
  check(typeof text === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(text), 'A business date is invalid.');
  const time = Date.parse(text + 'T00:00:00Z');
  check(Number.isFinite(time) && new Date(time).toISOString().slice(0,10) === text, 'A business date does not exist.');
  return time / 1000;
}
function dayText(value) {
  check(typeof value === 'number' && Number.isFinite(value) && value % 86400 === 0, 'A Grist date is invalid.');
  return new Date(value * 1000).toISOString().slice(0,10);
}
export function asRows(table) {
  check(table && Array.isArray(table.id), 'Grist returned an invalid table.');
  const fields = Object.keys(table);
  check(fields.every(f => Array.isArray(table[f]) && table[f].length === table.id.length), 'Grist returned inconsistent columns.');
  return table.id.map((_, i) => Object.fromEntries(fields.map(f => [f,table[f][i]])));
}
export async function unpack(text) {
  const envelope = JSON.parse(text);
  check(envelope.format === 'fdr-dsr-history/1' && typeof envelope.payload_json === 'string', 'Choose a prepared FDR history package.');
  const digest = await globalThis.crypto.subtle.digest('SHA-256',new TextEncoder().encode(envelope.payload_json));
  const hash = [...new Uint8Array(digest)].map(n => n.toString(16).padStart(2,'0')).join('');
  check(hash === envelope.payload_sha256, 'The package checksum does not match. Download it again.');
  return validate(JSON.parse(envelope.payload_json));
}
export function validate(p) {
  check(p && p.version === 1 && JSON.stringify(p.columns) === JSON.stringify(SALES), 'Unexpected sales fields.');
  check(Array.isArray(p.rows) && p.rows.length > 0 && p.rows.length <= 75000, 'Unexpected sales-record count.');
  check(p.registration && Object.keys(p.registration).sort().join('|') === [...IMPORTS].sort().join('|'), 'Unexpected import-log fields.');
  const r = p.registration;
  check(/^toast:fishers:legacy-name:\d{4}(?:-Q[1-4])?$/.test(r.Source_Key), 'Unsupported source key.');
  check(r.Location === LOCATION && /^[a-f0-9]{64}$/.test(r.Source_SHA256), 'The source identity is invalid.');
  const start = dateSeconds(r.Period_Start), end = dateSeconds(r.Period_End);
  check(start <= end && (end-start)/86400 < 366 && r.Period_Start >= '2016-10-07' && r.Period_End <= '2024-10-31', 'Unsupported historical period.');
  check(typeof r.Source_File === 'string' && r.Source_File.length > 0 && typeof r.Source_Encoding === 'string', 'Missing source information.');
  check(Number.isSafeInteger(r.Raw_Rows) && Number.isSafeInteger(r.Excluded_Rows) && r.Raw_Rows > p.rows.length && r.Raw_Rows - r.Excluded_Rows === p.rows.length, 'Source row controls disagree.');
  check(r.Daily_Sales_Rows === p.rows.length, 'The source record count disagrees.');
  for (const name of ['Eligible_Selections','Void_Rows','Deferred_Rows']) check(r[name] === null, 'Unknown historical transaction counts must stay blank.');
  check(p.baseline && Number.isSafeInteger(p.baseline.sales_rows) && Number.isSafeInteger(p.baseline.import_rows) && p.baseline.import_rows > 0, 'Missing checked DSR baseline.');
  for (const field of ['net','quantity']) cents(p.baseline[field]);
  const keys = new Set(), days = new Map(), totals = Object.fromEntries(METRICS.map(m => [m,0]));
  const records = [];
  for (const values of p.rows) {
    check(Array.isArray(values) && values.length === SALES.length, 'A sales record has unexpected fields.');
    const row = Object.fromEntries(SALES.map((name,i) => [name,values[i]]));
    check(/^history:[a-f0-9]{32}$/.test(row.Daily_Key) && !keys.has(row.Daily_Key), 'Duplicate or invalid daily key.'); keys.add(row.Daily_Key);
    const day = dateSeconds(row.Source_Business_Date);
    check(day >= start && day <= end && row.Source_Key === r.Source_Key, 'A record is outside the selected source period.');
    check(typeof row.Item_Key === 'string' && row.Item_Key.length > 0, 'Missing item key.');
    check(row.Service === '' && row.Source_Category === '' && row.Source_Selections === null, 'Unprovided historical fields must remain unknown.');
    for (const name of METRICS) totals[name] += cents(row[name]);
    check(cents(row.Gross_Less_Net) === cents(row.Toast_Discount_Field) + cents(row.Refund_Amount), 'Discount/refund controls disagree.');
    check(cents(row.Net_Sales) === cents(row.Gross_Sales) - cents(row.Gross_Less_Net), 'Net-sales controls disagree.');
    check(Number.isSafeInteger(row.First_CSV_Row) && row.First_CSV_Row >= 2 && row.First_CSV_Row === row.Last_CSV_Row && row.First_CSV_Row <= r.Raw_Rows, 'Invalid original CSV row.');
    days.set(row.Source_Business_Date,(days.get(row.Source_Business_Date) || 0) + cents(row.Net_Sales));
    records.push(row);
  }
  for (const name of METRICS) check(p.totals && totals[name] === cents(p.totals[name]), `The ${name} total disagrees.`);
  check(totals.Net_Sales === cents(r.Item_Net_Sales) && totals.Quantity === cents(r.Quantity), 'The import-log totals disagree.');
  const missing = [];
  for (let day=start;day<=end;day+=86400) { const text=dayText(day); if (!days.has(text)) missing.push(text); }
  check(typeof r.Dates_Without_Records === 'string' && r.Dates_Without_Records === missing.join(', '), 'The missing-date list disagrees.');
  return {...p,records,days,missing,start,end,totalsInCents:totals};
}
function checkSchema(tables,columns) {
  const byName = new Map(tables.map(t => [t.tableId,t.id]));
  for (const [name,fields] of [['Daily_Sales',SALES],['Imports',IMPORTS]]) {
    check(byName.has(name), `Missing existing ${name} table.`);
    const actual = new Map(columns.filter(c => c.parentId === byName.get(name)).map(c => [c.colId,c]));
    for (const field of fields) {
      const c = actual.get(field), expected = DATES.has(field) ? 'Date' : NUMERIC.has(field) ? 'Numeric' : 'Text';
      check(c && !c.isFormula && (c.type === expected || expected === 'Numeric' && c.type === 'Int'), `${name}.${field} must be an existing ${expected} data column.`);
    }
  }
}
export async function preflight(api,p) {
  const doc = await api.getDocName();
  const names = ['Imports','Calendar','Items','_grist_Tables','_grist_Tables_column'];
  const values = await Promise.all(names.map(name => api.fetchTable(name)));
  const [imports,calendar,items,tables,columns] = values.map(asRows);
  checkSchema(tables,columns);
  check(!imports.some(x => x.Source_Key === p.registration.Source_Key), 'This source is already registered. Do not import it again.');
  check(imports.length === p.baseline.import_rows, 'The DSR has changed since this package was prepared. Recheck the latest file.');
  let count=0, net=0, quantity=0;
  for (const r of imports) {
    check(r.Location === LOCATION && Number.isSafeInteger(r.Daily_Sales_Rows), 'Unexpected source registration in this DSR.');
    count += r.Daily_Sales_Rows; net += cents(r.Item_Net_Sales); quantity += cents(r.Quantity);
    const start=dateSeconds(dayText(r.Period_Start)), end=dateSeconds(dayText(r.Period_End));
    check(end < p.start || start > p.end, 'This period overlaps data already registered in Grist.');
  }
  check(count === p.baseline.sales_rows && net === cents(p.baseline.net) && quantity === cents(p.baseline.quantity), 'The source-register baseline has changed. Recheck the latest DSR.');
  const itemKeys = new Set(items.map(x => x.Item_Key));
  check(p.records.every(x => itemKeys.has(x.Item_Key)), 'An item is missing from the existing catalog.');
  const byDate = new Map();
  for (const row of calendar) {
    const text=dayText(row.Date);
    check(!byDate.has(text), 'The calendar has duplicate dates.'); byDate.set(text,row);
  }
  for (let day=p.start;day<=p.end;day+=86400) {
    const text=dayText(day), row=byDate.get(text);
    check(row, `Missing Calendar date ${text}.`);
    check(row.Has_Item_Records === false || row.Has_Item_Records === 0, `Sales already exist on ${text}. Stop for review.`);
    check(row.Sales_Data_Loaded === false || row.Sales_Data_Loaded === 0, `${text} is already marked loaded.`);
    if (p.missing.includes(text)) check(typeof row.Day_Review_Reason === 'string' && row.Day_Review_Reason.length > 0, `Missing-date review is not set for ${text}.`);
  }
  return {doc,records:p.records.length,net:p.totalsInCents.Net_Sales/100,quantity:p.totalsInCents.Quantity/100};
}
export function actions(p) {
  const values = Object.fromEntries(SALES.filter(f => f !== 'Daily_Key').map(f => [f,p.records.map(r => DATES.has(f) ? dateSeconds(r[f]) : r[f])]));
  const registration = Object.fromEntries(IMPORTS.filter(f => f !== 'Source_Key').map(f => [f,DATES.has(f) ? dateSeconds(p.registration[f]) : p.registration[f]]));
  const options = {add:true,update:false,on_many:'none',allow_empty_require:false};
  return [
    ['BulkAddOrUpdateRecord','Daily_Sales',{Daily_Key:p.records.map(r => r.Daily_Key)},values,{...options}],
    ['AddOrUpdateRecord','Imports',{Source_Key:p.registration.Source_Key},registration,{...options}]
  ];
}
export async function verifySaved(api,p) {
  const [a,b] = await Promise.all(['Imports','Calendar'].map(t => api.fetchTable(t)));
  const registrations=asRows(a).filter(x => x.Source_Key === p.registration.Source_Key);
  check(registrations.length === 1, 'The saved source registration needs review.');
  const actual = registrations[0];
  for (const field of IMPORTS) {
    const expected = DATES.has(field) ? dateSeconds(p.registration[field]) : p.registration[field];
    check(actual[field] === expected || field === 'Dates_Without_Records' && expected === '' && actual[field] === null, `Saved Imports.${field} needs review.`);
  }
  const dates = new Map(asRows(b).map(row => [dayText(row.Date),row]));
  for (let day=p.start;day<=p.end;day+=86400) {
    const text=dayText(day), row=dates.get(text); check(row && !!row.Sales_Data_Loaded, `Calendar ${text} is not loaded.`);
    if (p.days.has(text)) check(!!row.Has_Item_Records && cents(row.Item_Net_Sales) === p.days.get(text), `Daily net sales on ${text} need review.`);
    else check(!row.Has_Item_Records && !!row.Day_Review_Reason && row.Item_Net_Sales === null, `Missing-date status on ${text} needs review.`);
  }
}
export async function commit(api,p,previewDoc,progress=()=>{}) {
  const preview = await preflight(api,p);
  check(preview.doc === previewDoc, 'The Grist document changed. Refresh the preview.');
  progress('Adding sales and the source log…');
  let result;
  try { result = await api.applyUserActions(actions(p),{parseStrings:false}); }
  catch (error) { throw new Error('Import was not confirmed. Do not retry automatically. Recheck Grist before continuing. ' + error.message); }
  const returned = result?.retValues;
  check(Array.isArray(returned) && returned.length === 2 && returned[0]?.addRecordIds?.length === p.records.length && returned[0]?.updateRecordIds?.length === 0 && returned[1]?.action === 'ADD', 'The server did not confirm every new record. Stop and review Grist before retrying.');
  progress('Checking the saved source log and daily totals…');
  await verifySaved(api,p);
  return {added:returned[0].addRecordIds.length,source:p.registration.Source_Key};
}
