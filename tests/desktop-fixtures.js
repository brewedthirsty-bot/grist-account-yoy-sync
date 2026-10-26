'use strict';
const core = require('../events/core.js');
const {fixture,csv} = require('./fixtures.js');

const source = {key:'venue:npd_amphitheater',name:'Nickel Plate District Amphitheater',source_key:'source:fishers_city_amp',adapter:'grist_tribe',
  source_url:'https://fishersin.gov/wp-json/tribe/events/v1/events/',venue_id:'74128',timezone:'America/Indiana/Indianapolis',event_key_aliases:{'42':'event:'+'b'.repeat(32)}};
function files(f) {
  return {'Venues.csv':csv(core.VENUE_FIELDS,f.venues),'Events.csv':csv(core.EVENT_FIELDS,f.events),'Source_Checks.csv':csv(core.CHECK_FIELDS,f.checks),'run_report.json':JSON.stringify(f.report)};
}
function desktopFixture() {
  const f = fixture();
  f.venues[2] = {Venue_Key:source.key,Venue:source.name,Website:'https://npdamp.com/calendar/',Source_Key:source.source_key,Source_URL:source.source_url};
  f.checks[2] = {...f.checks[2],Source_Key:source.source_key,Venue:source.name,Latest_Check_Status:'Desktop',Latest_Error:'',Events_Returned:'1'};
  f.report.sources[2] = {source_key:source.source_key,venue:source.name,success:null,execution:'grist',included:0};
  f.report.success = true; f.report.failed_sources = 0; f.report.deferred_sources = 1; f.report.desktop_sources = [source]; f.report.collection_scope = 'server';
  f.report.start = '2025-01-01'; f.report.end = '2028-12-31'; f.report.venue_keys = f.venues.map(v => v.Venue_Key);
  f.events.push({...f.events[0],Event_Key:source.event_key_aliases['42'],Venue_Key:source.key,Venue:source.name,Source_Key:source.source_key,Source_Event_ID:'source-id:42',Event_Name:'City show',Source_URL:'https://fishersin.gov/event/city-show/'});
  f.report.history_events = f.events.length;
  return f;
}
function raw(id = 42, extra = {}) {
  return {id,title:'City show',venue:{id:74128},status:'publish',start_date:'2026-10-23 19:30:00',utc_start_date:'2026-10-23 23:30:00',end_date:'2026-10-23 22:00:00',utc_end_date:'2026-10-24 02:00:00',all_day:false,categories:[{name:'Concert'}],url:`https://fishersin.gov/event/city-show-${id}/`,...extra};
}
function fetchCity(rows, calls = []) {
  return async (url, options) => {
    calls.push({url,options});
    const page = Number(new URL(url).searchParams.get('page'));
    return {ok:true,text:async () => JSON.stringify({events:rows.slice((page-1)*50,page*50),total:rows.length,total_pages:Math.ceil(rows.length/50)})};
  };
}
module.exports = {source,files,desktopFixture,raw,fetchCity};
