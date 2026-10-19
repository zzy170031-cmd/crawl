import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Tasks } from "../app/tasks.mjs";
import { SideBridge } from "../app/side-bridge.mjs";
import { openStore, recordsForLatest } from "../app/store.mjs";
import {
  startCollectionWorker,
  validateLoginInput,
} from "../app/collection-worker.mjs";
import { collectionRecoveryKey } from "../app/collection-recovery.mjs";
import { collectionProvenance } from "../app/collection-provenance.mjs";

async function fixture(t, collect, options = {}) {
  const folder = await mkdtemp(join(tmpdir(), "crawl-collection-"));
  const db = new Tasks(folder),
    bridge = new SideBridge(db),
    store = openStore(join(folder, "hotspots.sqlite"));
  let closed = 0;
  const collector = {
    collect,
    status: () => ({ state: "ready" }),
    login: async (site) => ({ site }),
    verifyLogin: async (site) => ({site,state:"ready",native_verified:true}),
    resume: async () => {},
    close: async () => {
      closed++;
    },
  };
  const worker = startCollectionWorker({
    db,
    bridge,
    store,
    collector,
    enabled: true,
    autoStart: false,
    ...options,
  });
  t.after(async () => {
    await worker.stop();
    store.close();
    db.close();
    await rm(folder, { recursive: true, force: true });
  });
  return { db, bridge, store, worker, collector, closed: () => closed };
}
function result(input, id = "1234567890123456789") {
  const at = new Date().toISOString();
  return {
    records: id
      ? [
          {
            kind: "video",
            source_id: id,
            title: "真实页面测试夹具",
            author: "作者",
            source_url: `https://www.douyin.com/video/${id}`,
            observed_url:
              input.purpose === "hotspots"
                ? "https://douhot.douyin.com/square/hotspot"
                : `https://www.douyin.com/search/${encodeURIComponent(input.keyword)}`,
            collected_at: at,
          },
        ]
      : [],
    failures: [],
    searched_at: at,
    scope: "受控依赖测试，不是真实平台验收",
    ...(input.purpose === "hotspots"
      ? {
          observed_scope: {
            boards: [input.board || 1001],
            hours: input.hours,
            category: input.category,
          },
        }
      : {}),
  };
}
const game = (keyword = "率土之滨") => ({ keyword, purpose: "game-research" });
const hot = (hours = 24, category = "all") => ({
  purpose: "hotspots",
  board: 1001,
  hours,
  category,
});

test('paid request is rechecked under claim transaction after asynchronous eligibility',async t=>{
  let id,calls=0;
  const f=await fixture(t,async()=>{calls++;throw Error('must not run');},{canRun:async()=>{
    // Another owner paid for this request and lost its lease while our gate
    // awaited. The pre-gate check alone cannot protect against a duplicate fee.
    f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,attempts,lease) VALUES(?,'interrupted',1,0)").run(id);
    return true;
  }});
  f.collector.isIndependentRequest=payload=>payload.provider==='redfox';
  id=f.bridge.request('search',{...game(),provider:'redfox'}).id;
  assert.equal(await f.worker.runOnce(),false);assert.equal(calls,0);
  assert.equal(f.db.db.prepare('SELECT attempts FROM collection_jobs WHERE request_id=?').get(id).attempts,1);
  assert.equal(f.bridge.get(id).state,'pending');
});

test('paid request crossing Beijing midnight fails before source call even within the same UTC day',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;throw Error('must not charge');},{sourceClock:()=>new Date('2026-10-19T16:00:00.000Z')});
  f.collector.isIndependentRequest=payload=>payload.provider==='redfox';
  const req=f.bridge.request('search',{...game(),provider:'redfox'});
  f.db.db.prepare('UPDATE bridge_requests SET created_at=? WHERE id=?').run('2026-10-19T15:59:59.999Z',req.id);
  assert.equal(await f.worker.runOnce(),true);assert.equal(calls,0);
  assert.equal(f.bridge.get(req.id).state,'failed');assert.match(f.bridge.get(req.id).error,/日期已变化.*未调用红狐/);
  assert.equal(f.store.all().length,0);
});

test('paid request within the same Beijing date can proceed across UTC midnight',async t=>{
  let calls=0;
  const f=await fixture(t,async()=>{calls++;throw Error('controlled transport failure');},{sourceClock:()=>new Date('2026-10-20T00:00:00.001Z')});
  f.collector.isIndependentRequest=payload=>payload.provider==='redfox';
  const req=f.bridge.request('search',{...game(),provider:'redfox'});
  f.db.db.prepare('UPDATE bridge_requests SET created_at=? WHERE id=?').run('2026-10-19T23:59:59.999Z',req.id);
  assert.equal(await f.worker.runOnce(),true);assert.equal(calls,1);
  assert.doesNotMatch(f.bridge.get(req.id).error,/日期已变化/);
});

test('browser login confirmation never recreates failed paid API requests',async t=>{
  const f=await fixture(t,async()=>{throw Error('must not charge');},{canRun:()=>false});
  f.collector.isIndependentRequest=payload=>payload.provider==='redfox';
  const req=f.bridge.request('search',{...game(),provider:'redfox'});f.bridge.update(req.id,'failed',null,'LOGIN_REQUIRED: old API failure');
  f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,attempts,error_code) VALUES(?,'failed',1,'LOGIN_REQUIRED')").run(req.id);
  const session=await f.worker.login('douyin');
  const resumed=await f.worker.resume('douyin',session.login_session_id);
  assert.deepEqual(resumed.retried_request_ids,[]);assert.equal(f.bridge.list().length,1);assert.equal(f.bridge.get(req.id).state,'failed');
});

