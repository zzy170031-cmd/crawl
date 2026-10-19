export const string = { type: "string" };
export const strings = { type: "array", items: string };
export const object = (properties) => ({
  type: "object",
  additionalProperties: false,
  required: Object.keys(properties),
  properties,
});
export const list = (items) => ({ type: "array", items });
export const observation = object({ time: { type: "number" }, text: string });
export const mediaSchema = object({
  summary: string,
  observations: { ...list(observation), minItems: 1 },
  speech_notes: string,
  creative_methods: strings,
  uncertainties: strings,
  blocking_gaps: strings,
  needs_audio_review: { type: "boolean" },
});
export const claim = object({ text: string, evidence_ids: strings });
export const profileSchema = object({
  game: string,
  summary: string,
  relevant_video_ids: strings,
  player_interests: list(claim),
  creative_methods: list(claim),
  game_facts: list(claim),
  unknowns: strings,
  blocking_gaps: strings,
});
export const shot = object({
  position: string,
  visual: string,
  text: string,
  sound: string,
});
export const tier = object({
  level: { type: "string", enum: ["低", "中", "高"] },
  premises: strings,
  method: string,
  viewer_value: string,
});
export const idea = object({
  title: string,
  hook: string,
  bridge: string,
  evidence_ids: strings,
  script: string,
  shots: list(shot),
  materials: strings,
  tiers: list(tier),
  limitations: strings,
});
export const planSchema = object({
  game: string,
  meaning: string,
  fit: {
    type: "string",
    enum: [
      "direct",
      "player_context",
      "expression",
      "insufficient",
      "unsuitable",
    ],
  },
  rationale: string,
  evidence_ids: strings,
  ideas: list(idea),
  blocking_gaps: strings,
});
export function validateSchema(value, schema, path = "result") {
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw Error(path + "需为对象");
    for (const k of schema.required || [])
      if (!(k in value)) throw Error(path + "缺少" + k);
    for (const [k, v] of Object.entries(value)) {
      if (!schema.properties[k]) throw Error(path + "未知字段" + k);
      validateSchema(v, schema.properties[k], path + "." + k);
    }
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) throw Error(path + "需为列表");
    if (schema.minItems && value.length < schema.minItems)
      throw Error(path + "缺少实际观察");
    value.forEach((v, i) =>
      validateSchema(v, schema.items, path + "[" + i + "]"),
    );
  }
  if (
    (schema.type === "string" && typeof value !== "string") ||
    (schema.type === "number" && !Number.isFinite(value)) ||
    (schema.type === "boolean" && typeof value !== "boolean")
  )
    throw Error(path + "类型错误");
  if (schema.enum && !schema.enum.includes(value))
    throw Error(path + "取值错误");
  return value;
}
export function requireRefs(ids, available) {
  if (!ids.length || ids.some((id) => !available.has(id)))
    throw Error("结论缺少有效来源引用");
}
export function validateProfile(value, evidence, game) {
  validateSchema(value, profileSchema);
  if (value.game !== game) throw Error("游戏身份不一致");
  const ids = new Set(evidence.map((e) => e.id));
  const videos = new Set(
    evidence.filter((e) => e.kind === "video").map((e) => e.id),
  );
  if (
    value.relevant_video_ids.length < 20 ||
    new Set(value.relevant_video_ids).size < 20 ||
    value.relevant_video_ids.some((id) => !videos.has(id))
  )
    throw Error("至少需要20条实际相关独立作品，当前资料不足");
  for (const key of ["player_interests", "creative_methods", "game_facts"]) {
    if (!value[key].length) throw Error("游戏资料缺少" + key);
    for (const c of value[key]) {
      if (!c.text.trim()) throw Error("游戏结论为空");
      requireRefs(c.evidence_ids, ids);
      if (
        key !== "game_facts" &&
        !c.evidence_ids.some((id) => value.relevant_video_ids.includes(id))
      )
        throw Error("玩家与创作结论必须引用实际相关游戏作品");
    }
  }
  return value;
}
export function validatePlan(value, evidence, game) {
  validateSchema(value, planSchema);
  if (value.game !== game) throw Error("方案目标游戏不一致");
  const ids = new Set(evidence.map((e) => e.id));
  requireRefs(value.evidence_ids, ids);
  if (
    ["insufficient", "unsuitable"].includes(value.fit) ||
    value.blocking_gaps.length
  )
    return value;
  if (!value.ideas.length) throw Error("缺少完整方案");
  const requireBoth = (refs) => {
    for (const role of ["hotspot", "game"])
      if (!evidence.some((e) => e.role === role && refs.includes(e.id)))
        throw Error("方案必须同时引用热点实读和游戏依据");
  };
  requireBoth(value.evidence_ids);
  for (const idea of value.ideas) {
    requireRefs(idea.evidence_ids, ids);
    requireBoth(idea.evidence_ids);
    if (
      !idea.title.trim() ||
      !idea.bridge.trim() ||
      !idea.script.trim() ||
      !idea.shots.length ||
      !idea.materials.length
    )
      throw Error("方案正文不完整");
    if (new Set(idea.tiers.map((t) => t.level)).size !== 3)
      throw Error("缺少低中高制作方案");
    for (const s of idea.shots)
      if (!s.visual.trim() || !s.text.trim())
        throw Error("镜头或图文页内容为空");
  }
  return value;
}
