import { hash } from "./tasks.mjs";
import { replayRedfoxGameResult, redfoxGameScope } from "./redfox-game-source.mjs";

export class LearningSnapshotError extends Error {}
const fail = message => { throw new LearningSnapshotError(message); };
export function gameCollectionScope(game) {
  return {provider:"redfox",purpose:"game-research",keyword:game.normalize("NFKC").trim(),hours:168,sort:"likes",limit:30,board:null,category:"all"};
}

// Both callers are server-owned. Never accept browser-supplied candidate rows.
export function readLearningSnapshot(bridge, request, game) {
  const target = game.normalize("NFKC").trim();
  if (!request || request.kind !== "search" || request.task_id != null ||
      request.payload?.provider !== "redfox" || request.payload.purpose !== "game-research" ||
      request.payload.keyword !== target)
    fail("没有当前游戏的有效查询批次，请先在游戏广场点击开始查询");
  if (request.state !== "fulfilled")
    fail("当前游戏查询尚未成功，不能用旧缓存开始学习；请等待结果或手动重新查询");
  let result;
  try {
    result = bridge.validate(request, replayRedfoxGameResult(request.result, request.payload));
    if (hash(result) !== hash(request.result)) throw Error("changed");
  } catch {
    fail("游戏查询回执与保存结果不一致，未启动学习，请重新核验来源");
  }
  if (!result.records.length) fail("本次查询没有可学习的视频，请调整游戏或手动重新查询");
  return {
    binding:{source_provider:"redfox",collection_request_id:request.id,collection_fingerprint:hash(result)},
    records:structuredClone(result.records),
    provenance:{request_id:request.id,provider:"redfox",game:target,collected_at:result.searched_at,
      start_date:result.observed_scope.start_date,end_date:result.observed_scope.end_date,
      candidate_count:result.records.length,update_policy:"T+1"},
  };
}

export function bindLatestGameCollection(bridge, game, now = new Date()) {
  const scope=gameCollectionScope(game), request=bridge.latestSearchForScope(scope);
  const snapshot=readLearningSnapshot(bridge,request,game);
  const expected=redfoxGameScope(scope,now);
  if (snapshot.provenance.start_date!==expected.start_date || snapshot.provenance.end_date!==expected.end_date)
    fail("当前游戏查询已跨日期，请先手动更新采集结果");
  return snapshot;
}

export function resolveBoundGameCollection(bridge, payload) {
  if (payload.source_provider!=="redfox" || !payload.collection_request_id || !payload.collection_fingerprint)
    fail("旧学习任务未绑定红狐查询批次，请从游戏广场当前结果重新创建学习任务");
  const snapshot=readLearningSnapshot(bridge,bridge.get(payload.collection_request_id),payload.game);
  if(snapshot.binding.collection_fingerprint!==payload.collection_fingerprint)
    fail("任务绑定的查询批次已变化，不能替换学习输入，请重新确认");
  return snapshot;
}