test("source failure identity survives worker, persisted bridge and API provenance without relabelling cached rows", async t => {
  const codes = ["LOGIN_REQUIRED", "VERIFICATION_REQUIRED", "ACCESS_RESTRICTED",
    "SOURCE_TIMEOUT", "SOURCE_RESPONSE_TIMEOUT", "SOURCE_UNAVAILABLE",
    "MEDIA_UNAVAILABLE", "SOURCE_FAILED", "OPERATION_CLEANUP_FAILED", "CLOSE_TIMEOUT", "UNTRUSTED_SOURCE_CODE"];
  for (const sourceCode of codes) await t.test(sourceCode, async child => {
    let fail = false, calls = 0;
    const f = await fixture(child, async input => {
      calls++;
      if (fail) throw Object.assign(Error("来源失败测试"), {code: sourceCode});
      return result(input);
    });
    const prior = f.bridge.request("search", game());
    await f.worker.runOnce();
    const before = f.store.all();
    fail = true;
    const current = f.bridge.request("search", game());
    await f.worker.runOnce();
    const expected = sourceCode === "UNTRUSTED_SOURCE_CODE" ? "SOURCE_FAILED" : sourceCode;
    const request = f.bridge.get(current.id);
    assert.equal(request.state, "failed");
    assert.equal(request.error_code, expected);
    assert.equal(request.error, `${expected}: 来源失败测试`);
    assert.equal(request.result, null);
    assert.equal((await f.worker.status()).recent.find(row=>row.request_id===current.id).error_code, expected);
    await assert.rejects(f.bridge.wait(request), {code: expected});
    assert.deepEqual(f.store.all(), before);
    const publicRequest = JSON.parse(JSON.stringify(f.bridge.public(request)));
    assert.equal(publicRequest.error_code, expected);
    assert.equal(Object.hasOwn(publicRequest, "request_key"), false);
    const api = JSON.parse(JSON.stringify(collectionProvenance(
      f.bridge.latestSearchForScope(game()), recordsForLatest(f.store.all()))));
    assert.equal(api.collection.latest_request.id, current.id);
    assert.equal(api.collection.latest_request.error_code, expected);
    assert.equal(api.collection.status, "failed");
    assert.equal(api.collection.observed_scope, null);
    assert.equal(api.collection.returned_source_count, null);
    assert.equal(api.collection.current_source_count, 0);
    assert.equal(api.collection.historical_source_count, 1);
    assert.equal(api.records[0].collection_request_id, prior.id);
    if (["LOGIN_REQUIRED", "VERIFICATION_REQUIRED"].includes(sourceCode)) {
      const queued = f.bridge.request("search", game("星际猎人"));
      await f.worker.runOnce();
      assert.equal(f.bridge.get(queued.id).state, "pending");
      assert.equal(calls, 2);
      assert.equal(f.closed(), 0);
      assert.equal((await f.worker.status()).state, sourceCode === "VERIFICATION_REQUIRED" ? "verification_required" : "login_required");
    }
  });
});

test("automatic consumes persisted search, validates and imports without HTTP reads; duplicates execute once", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (input) => {
    calls++;
    return result(input);
  });
  const first = f.bridge.request("search", game());
  assert.equal(f.bridge.request("search", game()).id, first.id);
  await f.worker.runOnce();
  assert.equal(f.bridge.get(first.id).state, "fulfilled");
  assert.equal(recordsForLatest(f.store.all())[0].game, "率土之滨");
  assert.equal(f.db.checkpoint("bridge-import:" + first.id), true);
  await f.worker.runOnce();
  assert.equal(calls, 1);
});

test("automatic flag off never consumes a search and unsupported bridge kinds remain manual", async (t) => {
  const f = await fixture(
    t,
    () => {
      throw Error("must not call");
    },
    { enabled: false },
  );
  const search = f.bridge.request("search", game());
  const web = f.bridge.request("web", { game: "率土之滨" });
  await f.worker.runOnce();
  assert.equal(f.bridge.get(search.id).state, "pending");
  assert.equal(f.bridge.get(web.id).state, "pending");
  assert.equal((await f.worker.status()).state, "disabled");
});

test("empty observation clears only its own category/time scope", async (t) => {
  let empty = false;
  const f = await fixture(t, async (input) =>
    result(
      input,
      empty ? null : String(1234567890123450000n + BigInt(input.hours)),
    ),
  );
  for (const input of [hot(24, "628"), hot(72, "628"), hot(24, "608")]) {
    f.bridge.request("search", input);
    await f.worker.runOnce();
    await delay(2);
  }
  empty = true;
  f.bridge.request("search", hot(24, "628"));
  await f.worker.runOnce();
  const rows = recordsForLatest(f.store.all());
  assert.equal(rows.length, 2);
  assert(rows.some((r) => r.date_window === 72));
  assert(rows.some((r) => r.category_filter[0].value === 608));
});

test("invalid scope and source failure do not import or fulfill empty success", async (t) => {
  let mode = "wrong";
  const f = await fixture(t, async (input) =>
    mode === "wrong"
      ? {
          ...result(input),
          observed_scope: { boards: [1001], hours: 72, category: "all" },
        }
      : { ...result(input, null), failures: ["login failed"] },
  );
  const a = f.bridge.request("search", hot());
  await f.worker.runOnce();
  assert.equal(f.bridge.get(a.id).state, "failed");
  mode = "empty";
  const b = f.bridge.request("search", hot());
  await f.worker.runOnce();
  assert.equal(f.bridge.get(b.id).state, "failed");
  assert.equal(f.store.all().length, 0);
});

