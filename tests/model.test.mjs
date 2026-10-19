import test from "node:test";
import assert from "node:assert/strict";
import { Model } from "../app/model.mjs";

function streamResponse(content, reason = "stop") {
  return new Response(JSON.stringify({ message: { content }, done: true, done_reason: reason }) + "\n");
}
test("单帧JSON前缀只用于显式请求的Qwen并保留截断检查", async () => {
  let request;
  const model = new Model({ model: "qwen3-vl:8b", fetchImpl: async (_, options) => {
    request = JSON.parse(options.body);
    return streamResponse('"text":"实际字幕"}');
  }});
  const schema = {type:"object",properties:{text:{type:"string"}},required:["text"]};
  assert.deepEqual(await model.json("读取画面", {}, schema, {images:["fixture"],prefillJson:true}), {text:"实际字幕"});
  assert.equal(request.messages.at(-1).content, "<think>\n\n</think>\n\n{");
  assert.deepEqual(request.messages[1].images, ["fixture"]);
  model.fetch = async () => streamResponse('"text":"截断', "length");
  await assert.rejects(model.json("读取", {}, schema, {prefillJson:true}), /截断/);
});
for (const name of ["other:model", "qwen3-vl:8b-instruct"]) test(name + "不插入思考版专用前缀", async () => {
  let request;
  const model = new Model({model:name, fetchImpl:async (_, options)=>{
    request=JSON.parse(options.body);return streamResponse('{"text":"字幕"}');
  }});
  assert.deepEqual(await model.json("读取", {}, {}, {prefillJson:true}), {text:"字幕"});
  assert.equal(request.messages.length, 2);
});
