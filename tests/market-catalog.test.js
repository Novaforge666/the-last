"use strict";
/* Market discovery checks against the actual page using a fake Deriv socket.
   Run with: cd tests && npm ci && npm test */
const fs = require("fs");
const path = require("path");
const { JSDOM, VirtualConsole } = require("jsdom");

const html = fs.readFileSync(path.join(__dirname, "..", "index.html"), "utf8");

let passed = 0, failed = 0;
function check(name, cond, extra) {
  if (cond) { passed++; console.log("  PASS " + name); }
  else { failed++; console.log("  FAIL " + name + (extra ? " — " + extra : "")); }
}

/* ---------------- fake Deriv WebSocket ---------------- */
const frames = [];
let buyCount = 0, subSeq = 0, settleNext = false;
class FakeWebSocket {
  constructor(url) { this.url = url; this.readyState = 0;
    setTimeout(() => { this.readyState = 1; if (this.onopen) this.onopen(); }, 0); }
  send(data) {
    const msg = JSON.parse(data); frames.push(msg);
    const reqId = msg.req_id;
    const respond = (obj) => setTimeout(() => { obj.req_id = reqId; if (this.onmessage) this.onmessage({ data: JSON.stringify(obj) }); }, 0);
    if (msg.active_symbols) respond({msg_type:'active_symbols',active_symbols:[
      {underlying_symbol:'R_50',underlying_symbol_name:'Volatility 50 Index',market:'synthetic_index',submarket:'random_index',exchange_is_open:1,is_trading_suspended:0,pip_size:0.0001},
      {underlying_symbol:'frxEURUSD',underlying_symbol_name:'EUR/USD',market:'forex',submarket:'major_pairs',exchange_is_open:1,is_trading_suspended:0,pip_size:0.0001},
      {underlying_symbol:'cryBTCUSD',underlying_symbol_name:'BTC/USD',market:'cryptocurrency',submarket:'cryptocurrency',exchange_is_open:1,pip_size:0.01},
      {symbol:'frxXAUUSD',display_name:'Gold/USD',market:'commodities',submarket:'metals',exchange_is_open:1,pip:0.01},
      {underlying_symbol:'testClosed',underlying_symbol_name:'Closed Market',market:'indices',submarket:'stock_indices',exchange_is_open:0},
      {underlying_symbol:'testSuspended',underlying_symbol_name:'Suspended',market:'stocks',submarket:'us_stock',is_trading_suspended:1},
      {underlying_symbol:'__proto__',underlying_symbol_name:'bad',market:'forex'},
      {underlying_symbol:'bad-symbol',underlying_symbol_name:'bad',market:'forex'}]});
    else if (msg.ticks_history) { const p=[],t=[]; for (let i=0;i<50;i++){p.push("1000."+(i%10));t.push(1700000000+i);}
      respond({ msg_type:"history", history:{prices:p,times:t} }); }
    else if (msg.ticks) respond({ msg_type:"tick", tick:{epoch:1700000050,quote:msg.ticks==='frxEURUSD'?'1.23450':'1000.0005',pip_size:msg.ticks==='frxEURUSD'?5:4,symbol:msg.ticks}, subscription:{id:"st"+(++subSeq)} });
    else if (msg.proposal) respond({ msg_type:"proposal", proposal:{id:"prop-"+Math.random().toString(36).slice(2,8),ask_price:"1.00",payout:"1.95",contract_type:msg.contract_type,spot:"1000.5",symbol:msg.underlying_symbol||msg.symbol,longcode:"q"} });
    else if (msg.buy) { buyCount++;
      respond({ msg_type:"buy", buy:{contract_id:900000+buyCount,contract_type:"DIGITOVER",buy_price:1,payout:1.95,start_time:1700000051,purchase_time:1700000050,longcode:"bought",shortcode:"DIGITOVER_R_50"} }); }
    else if (msg.ping) respond({ msg_type:"ping", ping:"pong" });
    else if (msg.balance) respond({ msg_type:"balance", balance:{balance:100,currency:"USD"}, subscription:{id:"sb"+(++subSeq)} });
    else if (msg.proposal_open_contract) { const sold = settleNext; settleNext = false;
      respond({ msg_type:"proposal_open_contract", proposal_open_contract:{contract_id:msg.contract_id,contract_type:"DIGITOVER",status:sold?"won":"open",buy_price:1,payout:1.95,current_spot:1000.5,entry_spot:1000.5,underlying_symbol:"R_50",is_sold:sold?1:0,profit:sold?0.95:0}, subscription:{id:"sp"+(++subSeq)} }); }
    else if (msg.forget) respond({ msg_type:"forget", forget:1 });
    else respond({ msg_type:"unknown" });
  }
  close() { this.readyState = 3; if (this.onclose) this.onclose({code:1000}); }
}