test("login failure pauses queue and resume does not replay an old search behind newer pending work", async (t) => {
  let loggedIn = false;
  const f = await fixture(t, async (input) => {
    if (!loggedIn)
      throw Object.assign(Error("需要用户验证码"), {
        code: "VERIFICATION_REQUIRED",
      });
    return result(input);
  });
  const a = f.bridge.request("search", game());
  await f.worker.runOnce();
  assert.equal((await f.worker.status()).state, "verification_required");
  const b = f.bridge.request("search", game("星际猎人"));
  await f.worker.runOnce();
  assert.equal(f.bridge.get(b.id).state, "pending");
  await assert.rejects(f.worker.login("https://evil.invalid"), /只允许/);
  await f.worker.login("douyin");
  assert.equal((await f.worker.status()).state, "login_open");
  loggedIn = true;
  const resumed = await f.worker.resume();
  assert.equal(resumed.retried_request_ids.length, 0);
  await delay(10);
  await f.worker.runOnce();
  assert.equal(f.bridge.get(a.id).state, "failed");
  assert.equal(f.bridge.get(b.id).state, "fulfilled");
});

test('login confirmation resumes only latest same-site search and never replays historical scopes',async(t)=>{
  const f=await fixture(t,input=>result(input),{canRun:()=>false});
  const ids=[];
  for(const payload of [game('老游戏'),game('新游戏'),hot(24,'all')]){
    const row=f.bridge.request('search',payload);ids.push(row.id);
    f.bridge.update(row.id,'failed',null,'验证失败');
    f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,error_code) VALUES(?,'failed','VERIFICATION_REQUIRED')").run(row.id);
  }
  f.db.db.prepare('UPDATE bridge_requests SET created_at=?').run(new Date().toISOString());
  const session=await f.worker.login('douyin');
  const resumed=await f.worker.resume('douyin',session.login_session_id);
  assert.equal(resumed.retried_request_ids.length,1);
  assert.equal(f.bridge.get(resumed.retried_request_ids[0]).payload.keyword,'新游戏');
  assert.deepEqual(f.db.db.prepare("SELECT request_id FROM collection_events WHERE state='retry_requested'").all().map(row=>row.request_id),[ids[1]]);
  for(const id of ids) assert.equal(f.bridge.get(id).state,'failed');
});

test('latest successful different game prevents login confirmation replaying an older failed game',async(t)=>{
  const f=await fixture(t,input=>result(input),{canRun:()=>false});
  const old=f.bridge.request('search',game('老游戏'));
  f.bridge.update(old.id,'failed',null,'验证失败');
  f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,error_code) VALUES(?,'failed','VERIFICATION_REQUIRED')").run(old.id);
  const newer=f.bridge.request('search',game('新游戏'));
  f.bridge.update(newer.id,'fulfilled',{records:[]});
  const session=await f.worker.login('douyin');
  assert.deepEqual((await f.worker.resume('douyin',session.login_session_id)).retried_request_ids,[]);
});

test("finite timeout aborts source, closes browser and never imports late results", async (t) => {
  let aborted = false;
  const f = await fixture(
    t,
    async (input, { signal }) => {
      signal.addEventListener("abort", () => {
        aborted = true;
      });
      await delay(70);
      return result(input);
    },
    { timeoutMs: 15 },
  );
  const request = f.bridge.request("search", game());
  await f.worker.runOnce();
  await delay(90);
  assert(aborted);
  assert(f.closed() > 0);
  assert.equal(f.bridge.get(request.id).state, "failed");
  assert.match(f.bridge.get(request.id).error, /SOURCE_TIMEOUT/);
  assert.equal(f.store.all().length, 0);
});

test("timeout cancels owned operation, preserves verified browser, and explicit stop still closes it", async (t) => {
  const f = await fixture(t, async input => { await delay(60); return result(input); }, {timeoutMs: 10});
  let cancelled = 0;
  f.collector.cancelOperation = async () => { cancelled++; };
  const request = f.bridge.request("search", game());
  await f.worker.runOnce();
  assert.equal(cancelled, 1);
  assert.equal(f.closed(), 0);
  await delay(70);
  assert.equal(f.bridge.get(request.id).state, "failed");
  assert.equal(f.store.all().length, 0);
  await f.worker.stop();
  assert.equal(f.closed(), 1);
});

test("unresolved owned-page cleanup quarantines collector and blocks next request", async (t) => {
  let calls = 0, release;
  const f = await fixture(t, async input => { calls++; await delay(60); return result(input); }, {timeoutMs: 10, cleanupMs: 10});
  f.collector.cancelOperation = () => new Promise(resolve => { release = resolve; });
  f.bridge.request("search", game());
  await f.worker.runOnce();
  assert.match(f.db.setting("collector-blocked").message, /清理/);
  f.bridge.request("search", {...game(), keyword: "王者荣耀"});
  assert.equal(await f.worker.runOnce(), false);
  release();
  await delay(70);
  assert.equal(await f.worker.runOnce(), false);
  assert.equal(calls, 1);
  assert.equal(f.store.all().length, 0);
  assert.equal(f.closed(), 0);
});

