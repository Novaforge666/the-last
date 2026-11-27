'use strict';
// Exercise serverless validation without making network requests.
const rest = require('../api/deriv-rest');
const oauth = require('../api/deriv-oauth-token');
let passed = 0, failed = 0, calls = [];
function check(name, value) {
  if (value) { passed++; console.log('  PASS ' + name); }
  else { failed++; console.log('  FAIL ' + name); }
}
async function invoke(handler, method, body) {
  const res = { headers:{}, setHeader(k,v){this.headers[k]=v}, end(data){this.body=JSON.parse(data)} };
  await handler({method,body}, res);
  return res;
}
global.fetch = async (url, options) => {
  calls.push({url, options});
  if (String(url).includes('oauth')) return {ok:true,status:200,json:async()=>({access_token:'fake_access',expires_in:60})};
  return {ok:true,status:200,json:async()=>({data:{accounts:[]}})};
};
(async () => {
  let r = await invoke(rest,'GET',{});
  check('REST relay rejects unsupported HTTP methods', r.statusCode===405 && calls.length===0);
  r = await invoke(rest,'POST',{path:'https://evil.example/',token:'test'});
  check('REST relay rejects external URLs', r.statusCode===403 && calls.length===0);
  r = await invoke(rest,'POST',{path:'/trading/v1/options/accounts/../secret/otp',token:'test'});
  check('REST relay rejects path traversal', r.statusCode===403 && calls.length===0);
  r = await invoke(rest,'POST',{path:'/trading/v1/options/accounts'});
  check('REST relay requires a token', r.statusCode===401 && calls.length===0);
  r = await invoke(rest,'POST',{path:'/trading/v1/options/accounts',token:'test-token',method:'GET'});
  check('REST relay only forwards approved account path', r.statusCode===200 && calls.length===1 && calls[0].url==='https://api.derivws.com/trading/v1/options/accounts');
  check('REST relay responses are marked no-store', r.headers['Cache-Control']==='no-store');
  calls=[];
  r = await invoke(oauth,'GET',{});
  check('OAuth exchange rejects unsupported methods',r.statusCode===405 && calls.length===0);
  const env = process.env.DERIV_CLIENT_ID;
  delete process.env.DERIV_CLIENT_ID;
  const body = {code:'fake-code',code_verifier:'a'.repeat(43),client_id:'test-client',redirect_uri:'https://evil.example/'};
  r=await invoke(oauth,'POST',body);
  check('OAuth exchange rejects unapproved redirect hosts',r.statusCode===400 && calls.length===0);
  r=await invoke(oauth,'POST',{...body,redirect_uri:'https://the-last-weld.vercel.app/',code_verifier:'bad'});
  check('OAuth exchange rejects invalid PKCE verifier',r.statusCode===400 && calls.length===0);
  r=await invoke(oauth,'POST',{...body,redirect_uri:'https://the-last-weld.vercel.app/'});
  check('OAuth exchange sends valid request to Deriv only',r.statusCode===200 && calls.length===1 && new URL(calls[0].url).hostname==='auth.deriv.com');
  check('OAuth response is marked no-store',r.headers['Cache-Control']==='no-store');
  if (env !== undefined) process.env.DERIV_CLIENT_ID=env;
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode=failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=2});