/* ---------------- page setup ---------------- */
const vc = new VirtualConsole();
const jsdomErrors = [];
vc.on("jsdomError", e => jsdomErrors.push(String((e && e.message) || e)));
vc.on("error", (...a) => jsdomErrors.push(a.join(" ")));

const dom = new JSDOM(html, {
  url: "http://localhost/?app=1",
  runScripts: "dangerously",
  pretendToBeVisual: true,
  virtualConsole: vc,
  beforeParse(window) {
    window.WebSocket = FakeWebSocket;
    window.fetch = () => Promise.reject(new Error("fetch disabled in test"));
  }
});
const { window } = dom;
const ev = (code) => window.eval(code);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < (timeoutMs || 4000)) {
    if (fn()) return true;
    await sleep(10);
  }
  return false;
}
(async () => {
  const ready = await waitFor(()=>ev(`Object.hasOwn(MARKETS,'frxEURUSD')`),8000);
  check('Deriv active-symbol catalogue loads on connection',ready);
  check('market selector is at the top left of the chart, not in the top bar', ev(`!!document.querySelector('.mt-chart-head #headerMarket') && !document.querySelector('.topbar #headerMarket')`));
  check('catalogue includes forex, crypto, commodity and closed/suspended markets', ev(`['frxEURUSD','cryBTCUSD','frxXAUUSD','testClosed','testSuspended'].every(k=>Object.hasOwn(MARKETS,k))`));
  check('legacy and current Deriv symbol schemas both work', ev(`MARKETS.frxEURUSD.name==='EUR/USD' && MARKETS.frxXAUUSD.name==='Gold/USD'`));
  check('unsafe symbol keys are ignored', ev(`!Object.hasOwn(MARKETS,'__proto__') && !Object.hasOwn(MARKETS,'bad-symbol')`));
  check('selector groups additional symbols by market', ev(`document.querySelector('#headerMarket optgroup[label="Forex"] option[value="frxEURUSD"]') && document.querySelector('#headerMarket optgroup[label="Cryptocurrencies"] option[value="cryBTCUSD"]')`));
  check('original synthetic markets remain as the bounded fallback catalogue', ev(`VOLATILITY_MARKETS.length===10 && document.querySelector('#headerMarket option[value="R_50"]')`));
  check('successful catalogue marks omitted fallback symbols unavailable', ev(`MARKETS.R_10.available===false && !marketIsTradable('R_10')`));
  check('catalogue price increments are not mistaken for tick decimal precision', ev(`MARKETS.frxEURUSD.pip===null && lastDigit('1.2345','frxEURUSD')===null && fmtPrice('1.2345','frxEURUSD')==='1.2345'`));
  ev(`document.getElementById('headerMarket').value='frxEURUSD'; document.getElementById('headerMarket').dispatchEvent(new Event('change',{bubbles:true}))`);
  await waitFor(()=>ev(`Markets.buf('frxEURUSD').primed`));
  check('chart selection updates global market and subscribes to its tick feed', ev(`state.market==='frxEURUSD' && document.getElementById('market').value==='frxEURUSD' && Markets.buf('frxEURUSD').live`) && frames.some(f=>f.ticks==='frxEURUSD'));
  check('live tick precision produces the correct padded forex digit', ev(`MARKETS.frxEURUSD.pip===5 && lastDigit('1.2345','frxEURUSD')===0 && fmtPrice('1.2345','frxEURUSD')==='1.23450'`));
  check('manual ticket uses the selected symbol',ev(`ticketRequestFor('DIGITOVER').underlying_symbol==='frxEURUSD'`));
  ev(`switchTab('bots'); document.querySelector('.tab[data-tab="bots"]').click()`);
  check('Auto Bot selector includes the discovered market',ev(`document.querySelector('#botMarket option[value="frxEURUSD"]')`));
  ev(`openFreeBot('matchbot'); DBots.applyEdit('market','frxEURUSD');`);
  check('Free bot accepts discovered market without replacing its identity',ev(`DBots.selected() && DBots.cfg.market==='frxEURUSD' && signalBotKind(DBots.selected())==='matchbot'`));
  check('DBot XML stores the real market and submarket',ev(`DBots.selected().xml.includes('>forex</field>') && DBots.selected().xml.includes('>major_pairs</field>')`));
  check('builder has discovered market options',ev(`!!document.querySelector('#bbMarket option[value="frxEURUSD"]')`));
  ev(`document.getElementById('bbMarket').value='frxEURUSD'; document.getElementById('bbCreate').click()`);
  check('builder writes selected market metadata into its XML',ev(`DBots.cfg.market==='frxEURUSD' && DBots.selected().xml.includes('>forex</field>') && DBots.selected().xml.includes('>major_pairs</field>')`));
  ev(`Markets.buf('frxEURUSD').ticks=[]; Markets.push('frxEURUSD',{epoch:99,quote:'1.23450',pip_size:5}); Markets.push('frxEURUSD',{epoch:99,quote:'1.23450',pip_size:5});`);
  check('repeated live ticks with identical time and price remain distinct',ev(`Markets.buf('frxEURUSD').ticks.length===2`));
  ev(`Markets.seed('frxEURUSD',['1.23450'],[99],5)`);
  check('history merge preserves repeated live occurrences beyond its overlap',ev(`Markets.buf('frxEURUSD').ticks.length===2`));
  ev(`state.auth={loginid:'test',is_virtual:true};state.token='test';state.balance=100;state.market='testClosed';updateBuyState()`);
  check('closed market is labelled and cannot initiate orders',ev(`document.querySelector('#headerMarket option[value="testClosed"]').textContent.includes('(closed)') && !marketIsTradable('testClosed') && document.getElementById('btnBuy').disabled`));
  ev(`state.market='testSuspended';updateBuyState()`);
  check('suspended market cannot initiate orders',ev(`!marketIsTradable('testSuspended') && document.getElementById('btnBuy').disabled`));
  check('all-market signal scan remains the original bounded volatility scan',ev(`VOLATILITY_MARKETS.length===10 && !VOLATILITY_MARKETS.includes('frxEURUSD')`));
  ev(`state.market='R_50'; window.origReq=socket.request; socket.request=()=>Promise.reject({message:'unavailable'});`);
  await ev('loadMarketCatalog()');
  check('catalogue failure retains existing markets and offers retry',ev(`MARKETS.frxEURUSD && !document.getElementById('marketCatalogRetry').classList.contains('hidden')`));
  ev(`setMarket('frxEURUSD')`);
  check('retry stays visible after switching markets on catalogue failure',ev(`!document.getElementById('marketCatalogRetry').classList.contains('hidden')`));
  ev(`socket.request=origReq`);
  ev(`state.market='frxEURUSD'; renderDigitHeat(); state.proposal={id:'old'};state.proposalAlt={id:'old2'}; state.proposalAt=1; window.beforeSeq=state.proposalSeq; socket.request=()=>Promise.resolve({active_symbols:[{underlying_symbol:'frxEURUSD',underlying_symbol_name:'EUR/USD',market:'forex',submarket:'major_pairs',exchange_is_open:0}]})`);
  await ev('loadMarketCatalog()');
  check('market closing invalidates cached and in-flight quotes',ev(`!marketIsTradable('frxEURUSD') && !state.proposal && !state.proposalAlt && state.proposalSeq>beforeSeq && document.getElementById('btnBuy').disabled`));
  check('catalogue closing a market clears both live digit markers immediately',ev(`document.querySelectorAll('#digitStrip .current, #digitPick .current').length===0`));
  const before=frames.filter(f=>f.buy).length;
  await ev(`instantBuy('up')`);
  check('closed market cannot send a buy',frames.filter(f=>f.buy).length===before);
  ev(`switchTab('manual'); document.getElementById('headerMarket').focus(); socket.request=()=>Promise.resolve({active_symbols:[{underlying_symbol:'frxEURUSD',underlying_symbol_name:'Euro Dollar',market:'forex',exchange_is_open:1}]})`);
  await ev('loadMarketCatalog()');
  check('catalogue refresh defers changes to focused selector',ev(`document.getElementById('headerMarket').dataset.pendingRefresh==='1'`));
  ev(`document.getElementById('headerMarket').blur()`);
  check('focused selector refreshes on blur',ev(`!document.getElementById('headerMarket').dataset.pendingRefresh && document.querySelector('#headerMarket option[value="frxEURUSD"]').textContent==='Euro Dollar'`));
  ev(`window.resolveOld=null; window.catalogCount=0; socket.request=()=>{catalogCount++; return catalogCount===1 ? new Promise(resolve=>resolveOld=resolve) : Promise.resolve({active_symbols:[{symbol:'newSym',display_name:'New session',market:'forex'}]})}`);
  const old = ev('loadMarketCatalog()');
  ev(`socket.generation++; resolveOld({active_symbols:[{symbol:'oldSym',display_name:'Stale session',market:'forex'}]})`);
  await old;
  await waitFor(()=>ev(`Object.hasOwn(MARKETS,'newSym')`));
  check('stale catalogue response cannot overwrite the reconnected session and refresh retries',ev(`!Object.hasOwn(MARKETS,'oldSym') && Object.hasOwn(MARKETS,'newSym') && catalogCount===2`));
  ev(`socket.request=origReq`);
  const errors=jsdomErrors.filter(m=>!/getContext|canvas|scrollTo/i.test(m));
  if(errors.length){check('no unexpected page errors',false,errors.join('; '));console.log(errors.slice(0,5));}
  console.log(`\n${passed} passed, ${failed} failed`); window.close(); process.exit(failed?1:0);
})().catch(e=>{console.error(e);window.close();process.exit(2)});