test("non-timeout cleanup failure preserves pending queue and explicit login cleans before recovery", async (t) => {
  let calls = 0, cleanupFails = true;
  const f = await fixture(t, async input => {
    calls++;
    if(calls === 1) throw Object.assign(Error("临时采集页面关闭未确认"), {code:"OPERATION_CLEANUP_FAILED"});
    return result(input);
  });
  const first = f.bridge.request("search", game());
  const second = f.bridge.request("search", {...game(),keyword:"王者荣耀"});
  f.db.db.prepare("UPDATE bridge_requests SET created_at=? WHERE id IN (?,?)").run(new Date().toISOString(),first.id,second.id);
  await f.worker.runOnce();
  assert.equal(f.bridge.get(first.id).state,"failed");
  assert.equal(await f.worker.runOnce(),false);
  assert.equal(f.bridge.get(second.id).state,"pending");
  let logins=0;
  f.collector.cancelOperation=async()=>{if(cleanupFails) throw Error("页面尚未关闭");};
  f.collector.login=async()=>{logins++;};
  await assert.rejects(f.worker.login("douyin"),{code:"OPERATION_CLEANUP_FAILED"});
  assert.equal(logins,0);
  assert.equal(await f.worker.runOnce(),false);
  cleanupFails=false;
  const session=await f.worker.login("douyin");
  await f.worker.resume("douyin",session.login_session_id);
  await delay(20); // Explicit resume kicks the pending queue.
  assert.equal(f.bridge.get(second.id).state,"fulfilled");
});

test("source cooldown keeps a different queued scope pending before continuing", async (t) => {
  let calls=0;
  const f=await fixture(t,async input=>{calls++;return result(input);},{minRequestIntervalMs:80});
  const first=f.bridge.request("search",game());
  await f.worker.runOnce();
  const second=f.bridge.request("search",{...game(),keyword:"王者荣耀"});
  assert.equal(await f.worker.runOnce(),false);
  assert.equal(f.bridge.get(first.id).state,"fulfilled");
  assert.equal(f.bridge.get(second.id).state,"pending");
  assert.equal(calls,1);
  assert((await f.worker.status()).next_request_at);
  await delay(90);
  await f.worker.runOnce();
  assert.equal(f.bridge.get(second.id).state,"fulfilled");
  assert.equal(calls,2);
});

test("challenge recovery retries and claims only the bound search scope while other failures and pending work remain unchanged", async(t)=>{
  let recoveryScope=null;const calls=[];
  const f=await fixture(t,async input=>{
    calls.push(input.keyword);
    if(calls.length===1){recoveryScope=collectionRecoveryKey(input);throw Object.assign(Error('需要手动验证'),{code:'VERIFICATION_REQUIRED'});}
    recoveryScope=null;return result(input);
  });
  f.collector.status=()=>({recovery_scope_key:recoveryScope});
  f.collector.resume=async()=>({retry_scope_key:recoveryScope});
  const unrelatedFailed=f.bridge.request('search',{...game(),keyword:'之前失败的游戏'});
  f.bridge.update(unrelatedFailed.id,'failed',null,'先前验证失败');
  f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,error_code) VALUES(?,'failed','VERIFICATION_REQUIRED')").run(unrelatedFailed.id);
  const wanted=f.bridge.request('search',game());await f.worker.runOnce();assert.equal(f.bridge.get(wanted.id).state,'failed');
  const waiting=f.bridge.request('search',{...game(),keyword:'另一个等待的游戏'});
  const session=await f.worker.login('douyin');
  const resumed=await f.worker.resume('douyin',session.login_session_id);
  assert.equal(resumed.retried_request_ids.length,1);
  assert.equal(f.bridge.get(resumed.retried_request_ids[0]).payload.keyword,game().keyword);
  await delay(20);
  assert.equal(f.bridge.get(resumed.retried_request_ids[0]).state,'fulfilled');
  assert.equal(f.bridge.get(waiting.id).state,'pending');
  assert.equal(f.bridge.get(unrelatedFailed.id).state,'failed');
  assert.deepEqual(calls,[game().keyword,game().keyword]);
});

test('resume does not retry a verification failure superseded by a fulfilled request in the same millisecond',async(t)=>{
 const f=await fixture(t,input=>result(input),{canRun:()=>false});
 const old=f.bridge.request('search',game());f.bridge.update(old.id,'failed',null,'验证失败');
 f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,error_code) VALUES(?,'failed','VERIFICATION_REQUIRED')").run(old.id);
 const newer=f.bridge.request('search',game());f.bridge.update(newer.id,'fulfilled',{records:[]});
 f.db.db.prepare('UPDATE bridge_requests SET created_at=? WHERE id IN (?,?)').run(new Date().toISOString(),old.id,newer.id);
 const session=await f.worker.login('douyin');const resumed=await f.worker.resume('douyin',session.login_session_id);
 assert.deepEqual(resumed.retried_request_ids,[]);
 assert.equal(f.db.db.prepare('SELECT count(*) AS n FROM bridge_requests').get().n,2);
 assert.equal(f.bridge.get(newer.id).state,'fulfilled');
});

test('resume retries only the last inserted of several same-millisecond verification failures',async(t)=>{
 const f=await fixture(t,input=>result(input),{canRun:()=>false});const ids=[];
 for(let i=0;i<3;i++){
  const row=f.bridge.request('search',game());ids.push(row.id);f.bridge.update(row.id,'failed',null,'验证失败');
  f.db.db.prepare("INSERT INTO collection_jobs(request_id,state,error_code) VALUES(?,'failed','VERIFICATION_REQUIRED')").run(row.id);
 }
 f.db.db.prepare('UPDATE bridge_requests SET created_at=?').run(new Date().toISOString());
 const session=await f.worker.login('douyin');const resumed=await f.worker.resume('douyin',session.login_session_id);
 assert.equal(resumed.retried_request_ids.length,1);
 const events=f.db.db.prepare("SELECT request_id FROM collection_events WHERE state='retry_requested'").all();
 assert.deepEqual(events.map(row=>row.request_id),[ids.at(-1)]);
 assert.equal(f.bridge.get(resumed.retried_request_ids[0]).state,'pending');
});

