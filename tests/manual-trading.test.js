"use strict";
/* Manual-order safety checks against the actual page using a fake Deriv socket.
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
(async () => {
  await waitFor(() => ev('socket.ws && socket.ws.readyState===1'));
  await sleep(150);
  ev(`state.auth={loginid:'VRTC_TEST',is_virtual:true,currency:'USD'}; state.token='test'; state.accountType='demo'; state.balance=100; state.currency='USD';
      scheduleProposal=()=>{}; subscribeOpenContract=()=>{}; loadProfitTable=()=>{};
      state.market='R_50'; state.stake=1; document.getElementById('ct').value='DIGITOVER'; document.getElementById('barrier').value='4'; document.getElementById('dur').value='1';
      window.reqs=[]; socket.request=req=>{reqs.push(req); if(req.proposal)return Promise.resolve({proposal:{id:'fresh',contract_type:req.contract_type,ask_price:req.amount,payout:2}}); if(req.buy)return Promise.resolve({buy:{contract_id:777,contract_type:'DIGITOVER',buy_price:1,payout:2}});return Promise.resolve({});};`);

  // A disconnected socket must never queue a buy for some future connection.
  ev(`window.disconnected=new DerivSocket('wss://fake',false); window.notSent=null;
      disconnected.request({buy:'old',price:1},100).catch(e=>notSent=e.code)`);
  await waitFor(()=>ev('notSent!==null'));
  check('a buy is rejected instead of waiting for a future socket', ev(`notSent==='SOCKET' && !disconnected.ws`));
  ev(`state.proposalAt=Date.now(); ticketDirty=false; Markets.push('R_50',{epoch:1999999000,quote:12.34,pip_size:2})`);
  check('each new tick marks ticket prices for refresh', ev('ticketDirty'));

  ev(`document.getElementById('barrier').value='9'; updateBuyState()`);
  check('Over 9 is disabled without disabling valid Under 9', ev(`document.getElementById('btnBuy').disabled && !document.getElementById('btnBuyAlt').disabled`));
  ev(`document.getElementById('barrier').value='0'; updateBuyState()`);
  check('Under 0 is disabled without disabling valid Over 0', ev(`!document.getElementById('btnBuy').disabled && document.getElementById('btnBuyAlt').disabled`));
  ev(`document.getElementById('barrier').value='4'; updateBuyState()`);

  ev(`document.getElementById('stake').value='2.75'; document.getElementById('stake').dispatchEvent(new Event('input',{bubbles:true}))`);
  check('typing a stake immediately updates the executable amount without changing the field', ev(`state.stake===2.75 && document.getElementById('stake').value==='2.75' && ticketRequestFor('DIGITOVER').amount==='2.75'`));
  ev(`state.stake=1; document.getElementById('stake').value='1'`);

  // Quotes are cached for speed only when every contract parameter still matches.
  ev(`window.oldReq=ticketRequestFor('DIGITOVER'); state.proposal={id:'old',contract_type:'DIGITOVER',ask_price:1,payout:2,__request:JSON.stringify(oldReq),__account:state.auth.loginid,__generation:socket.generation}; state.stake=3;`);
  await ev(`instantBuy('up')`);
  check('changed stake rejects stale cached quote and requests correct parameters', ev(`reqs[0].proposal===1 && reqs[0].amount==='3.00' && reqs[1].buy==='fresh'`));
  ev(`window.reqs=[]; window.sameReq=ticketRequestFor('DIGITOVER'); state.proposal={id:'cached',contract_type:'DIGITOVER',ask_price:3,payout:4,__request:JSON.stringify(sameReq),__account:state.auth.loginid,__generation:socket.generation}`);
  await ev(`instantBuy('up')`);
  check('matching cached quote still buys without an extra proposal round trip', ev(`reqs.length===1 && reqs[0].buy==='cached'`));

  ev(`state.proposal=null; window.reqs=[]; window.finishQuote=null; socket.request=req=>{reqs.push(req); if(req.proposal)return new Promise(resolve=>finishQuote=resolve); return Promise.resolve({});}; window.pendingBuy=instantBuy('up')`);
  await waitFor(()=>ev('finishQuote!==null'));
  ev(`state.market='R_100'; finishQuote({proposal:{id:'q',contract_type:'DIGITOVER',ask_price:3}})`);
  await ev('pendingBuy');
  check('market changes during manual pricing cancel the buy', ev(`reqs.filter(r=>r.buy).length===0`));

  // A response from an old quote batch must never overwrite the new ticket.
  ev(`state.market='R_50'; state.proposal=null; state.proposalAlt=null; window.quoteResolvers=[]; window.reqs=[];
      socket.request=req=>{reqs.push(req); if(req.proposal)return new Promise(resolve=>quoteResolvers.push({resolve,req})); return Promise.resolve({})};
      window.batch=refreshProposal(true);`);
  await waitFor(()=>ev('quoteResolvers.length===2'));
  ev(`state.stake=5; quoteResolvers.forEach(x=>x.resolve({proposal:{id:'stale',contract_type:x.req.contract_type,ask_price:3,payout:4}}))`);
  await ev('batch');
  check('late quote batch cannot overwrite a changed ticket', ev(`state.proposal===null && state.proposalAlt===null`));
  // Let the queued refresh complete on the current parameters.
  ev(`socket.request=req=>Promise.resolve({proposal:{id:'new',contract_type:req.contract_type,ask_price:req.amount,payout:7}})`);
  await sleep(100);
  check('queued refresh displays only the current ticket quote', ev(`state.proposal && state.proposal.__request===JSON.stringify(ticketRequestFor('DIGITOVER')) && Number(state.proposal.ask_price)===5`));

  ev(`document.getElementById('barrier').value='9'; state.proposal=null; state.proposalAlt=null;
      socket.request=req=>req.contract_type==='DIGITOVER' ? Promise.reject({code:'InvalidBarrier',message:'Invalid barrier'}) : Promise.resolve({proposal:{id:'valid-under',contract_type:req.contract_type,ask_price:req.amount,payout:6,spot:12.34}});
      window.partialBatch=refreshProposal(true)`);
  await ev('partialBatch');
  check('a failed side quote does not hide the valid opposite payout', ev(`!state.proposal && state.proposalAlt && document.getElementById('unPayout').textContent!=='—'`));
  ev(`document.getElementById('barrier').value='4'; state.proposal=null; state.proposalAlt=null`);

  ev(`window.reqs=[]; state.proposal=null; socket.request=req=>{reqs.push(req);return Promise.resolve({proposal:{contract_type:req.contract_type,ask_price:5}})}; window.badQuote=instantBuy('up')`);
  await ev('badQuote');
  check('a malformed quote never results in a buy', ev(`reqs.length===1 && reqs[0].proposal && !state.orderUncertain`));

  // Only explicit price-moved failures may be retried; a changed ticket cancels retry.
  ev(`state.proposal=null; window.reqs=[]; window.retryQuote=null; socket.request=req=>{reqs.push(req); if(req.buy)return Promise.reject({code:'PriceMoved',message:'Price moved'});
      if(req.proposal && reqs.filter(x=>x.proposal).length===1)return Promise.resolve({proposal:{id:'initial',contract_type:req.contract_type,ask_price:5}});
      if(req.proposal)return new Promise(resolve=>retryQuote=resolve);return Promise.resolve({});}; window.retrying=instantBuy('up')`);
  await waitFor(()=>ev('retryQuote!==null'));
  ev(`state.stake=9; retryQuote({proposal:{id:'retry',contract_type:'DIGITOVER',ask_price:5}})`);
  await ev('retrying');
  check('changed ticket prevents a second buy after a price-moved retry', ev(`reqs.filter(r=>r.buy).length===1`));

  ev(`state.market='R_50'; state.stake=1; state.proposal=null; window.reqs=[]; window.qResolve=null;
      socket.request=req=>{reqs.push(req); if(req.proposal)return new Promise(resolve=>qResolve=resolve); return Promise.resolve({})};
      window.quick=quickTrade({def:{type:'DIGITMATCH',barrier:7,label:'Matches 7'}},null)`);
  await waitFor(()=>ev('qResolve!==null'));
  ev(`state.market='R_100'; qResolve({proposal:{id:'quick',ask_price:1,payout:2}})`);
  await ev('quick');
  check('quick quote cannot prompt or buy after a market change', ev(`reqs.filter(r=>r.buy).length===0 && document.getElementById('modalBack').classList.contains('hidden')`));

  ev(`state.market='R_50'; window.reqs=[]; socket.request=req=>{reqs.push(req); if(req.proposal)return Promise.resolve({proposal:{id:'quick2',ask_price:1,payout:2}});return Promise.resolve({})};
      window.quick=quickTrade({def:{type:'DIGITMATCH',barrier:7,label:'Matches 7'}},null)`);
  await waitFor(()=>ev(`!document.getElementById('modalBack').classList.contains('hidden')`));
  ev(`quickTrade({def:{type:'DIGITMATCH',barrier:7,label:'Matches 7'}},null)`);
  check('concurrent quick clicks cannot create overlapping confirmations', ev(`reqs.filter(r=>r.proposal).length===1`));
  ev(`state.auth.loginid='VRTC_OTHER'; closeModal(true)`);
  await ev('quick');
  check('quick confirmation cannot buy on a changed account', ev(`reqs.filter(r=>r.buy).length===0`));
  ev(`state.auth.loginid='VRTC_TEST'`);

  ev(`state.accountType='real'; validateBotSettings(); document.getElementById('btnBotStart').click()`);
  const autoConfirmation = await waitFor(()=>ev(`!document.getElementById('modalBack').classList.contains('hidden')`));
  check('Auto Bot real-account confirmation opens', autoConfirmation);
  ev(`socket.generation++; closeModal(true)`);
  await sleep(20);
  check('connection replacement during confirmation cancels Auto Bot start', ev(`!state.bot.running`));
  ev(`state.accountType='demo'`);

  ev(`window.firstModal=confirmDialog('First','first','OK',false); window.secondModal=confirmDialog('Second','second','OK',false)`);
  check('a second confirmation cannot replace the first', !(await ev('secondModal')) && ev(`document.getElementById('modalTitle').textContent==='First'`));
  ev('closeModal(true)');
  check('the original confirmation still resolves', await ev('firstModal'));

  ev(`window.reqs=[]; state.proposal=null; state.bot.running=true; state.bot.tradeInFlight=false; state.bot.pendingContract=null;
      DBots.running=true; DBots.pending=null; DBots.signalTradeInFlight=false; DBots.tradeInFlight=false;
      socket.request=req=>{reqs.push(req); if(req.proposal)return Promise.resolve({proposal:{id:'unknown',contract_type:req.contract_type,ask_price:1}}); if(req.buy)return Promise.reject({code:'CLOSED',message:'connection lost'});return Promise.resolve({})}`);
  await ev(`instantBuy('up')`);
  check('unknown manual buy stops both bots and locks all new orders', ev(`state.orderUncertain && !state.bot.running && !DBots.running && document.getElementById('btnBuy').disabled`));
  ev(`window.before=reqs.length; instantBuy('up'); quickTrade({def:{type:'DIGITMATCH',barrier:7,label:'Matches 7'}},null); document.getElementById('btnBotStart').click(); DBots.start()`);
  await sleep(20);
  check('unknown order blocks manual, quick, Auto Bot and DBot restarts', ev(`reqs.length===before && !state.bot.running && !DBots.running`));

  const errors=jsdomErrors.filter(e=>!/HTMLCanvasElement|navigation|not implemented/i.test(e));
  if(errors.length) check('no unexpected page errors',false,errors.join('; '));
  console.log(`\n${passed} passed, ${failed} failed`);
  dom.window.close();
  process.exitCode=failed?1:0;
})().catch(err=>{console.error(err);dom.window.close();process.exitCode=2});
