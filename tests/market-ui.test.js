"use strict";
/* Integration checks against the actual page using a fake Deriv socket.
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
    if (msg.ticks_history) { const p=[],t=[]; for (let i=0;i<50;i++){p.push("1000."+(i%10));t.push(1700000000+i);}
      respond({ msg_type:"history", history:{prices:p,times:t} }); }
    else if (msg.ticks) respond({ msg_type:"tick", tick:{epoch:1700000050,quote:"1000.0005",symbol:msg.ticks}, subscription:{id:"st"+(++subSeq)} });
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
function login() {
  ev(`state.auth = { loginid: "CR_TEST", is_virtual: true, currency: "USD", balance: 100 };
      state.token = "test-token"; state.balance = 100; state.currency = "USD";
      state.accountType = "demo";`);
}
let pushEpoch = 1700000100;
function seedDigits(sym, digits) {
  digits.forEach(d => {
    pushEpoch++;
    ev(`Markets.push(${JSON.stringify(sym)}, { epoch: ${pushEpoch}, quote: "1000.000${d}", symbol: ${JSON.stringify(sym)} });`);
  });
}

(async () => {
  await waitFor(() => ev("socket.ws && socket.ws.readyState") === 1, 8000);
  await sleep(150);
  check('guest header shows login and no account identifier', ev(`!document.getElementById('btnLogin').classList.contains('hidden') && document.getElementById('btnLogout').classList.contains('hidden') && document.getElementById('acctId').textContent==='Not logged in'`));
  ev(`state.auth={loginid:'VRTC_PRIVATE',is_virtual:true};state.token='test';state.accountType='demo';renderAuth()`);
  check('demo header shows Demo rather than the user ID', ev(`document.getElementById('acctId').classList.contains('hidden') && document.getElementById('acctBadge').textContent==='Demo' && !document.getElementById('acctBlock').textContent.includes('VRTC_PRIVATE') && !document.getElementById('btnLogout').classList.contains('hidden')`));
  ev(`state.auth={loginid:'CR_PRIVATE',is_virtual:false};state.accountType='real';renderAuth()`);
  check('real account remains clearly labelled Real and warns about real money', ev(`document.getElementById('acctBadge').textContent==='Real' && document.getElementById('acctBadge').classList.contains('real') && !document.getElementById('acctBlock').textContent.includes('CR_PRIVATE') && document.body.textContent.includes('Orders placed here spend real money.')`));
  ev(`state.auth=null;state.token=null;state.accountType=null;renderAuth()`);
  check('guest controls return after logout state', ev(`!document.getElementById('acctId').classList.contains('hidden') && document.getElementById('acctBadge').textContent==='Guest' && !document.getElementById('btnLogin').classList.contains('hidden') && document.getElementById('btnLogout').classList.contains('hidden')`));
  // Controlled precision, including trailing zeros and precision corrections.
  ev(`Markets.buf('R_10').ticks=[]; Markets.setPrecision('R_10',3);
      Markets.push('R_10',{epoch:100,quote:'12.34',pip_size:3});`);
  check('Deriv pip_size pads the live quote before extracting a digit', ev(`Markets.digits('R_10',1)[0]===0 && fmtPrice(12.34,'R_10')==='12.340'`));
  ev(`Markets.push('R_10',{epoch:101,quote:12.34,pip_size:2});`);
  check('new precision updates buffered tick digits', ev(`MARKETS.R_10.pip===2 && Markets.digits('R_10',2).every(x=>x===4)`));
  ev(`Markets.setPrecision('R_10',0)`);
  check('zero-decimal markets format correctly', ev(`fmtPrice(12,'R_10')==='12' && lastDigit(12,'R_10')===2`));
  ev(`MARKETS.R_10.pip=3; window.pipBefore=MARKETS.R_10.pip; Markets.setPrecision('R_10',-1); Markets.setPrecision('R_10',null);`);
  check('invalid precision values are ignored', ev('MARKETS.R_10.pip===pipBefore'));
  // All-market scanning must use the scanned market, not Array.map's index.
  ev(`Markets.data.delete('R_100'); socket.request=()=>Promise.resolve({pip_size:2,history:{prices:[12.3,12.34,12.35],times:[1,2,3]}}); window.scanned=null; scanDigits('R_100',3).then(v=>window.scanned=v)`);
  await waitFor(()=>ev('scanned !== null'));
  check('scan uses the scanned market precision for every quote', ev(`JSON.stringify(scanned)==='[5,4,0]'`));

  // Subscribe once before history and merge overlapping history + live frames.
  ev(`Markets.data.delete('1HZ50V'); window.order=[]; window.streamCalls=0; window.finishHistory=null;
    socket.stream=(key,payload,onData,onOpen)=>{ order.push('subscribe'); streamCalls++; window.liveTick=onData;
      onOpen({tick:{epoch:101,quote:12.3,pip_size:2}}); return Promise.resolve(); };
    socket.request=req=>{order.push('history'); return new Promise(resolve=>{window.finishHistory=resolve})};
    window.ensureDone=0; Markets.ensure('1HZ50V').then(()=>ensureDone++); Markets.ensure('1HZ50V').then(()=>ensureDone++);`);
  await waitFor(()=>ev('finishHistory !== null'));
  ev(`liveTick({tick:{epoch:102,quote:12.31,pip_size:2}});
      finishHistory({pip_size:2,history:{prices:['12.20','12.30'],times:[100,101]}})`);
  await waitFor(()=>ev('ensureDone===2'));
  check('concurrent requests create one live subscription', ev('streamCalls===1'));
  check('live stream opens before history request', ev(`order[0]==='subscribe' && order[1]==='history'`));
  check('initial subscription tick and later live tick survive history merge without duplicates', ev(`JSON.stringify(Markets.buf('1HZ50V').ticks.map(t=>t.epoch))==='[100,101,102]' && JSON.stringify(Markets.digits('1HZ50V',3))==='[1,0,0]'`));
  check('history marks buffer primed', ev(`Markets.buf('1HZ50V').primed`));
  ev(`window.stats=digitStats([0,0,1,2,2,2]);`);
  check('digit percentages sum to 100 and count actual digits', ev(`stats.counts[0]===2 && stats.counts[1]===1 && stats.counts[2]===3 && Math.abs(stats.shares.reduce((a,b)=>a+b,0)-100)<0.001`));

  // Every primary tab is navigable, with one active pane.
  for (const tab of ['manual','bots','freebots','dbots','analysis','signals']) {
    ev(`switchTab(${JSON.stringify(tab)})`);
    check(`${tab} tab opens exactly one active pane`, ev(`state.tab===${JSON.stringify(tab)} && document.querySelectorAll('.tabpane.active').length===1 && document.getElementById('pane-${tab}').classList.contains('active')`));
  }
  ev(`toast('Test','Non-blocking','info');`);
  check('notifications are click-through', ev(`getComputedStyle(document.getElementById('toasts')).pointerEvents==='none'`));
  check('notifications stay capped', ev(`toast('1','x');toast('2','x');toast('3','x');document.getElementById('toasts').children.length<=3`));

  // Rounded labels must reflect the raw percentage, not redistributed tenths.
  ev(`window.thirds=digitStats([0,1,2])`);
  check('each digit percentage rounds independently', ev(`[0,1,2].every(i=>thirds.shares[i].toFixed(1)==='33.3')`));
  ev(`setAnalysisWindow(250)`);
  check('analysis window controls stay in sync across tabs', ev(`document.querySelector('#winSeg button[data-win="250"]').classList.contains('active') && document.querySelector('#stripSeg button[data-win="250"]').classList.contains('active')`));
  ev(`state.market='R_50'; window.botCalled=[]; window.oldDriver=botOnTick; botOnTick=sym=>botCalled.push(sym); state.bot.running=true; Markets.push('R_100',{epoch:1234567,quote:'12.34',pip_size:2}); state.bot.running=false; botOnTick=oldDriver;`);
  check('Auto Bot receives ticks from its own market when chart shows another', ev(`botCalled.includes('R_100')`));
  ev(`state.market='R_50'; state.signals=[{def:{id:'M7',type:'DIGITMATCH',barrier:7,label:'Matches 7'},entry:true,rate:15,delta:0,trend:'flat',strength:'weak',why:'test'}]; renderSignalCards();
      window.originalButton=document.querySelector('button[data-act="runbot"]'); originalButton.focus(); state.signals[0].rate=16; renderSignalCards();`);
  check('live signal updates preserve the entry button and focus', ev(`originalButton===document.querySelector('button[data-act="runbot"]') && document.activeElement===originalButton`));
  // A stop while awaiting the quote must prevent a later buy.
  ev(`state.bot.running=true; state.bot.runId=51; state.bot.cfg={market:'R_50',ticks:1,contract:'DIGITOVER',barrier:3}; state.bot.nextStake=1; state.bot.busy=true; state.bot.tradeInFlight=true; state.bot.pendingContract=null;
      window.botReq=[]; window.quoteDone=null; socket.request=req=>{botReq.push(req); if(req.proposal) return new Promise(resolve=>quoteDone=resolve); return Promise.resolve({});};
      placeBotTrade(state.bot.cfg,{reason:'test'}).catch(()=>{}); stopBot('test stop'); quoteDone({proposal:{id:'q',ask_price:1}});`);
  await sleep(20);
  check('Auto Bot stop before quote prevents buy', ev(`!state.bot.running && !state.bot.tradeInFlight && botReq.filter(r=>r.buy).length===0`));
  // Once a buy is sent, stopping cannot erase tracking of its late response.
  ev(`state.bot.running=true; state.bot.runId=52; state.bot.busy=true; state.bot.tradeInFlight=true; state.bot.pendingContract=null; window.botReq=[]; window.buyDone=null;
      socket.request=req=>{botReq.push(req); if(req.proposal) return Promise.resolve({proposal:{id:'q',ask_price:1}}); if(req.buy) return new Promise(resolve=>buyDone=resolve); return Promise.resolve({});};
      socket.stream=(key,req,handler)=>{window.botWatch=handler; return Promise.resolve()}; socket.forget=()=>{};
      placeBotTrade(state.bot.cfg,{reason:'test'}).catch(()=>{});`);
  await waitFor(()=>ev('buyDone !== null'));
  ev(`stopBot('test stop while buying'); buyDone({buy:{contract_id:811,buy_price:1,payout:2}})`);
  await waitFor(()=>ev('state.bot.pendingContract===811'));
  check('Auto Bot tracks a late buy after stopping', ev(`!state.bot.running && state.bot.pendingContract===811`));
  ev(`botWatch({proposal_open_contract:{contract_id:812,is_sold:1,profit:1,status:'won',buy_price:1,payout:2}})`);
  check('Auto Bot ignores settlement for another contract', ev(`state.bot.pendingContract===811`));
  ev(`botWatch({proposal_open_contract:{contract_id:811,is_sold:1,profit:1,status:'won',buy_price:1,payout:2}})`);
  check('Auto Bot releases stopped contract after settlement', ev(`state.bot.pendingContract==null && !state.bot.running`));
  // New socket must not be poisoned by an old connection's late onclose.
  ev(`window.testSocket=new DerivSocket('wss://fake',false); testSocket.connect();`);
  await waitFor(()=>ev('testSocket.ws && testSocket.ws.readyState===1'));
  ev(`window.oldWs=testSocket.ws; testSocket.restart('wss://fake2',false); oldWs.onclose({code:1006})`);
  await waitFor(()=>ev('testSocket.ws && testSocket.ws!==oldWs && testSocket.ws.readyState===1'));
  check('late close from replaced socket does not interrupt new connection', ev(`testSocket.ws!==oldWs && testSocket.status==='open'`));
  ev(`testSocket.disconnect()`);
  ev(`window.partial=computeSignal({type:'DIGITMATCH',barrier:7},[7],{window:100,trend:50,streak:3,cold:8})`);
  check('partial history never produces an Entry now signal', ev(`!partial.entry && partial.why.includes('Waiting for 100 ticks')`));
  check('frequency and parity bots wait for their full configured window', ev(`
    !botEvaluate({strategy:'frequency',window:100,digit:7,condition:'hot',threshold:10},[7]).fire &&
    !botEvaluate({strategy:'evenodd',window:100,imbalance:10,side:'majority',contract:'DIGITEVEN'},[2]).fire`));
  ev(`window.parity=botEvaluate({strategy:'evenodd',window:4,imbalance:10,side:'underdog',contract:'DIGITEVEN'},[2,4,6,1]);`);
  check('Auto Bot honors the configured underrepresented parity', ev(`parity.fire && parity.contract==='DIGITODD'`));
  ev(`state.bot.running=true; state.bot.tradeInFlight=false; state.bot.pendingContract=null;
      DBots.running=true; DBots.pending=993; DBots.pendingSignal=true; DBots.signalTradeInFlight=false;
      Markets.buf('R_50').primed=true; socket.setStatus('closed','test')`);
  check('disconnect stops bots and retains a pending contract', ev(`!state.bot.running && !DBots.running && DBots.pending===993 && DBots.pendingSignal`));
  check('disconnect invalidates buffered history for resync', ev(`!Markets.buf('R_50').primed`));
  ev(`DBots.pending=null; DBots.pendingSignal=false`);
  check('disconnect clears stale tick history', ev(`Markets.buf('R_50').ticks.length===0`));
  ev(`state.tab='signals'; state.market='R_50';
      for(let i=0;i<100;i++) Markets.push('R_50',{epoch:2100000000+i,quote:12.77,pip_size:2});
      computeSignals();`);
  check('signals remain unavailable until the live feed and history resync', ev(`state.signals.length && state.signals.every(s=>!s.entry && s.why.includes('sync'))`));
  ev(`window.scanReq=0; socket.request=()=>{scanReq++;return Promise.resolve({pip_size:2,history:{prices:[12.34],times:[1]}})};
      window.staleScan=null; scanDigits('R_50',3).then(v=>staleScan=v);`);
  await waitFor(()=>ev('staleScan!==null'));
  check('market scan refetches instead of using a stale buffered window', ev(`scanReq===1 && JSON.stringify(staleScan)==='[4]'`));
  // Exercise an ordinary imported/direct DBot separately from the Free bots.
  ev(`state.bot.running=false; DBots.pending=null; DBots.pendingSignal=false; DBots.uncertainOrder=false;
      DBots.cfg=DBots.parse(DBots.template('direct').xml); DBots.running=true; DBots.runId=222; DBots.busy=false; DBots.fast=true; DBots.lastEpoch=0;
      DBots.vars=Object.assign({},DBots.cfg.vars); DBots.baseStake=1; DBots.nextStake=1;
      window.dReq=[]; window.dQuote=null; socket.request=req=>{dReq.push(req); if(req.proposal)return new Promise(resolve=>dQuote=resolve);return Promise.resolve({});};
      Markets.push(DBots.cfg.market,{epoch:2000001234,quote:'12.34',pip_size:2});`);
  await waitFor(()=>ev('dQuote !== null'));
  ev(`DBots.stop('test before quote'); dQuote({proposal:{id:'q',ask_price:1}})`); await sleep(20);
  check('imported DBot stop before quote prevents a buy', ev(`!DBots.running && !DBots.tradeInFlight && dReq.filter(r=>r.buy).length===0`));
  ev(`DBots.running=true; DBots.runId=223; DBots.busy=false; DBots.lastEpoch=0; window.dReq=[]; window.dBuy=null;
      socket.request=req=>{dReq.push(req); if(req.proposal)return Promise.resolve({proposal:{id:'q',ask_price:1}}); if(req.buy)return new Promise(resolve=>dBuy=resolve);return Promise.resolve({});};
      socket.stream=(key,req,handler)=>{window.dWatch=handler;return Promise.resolve()};
      Markets.push(DBots.cfg.market,{epoch:2000001235,quote:'12.35',pip_size:2});`);
  await waitFor(()=>ev('dBuy !== null'));
  ev(`DBots.stop('test during buy'); dBuy({buy:{contract_id:994,buy_price:1,payout:2}})`);
  await waitFor(()=>ev('DBots.pending===994'));
  check('imported DBot tracks a buy that resolves after stop', ev(`!DBots.running && DBots.pending===994`));
  ev(`dWatch({proposal_open_contract:{contract_id:995,is_sold:1,profit:1,status:'won',buy_price:1,payout:2}})`);
  check('DBot ignores settlement for another contract', ev(`DBots.pending===994`));
  ev(`dWatch({proposal_open_contract:{contract_id:994,is_sold:1,profit:1,status:'won',buy_price:1,payout:2}})`);
  check('imported DBot releases its stopped contract on settlement', ev(`DBots.pending==null && !DBots.running`));
  ev(`Markets.data.delete('1HZ25V'); window.retryHistoryCount=0;
      Object.assign(Markets.buf('1HZ25V'),{live:true,primed:false,primedAt:Date.now()-9000});
      socket.request=req=>{ if(req.ticks_history)retryHistoryCount++;return Promise.resolve({pip_size:2,history:{prices:[1.23],times:[123]}}) };
      Markets.push('1HZ25V',{epoch:124,quote:1.24,pip_size:2});`);
  await waitFor(()=>ev(`Markets.buf('1HZ25V').primed`));
  check('live ticks retry a failed history backfill after the cooldown', ev(`retryHistoryCount===1 && Markets.buf('1HZ25V').primed`));
  // A stream queued before connect should not also be restored on first open.
  const framesBefore=frames.length;
  ev(`window.ds2=new DerivSocket('wss://fake',false); window.streamDone=false; ds2.connect(); ds2.stream('ticks:R_25',{ticks:'R_25'},()=>{},()=>{}).then(()=>streamDone=true)`);
  await waitFor(()=>ev('streamDone'));
  check('initial connection sends each subscription only once', frames.slice(framesBefore).filter(f=>f.ticks==='R_25').length===1);
  ev(`ds2.disconnect()`);
  // Manual digit strip: the selected prediction and latest live digit are independent.
  ev(`socket.status='open'; state.tab='manual'; state.market='R_50'; state.analysisWindow=25;
      Markets.buf('R_50').ticks=[]; Markets.buf('R_50').live=true; Markets.buf('R_50').primed=true;
      document.getElementById('ct').value='DIGITOVER'; setBarrierDigit(3);
      window.sample=[1,1,1,1,1,1,1,2,2,2,2,3,3,4,4,5,5,6,6,7,7,8,8,9,9];
      sample.forEach((d,i)=>Markets.push('R_50',{epoch:2200000000+i,quote:12+d/100,pip_size:2}));
      renderDigitHeat();`);
  check('strip colors the actual most and least frequent digits in the selected window', ev(`document.querySelector('#digitStrip [data-d="1"]').classList.contains('hot') && document.querySelector('#digitStrip [data-d="0"]').classList.contains('cold') && document.querySelectorAll('#digitStrip .hot').length===1`));
  check('prediction grid uses the same frequency colors', ev(`document.querySelector('#digitPick [data-d="1"]').classList.contains('hot') && document.querySelector('#digitPick [data-d="0"]').classList.contains('cold')`));
  check('live marker follows the latest tick, independent of the selected barrier', ev(`document.querySelector('#digitStrip [data-d="9"]').classList.contains('current') && document.querySelector('#digitStrip [data-d="3"]').classList.contains('picked') && document.querySelectorAll('#digitStrip .current').length===1`));
  check('prediction grid marks the same live digit without changing the barrier', ev(`document.querySelector('#digitPick [data-d="9"]').classList.contains('current') && document.querySelector('#digitPick [data-d="3"]').classList.contains('active') && document.querySelectorAll('#digitPick .current').length===1 && document.querySelector('#digitPick [data-d="9"]').getAttribute('aria-label').includes('latest live digit')`));
  ev(`Markets.push('R_50',{epoch:2200000025,quote:12.02,pip_size:2})`);
  await waitFor(()=>ev(`document.querySelector('#digitStrip [data-d="2"]').classList.contains('current')`));
  check('the live marker moves on the next tick without changing the prediction', ev(`document.querySelector('#digitStrip [data-d="2"]').classList.contains('current') && !document.querySelector('#digitStrip [data-d="9"]').classList.contains('current') && document.getElementById('barrier').value==='3'`));
  check('prediction-grid live marker moves and clears the previous digit', ev(`document.querySelector('#digitPick [data-d="2"]').classList.contains('current') && !document.querySelector('#digitPick [data-d="9"]').classList.contains('current') && document.querySelectorAll('#digitPick .current').length===1`));
  ev(`setBarrierDigit(2)`);
  check('the prediction can be selected while also showing the live marker', ev(`document.querySelector('#digitPick [data-d="2"]').classList.contains('current') && document.querySelector('#digitPick [data-d="2"]').classList.contains('active') && document.getElementById('barrier').value==='2'`));
  ev(`setBarrierDigit(3); state.market='R_25'; Markets.buf('R_25').ticks=[]; Markets.buf('R_25').live=true; Markets.push('R_25',{epoch:2200000200,quote:12.34,pip_size:2}); renderDigitHeat()`);
  check('prediction marker follows the newly selected market', ev(`document.querySelector('#digitPick [data-d="4"]').classList.contains('current') && document.querySelectorAll('#digitPick .current').length===1 && document.getElementById('barrier').value==='3'`));
  ev(`MARKETS.R_25.pip=null; Markets.buf('R_25').ticks=[]; Markets.push('R_25',{epoch:2200000201,quote:12.3}); renderDigitHeat()`);
  check('unknown price precision does not invent a live prediction marker', ev(`document.querySelectorAll('#digitPick .current').length===0`));
  ev(`state.market='R_50'; renderDigitHeat()`);
  ev(`Markets.buf('R_50').ticks=[]; for(let d=0;d<10;d++) Markets.push('R_50',{epoch:2200000100+d,quote:12+d/100,pip_size:2}); renderDigitHeat()`);
  check('an exactly tied distribution has no misleading high or low color', ev(`document.querySelectorAll('#digitStrip .hot, #digitStrip .cold').length===0 && document.querySelectorAll('#digitStrip .current').length===1`));
  ev(`Markets.push('R_50',{epoch:2200000110,quote:12.01,pip_size:2}); Markets.push('R_50',{epoch:2200000111,quote:12.02,pip_size:2}); renderDigitHeat()`);
  check('all digits tied for the most or least occurrences are highlighted', ev(`document.querySelectorAll('#digitStrip .hot').length===2 && document.querySelectorAll('#digitStrip .cold').length===8`));
  ev(`socket.setStatus('closed','test')`);
  check('disconnect clears the live cursor and stale digit display', ev(`document.querySelectorAll('#digitStrip .current').length===0 && document.getElementById('tickDigitMini').textContent==='—'`));
  check('disconnect also clears the prediction-grid live marker without changing the barrier', ev(`document.querySelectorAll('#digitPick .current').length===0 && document.querySelector('#digitPick [data-d="3"]').classList.contains('active') && document.getElementById('barrier').value==='3'`));
  check('digit strip includes an accessible color and live-marker key', ev(`document.querySelector('.digit-key').textContent.includes('Most') && document.querySelector('.digit-key').textContent.includes('Least') && document.querySelector('.digit-key').textContent.includes('Live digit')`));
  const errors=jsdomErrors.filter(m=>!/getContext|canvas|scrollTo/i.test(m));
  if(errors.length) console.log('jsdom errors:',errors.slice(0,5));
  console.log(`\n${passed} passed, ${failed} failed`);window.close();process.exit(failed?1:0);
})().catch(e=>{console.error(e);process.exit(2)});