test("cooldown is rechecked under lease when another worker finishes during readiness await", async(t)=>{
  let release, entered;
  const started=new Promise(resolve=>{entered=resolve;});
  const f=await fixture(t,async input=>result(input),{
    minRequestIntervalMs:60000,canRun:()=>{entered();return new Promise(resolve=>{release=resolve;});},
  });
  const other=startCollectionWorker({db:f.db,bridge:f.bridge,store:f.store,collector:f.collector,enabled:true,autoStart:false,minRequestIntervalMs:60000});
  try{
    f.bridge.request("search",game());
    const waiting=f.worker.runOnce();await started;
    assert.equal(await other.runOnce(),true);
    const next=f.bridge.request("search",{...game(),keyword:"王者荣耀"});
    release(true);
    assert.equal(await waiting,false);
    assert.equal(f.bridge.get(next.id).state,"pending");
  }finally{await other.stop();}
});

test("persistent global lease prevents two workers and expired request lease recovers", async (t) => {
  let calls = 0;
  const f = await fixture(t, async (input) => {
    calls++;
    await delay(30);
    return result(input);
  });
  const request = f.bridge.request("search", game());
  f.db.db
    .prepare(
      "INSERT INTO collection_jobs(request_id,state,owner,lease,attempts) VALUES(?,'running','dead-process',?,1)",
    )
    .run(request.id, Date.now() - 1);
  const other = startCollectionWorker({
    ...f,
    collector: f.collector,
    enabled: true,
    autoStart: false,
  });
  const running = f.worker.runOnce();
  assert.equal(await other.runOnce(), false);
  await running;
  assert.equal(calls, 1);
  await other.stop();
  assert.equal(
    f.db.db
      .prepare("SELECT attempts FROM collection_jobs WHERE request_id=?")
      .get(request.id).attempts,
    2,
  );
});

test("cancelled task search cannot accept delayed result", async (t) => {
  const f = await fixture(
    t,
    async (input) => {
      await delay(50);
      return result(input);
    },
    { leaseMs: 30 },
  );
  const task = f.db.create("learn", { game: "率土之滨" });
  const request = f.bridge.request("search", game(), { taskId: task.id });
  const running = f.worker.runOnce();
  await delay(5);
  f.db.cancel(task.id);
  await running;
  assert.equal(f.bridge.get(request.id).state, "cancelled");
  assert.equal(f.store.all().length, 0);
});

test("readiness gate holds persistent requests and connection failure invalidates availability", async (t) => {
  let ready = false;
  const failures = [];
  const f = await fixture(
    t,
    async () => {
      throw Object.assign(Error("会话过期"), { code: "LOGIN_REQUIRED" });
    },
    {
      canRun: () => ready,
      onConnectionFailure: (site, error) => {
        failures.push({ site, code: error.code });
        ready = false;
      },
    },
  );
  const request = f.bridge.request("search", hot());
  assert.equal(await f.worker.runOnce(), false);
  assert.equal(f.bridge.get(request.id).state, "pending");
  assert.equal(
    f.db.db.prepare("SELECT count(*) AS n FROM collection_jobs").get().n,
    0,
  );
  ready = true;
  await f.worker.runOnce();
  assert.deepEqual(failures, [{ site: "douhot", code: "LOGIN_REQUIRED" }]);
  assert.equal(ready, false);
});

test("actual probe uses exclusive source lease, never consumes queue and rejects arbitrary sites", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  f.collector.probe = async (site) => {
    await delay(20);
    return { site, state: "ready" };
  };
  f.bridge.request("search", game());
  const probe = f.worker.probe("douyin");
  assert.equal(await f.worker.runOnce(), false);
  await assert.rejects(f.worker.login("douhot"), { code: "COLLECTOR_BUSY" });
  assert.deepEqual(await probe, { site: "douyin", state: "ready" });
  await assert.rejects(f.worker.probe("arbitrary"), /只允许/);
  assert.equal(f.store.all().length, 0);
});

test("login preview/input require an open matching site, strip query and never leak typed secrets", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  f.collector.status = () => ({ site: "douyin" });
  f.collector.loginView = async () => ({
    site: "douyin",
    url: "https://www.douyin.com/?secret=hidden#token",
    image: "data:image/jpeg;base64,YQ==",
    width: 1440,
    height: 1000,
  });
  let calls = 0;
  f.collector.loginInput = async () => {
    calls++;
    throw Error("USER_SECRET_012345");
  };
  await assert.rejects(f.worker.loginView("douyin"), {
    code: "LOGIN_NOT_OPEN",
  });
  const session = (await f.worker.login("douyin")).login_session_id;
  const view = await f.worker.loginView("douyin", session);
  assert.equal(view.url, "https://www.douyin.com/");
  await assert.rejects(f.worker.loginView("douhot", session), {
    code: "LOGIN_SITE_MISMATCH",
  });
  await assert.rejects(
    f.worker.loginInput("douhot", session, {
      type: "text",
      text: "USER_SECRET_012345",
    }),
    { code: "LOGIN_SITE_MISMATCH" },
  );
  assert.equal(calls, 0);
  await assert.rejects(
    f.worker.loginInput("douyin", session, {
      type: "text",
      text: "USER_SECRET_012345",
    }),
    (error) =>
      error.code === "LOGIN_ACTION_FAILED" &&
      !error.message.includes("USER_SECRET"),
  );
  assert.equal(calls, 1);
  assert.equal(
    JSON.stringify(await f.worker.status()).includes("USER_SECRET"),
    false,
  );
});

test("login inputs are strict allowlisted values and previews/inputs serialize before resume", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  f.collector.status = () => ({ site: "douyin" });
  const sequence = [];
  f.collector.loginView = async () => {
    sequence.push("view-start");
    await delay(20);
    sequence.push("view-end");
    return {
      site: "douyin",
      url: "https://www.douyin.com/",
      image: "data:image/jpeg;base64,YQ==",
      width: 1440,
      height: 1000,
    };
  };
  f.collector.loginInput = async () => {
    sequence.push("input");
  };
  f.collector.resume = async () => {
    sequence.push("resume");
  };
  const session = (await f.worker.login("douyin")).login_session_id;
  for (const input of [
    { type: "click", x: -1, y: 2 },
    { type: "click", x: 1440, y: 2 },
    { type: "scroll", deltaY: 2001 },
    { type: "text", text: "x".repeat(2001) },
    { type: "text", text: "secret\n" },
    { type: "key", key: "Meta+L" },
    { type: "key", key: "Delete" },
    { type: "click", x: 1, y: 2, url: "https://evil.invalid" },
  ])
    await assert.rejects(f.worker.loginInput("douyin", session, input), {
      code: "LOGIN_INPUT_INVALID",
    });
  const view = f.worker.loginView("douyin", session);
  const input = f.worker.loginInput("douyin", session, {
    type: "click",
    x: 100,
    y: 200,
  });
  const resume = f.worker.resume();
  await assert.rejects(f.worker.loginView("douyin", session), {
    code: "LOGIN_NOT_OPEN",
  });
  await Promise.all([view, input, resume]);
  assert.deepEqual(sequence, ["view-start", "view-end", "input", "resume"]);
  await assert.rejects(
    f.worker.loginInput("douyin", session, { type: "key", key: "Tab" }),
    { code: "LOGIN_NOT_OPEN" },
  );
});

test("HTTP login preview is token protected and sensitive parse errors are sanitized", async () => {
  const { spawn } = await import("node:child_process");
  const { fileURLToPath } = await import("node:url");
  const folder = await mkdtemp(join(tmpdir(), "login-http-"));
  const port = 14794;
  const child = spawn(
    process.execPath,
    [fileURLToPath(new URL("../app/server.mjs", import.meta.url))],
    {
      env: {
        ...process.env,
        PORT: String(port),
        CRAWL_DATA_DIR: folder,
        CRAWL_SEARCH_MODE: "manual",
        CRAWL_BROWSER_MODE: "side-browser",
      },
      stdio: "pipe",
    },
  );
  let stderr = "";
  child.stderr.on("data", (b) => (stderr += b));
  try {
    const base = `http://127.0.0.1:${port}`;
    let token;
    for (let i = 0; i < 60; i++) {
      try {
        token = (await (await fetch(base + "/api/session")).json()).token;
        if (token) break;
      } catch {}
      await delay(50);
    }
    assert(token, stderr);
    const route = base + "/api/collector/login-view?site=douyin";
    assert.equal((await fetch(route)).status, 403);
    assert.equal(
      (
        await fetch(route, {
          headers: { "x-crawl-token": token, Origin: "https://evil.invalid" },
        })
      ).status,
      403,
    );
    assert.equal(
      (await fetch(route, { headers: { "x-crawl-token": token } })).status,
      409,
    );
    const malformed = await fetch(base + "/api/collector/login-input", {
      method: "POST",
      headers: { "x-crawl-token": token, "Content-Type": "application/json" },
      body: '{"site":"douyin","input":USER_SECRET_012345}',
    });
    assert.equal(malformed.status, 400);
    assert.equal((await malformed.text()).includes("USER_SECRET"), false);
    const oversized = await fetch(base + "/api/collector/login-input", {
      method: "POST",
      headers: { "x-crawl-token": token, "Content-Type": "application/json" },
      body: JSON.stringify({
        site: "douyin",
        input: { type: "text", text: "secret".repeat(4000) },
      }),
    });
    assert.equal(oversized.status, 400);
    assert.equal((await oversized.text()).includes("secret"), false);
    const missingSession = await fetch(base + "/api/collector/resume", {
      method: "POST",
      headers: { "x-crawl-token": token, "Content-Type": "application/json" },
      body: "{}",
    });
    assert.equal(missingSession.status, 400);
    const before = await (await fetch(base + "/api/readiness")).json();
    for (const value of [{sites:[]}, {sites:["other"]}, {sites:["douyin","douyin"]}, {sites:"douyin"}, {sites:["douyin"],extra:true}, null, []]) {
      const response = await fetch(base + "/api/readiness/check", {
        method: "POST", headers: {"x-crawl-token":token,"Content-Type":"application/json"}, body:JSON.stringify(value),
      });
      assert.equal(response.status,400);
      assert.equal((await response.json()).code,"READINESS_INPUT_INVALID");
    }
    const checked = await fetch(base + "/api/readiness/check", {
      method: "POST", headers: {"x-crawl-token":token,"Content-Type":"application/json"}, body:JSON.stringify({sites:["douyin"]}),
    });
    assert.equal(checked.status,202);
    const selected = await checked.json();
    assert.deepEqual(selected.sites.filter(row => row.id !== "douyin"), before.sites.filter(row => row.id !== "douyin"));
    await delay(0);
    const afterSelected = await (await fetch(base + "/api/readiness")).json();
    const invalid = await fetch(base + "/api/collector/login", {
      method: "POST",
      headers: { "x-crawl-token": token, "Content-Type": "application/json" },
      body: JSON.stringify({ site: "not-a-site" }),
    });
    assert.equal(invalid.status, 400);
    const failedLogin = await fetch(base + "/api/collector/login", {
      method:"POST", headers:{"x-crawl-token":token,"Content-Type":"application/json"},body:JSON.stringify({site:"douhot"}),
    });
    assert.equal(failedLogin.status,400); // Disabled collector: no source login succeeds.
    assert.deepEqual(
      (await (await fetch(base + "/api/readiness")).json()).sites,
      afterSelected.sites,
    );
  } finally {
    child.kill();
    await new Promise((r) =>
      child.exitCode !== null ? r() : child.once("exit", r),
    );
    await rm(folder, { recursive: true, force: true });
  }
});

test("old login tabs cannot resume, view or type into newer same-site or cross-site sessions", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  let site = null,
    closes = 0,
    inputs = 0;
  f.collector.login = async (next) => {
    site = next;
    return { site };
  };
  f.collector.status = () => ({ site });
  f.collector.resume = async () => {
    closes++;
  };
  f.collector.loginView = async () => ({
    site,
    url: `https://${site === "douyin" ? "www" : "douhot"}.douyin.com/`,
    image: "data:image/jpeg;base64,YQ==",
    width: 1440,
    height: 1000,
  });
  f.collector.loginInput = async () => {
    inputs++;
  };
  const first = await f.worker.login("douyin");
  const second = await f.worker.login("douyin");
  assert.notEqual(first.login_session_id, second.login_session_id);
  await assert.rejects(f.worker.resume("douyin", first.login_session_id), {
    code: "LOGIN_SESSION_MISMATCH",
  });
  await assert.rejects(f.worker.loginView("douyin", first.login_session_id), {
    code: "LOGIN_SESSION_MISMATCH",
  });
  await assert.rejects(
    f.worker.loginInput("douyin", first.login_session_id, {
      type: "text",
      text: "old-input",
    }),
    { code: "LOGIN_SESSION_MISMATCH" },
  );
  assert.equal(closes, 0);
  assert.equal(inputs, 0);
  assert.equal(
    (await f.worker.loginView("douyin", second.login_session_id))
      .login_session_id,
    second.login_session_id,
  );
  await assert.rejects(f.worker.login("douhot"), {code:"LOGIN_CONFIRM_REQUIRED"});
  assert.equal(site,"douyin");
  assert.equal((await f.worker.status()).login_session_id,second.login_session_id);
  assert.equal(closes,0);
  await f.worker.resume("douyin",second.login_session_id);
  const third = await f.worker.login("douhot");
  await assert.rejects(f.worker.resume("douyin", second.login_session_id), {
    code: "LOGIN_SITE_MISMATCH",
  });
  assert.equal(closes, 1);
  assert.equal(
    (await f.worker.status()).login_session_id,
    third.login_session_id,
  );
  await f.worker.loginInput("douhot", third.login_session_id, {
    type: "drag",
    fromX: 1,
    fromY: 2,
    toX: 1439,
    toY: 999,
  });
  assert.equal(inputs, 1);
  await assert.rejects(
    f.worker.loginInput("douhot", third.login_session_id, {
      type: "drag",
      fromX: 0,
      fromY: 0,
      toX: 1440,
      toY: 999,
    }),
    { code: "LOGIN_INPUT_INVALID" },
  );
  await f.worker.resume("douhot", third.login_session_id);
  assert.equal(closes, 2);
  assert.equal((await f.worker.status()).login_session_id, null);
});

test("OAuth loading keeps the exact login session active and returns a safe retryable error", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  f.collector.status = () => ({ site: "douyin" });
  f.collector.loginView = async () => {
    throw Object.assign(Error("sensitive-source-detail"), {
      code: "LOGIN_LOADING",
    });
  };
  const session = await f.worker.login("douyin");
  await assert.rejects(
    f.worker.loginView("douyin", session.login_session_id),
    (error) =>
      error.code === "LOGIN_LOADING" && !error.message.includes("sensitive"),
  );
  assert.equal(
    (await f.worker.status()).login_session_id,
    session.login_session_id,
  );
  assert.equal((await f.worker.status()).state, "login_open");
});

test("real pointer input accepts exact user coordinates and rejects extra commands or out-of-viewport values", () => {
  for (const phase of ["down", "move", "up"]) {
    const input = { type: "pointer", phase, x: 1439, y: 999 };
    assert.deepEqual(validateLoginInput(input), input);
  }
  for (const input of [
    { type: "pointer", phase: "drag", x: 1, y: 2 },
    { type: "pointer", phase: "move", x: 1440, y: 2 },
    { type: "pointer", phase: "move", x: 1, y: 1000 },
    { type: "pointer", phase: "down", x: -1, y: 2 },
    { type: "pointer", phase: "up", x: 1, y: NaN },
    { type: "pointer", phase: "move", x: 1, y: 2, steps: 20 },
    { type: "pointer", phase: "move", x: "1", y: 2 },
  ])
    assert.throws(() => validateLoginInput(input), {
      code: "LOGIN_INPUT_INVALID",
    });
});

test("idle queue kick cannot block login completion, and duplicate completion shares one close", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  let release;
  let closes = 0;
  f.collector.resume = async () => {
    closes++;
    await new Promise((resolve) => { release = resolve; });
  };
  const login = await f.worker.login("douhot");
  f.worker.kick(); // A scheduled empty cycle is not an active browser operation.
  const first = f.worker.resume("douhot", login.login_session_id);
  const second = f.worker.resume("douhot", login.login_session_id);
  await delay(0);
  assert.equal(closes, 1);
  assert.equal((await f.worker.status()).operation, "closing_login");
  release();
  assert.deepEqual(await first, await second);
  assert.equal((await f.worker.status()).state, "idle");
});

test("stalled native close is bounded, releases lease, retains session and blocks new source work", async (t) => {
  const f = await fixture(t, async (input) => result(input), { resumeTimeoutMs: 15 });
  let release;
  let closes = 0;
  f.collector.status = () => ({ mode: "closed", phase: "idle" });
  f.collector.resume = async () => {
    closes++;
    if (closes === 1) await new Promise((resolve) => { release = resolve; });
  };
  const login = await f.worker.login("douhot");
  f.bridge.request("search", game());
  await assert.rejects(f.worker.resume("douhot", login.login_session_id), { code: "RESUME_TIMEOUT" });
  const status = await f.worker.status();
  assert.equal(status.state, "login_open");
  assert.equal(status.login_session_id, login.login_session_id);
  assert.equal(status.operation, "closing_login");
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM locks WHERE key='automatic-source-collector'").get().n, 0);
  assert.equal(await f.worker.runOnce(), false);
  await assert.rejects(f.worker.login("douyin"), { code: "LOGIN_CONFIRM_REQUIRED" });
  await assert.rejects(f.worker.resume("douhot", login.login_session_id), { code: "RESUME_PENDING" });
  assert.equal(closes, 1);
  release();
  await delay(0);
  assert.equal((await f.worker.resume("douhot", login.login_session_id)).resumed, true);
});

test("source CLOSE_TIMEOUT preserves login recovery and never masquerades as successful resume", async (t) => {
  const f = await fixture(t, async (input) => result(input));
  f.collector.resume = async () => { throw Object.assign(Error("登录浏览器仍在关闭，请重启创作台"), { code: "CLOSE_TIMEOUT" }); };
  const login = await f.worker.login("douhot");
  await assert.rejects(f.worker.resume("douhot", login.login_session_id), { code: "CLOSE_TIMEOUT" });
  assert.equal((await f.worker.status()).state, "login_open");
  assert.equal(f.db.setting("collector-blocked").code, "SOURCE_FAILED");
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM locks WHERE key='automatic-source-collector'").get().n, 0);
  f.collector.resume = async () => {};
  assert.equal((await f.worker.resume("douhot", login.login_session_id)).resumed, true);
});

test("failed native verification retains session and window; retry verifies before any close",async(t)=>{
  const f=await fixture(t,async input=>result(input));let accepted=false;const sequence=[];
  f.collector.verifyLogin=async site=>{sequence.push("verify");if(!accepted)throw Object.assign(Error("尚未确认本人账号"),{code:"LOGIN_REQUIRED"});return{site,state:"ready",native_verified:true};};
  f.collector.resume=async()=>sequence.push("close");
  const login=await f.worker.login("douyin");
  await assert.rejects(f.worker.resume("douyin",login.login_session_id),{code:"LOGIN_REQUIRED"});
  assert.deepEqual(sequence,["verify"]);
  assert.equal((await f.worker.status()).login_session_id,login.login_session_id);
  assert.equal((await f.worker.status()).state,"login_open");
  assert.equal(f.db.db.prepare("SELECT count(*) AS n FROM locks WHERE key='automatic-source-collector'").get().n,0);
  accepted=true;
  await f.worker.resume("douyin",login.login_session_id);
  assert.deepEqual(sequence,["verify","verify","close"]);
});

test("late native verification after timeout never closes the retained window or clears session",async(t)=>{
  const f=await fixture(t,async input=>result(input),{loginVerificationTimeoutMs:10});let release,closes=0;
  f.collector.verifyLogin=site=>new Promise(resolve=>{release=()=>resolve({site,state:"ready",native_verified:true});});
  f.collector.resume=async()=>closes++;
  const login=await f.worker.login("douyin");
  await assert.rejects(f.worker.resume("douyin",login.login_session_id),{code:"LOGIN_CHECK_TIMEOUT"});
  assert.equal(closes,0);
  assert.equal((await f.worker.status()).operation,"verifying_login");
  assert.equal((await f.worker.status()).login_session_id,login.login_session_id);
  await assert.rejects(f.worker.resume("douyin",login.login_session_id),{code:"RESUME_PENDING"});
  release();await delay(0);
  assert.equal(closes,0);
  assert.equal((await f.worker.status()).state,"login_open");
  assert.equal((await f.worker.status()).operation,"idle");
});

test("manual window closure recovery is explicit and unproven avatar evidence cannot trigger closing",async(t)=>{
  const f=await fixture(t,async input=>result(input));let closes=0;
  f.collector.resume=async()=>closes++;
  const login=await f.worker.login("douyin");
  f.collector.verifyLogin=async site=>({site,state:"ready",native_verified:false});
  await assert.rejects(f.worker.resume("douyin",login.login_session_id),{code:"LOGIN_CHECK_FAILED"});
  assert.equal(closes,0);
  f.collector.verifyLogin=async site=>({site,state:"window_closed",native_verified:false});
  assert.equal((await f.worker.resume("douyin",login.login_session_id)).resumed,true);
  assert.equal(closes,1); // Caller must still perform independent background readiness.
});
