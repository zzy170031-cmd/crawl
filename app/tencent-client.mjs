// Credentials stay on the local server and are sent only to Tencent's MCP endpoint.
export class TencentClient {
  constructor() {
    this.session = null;
    this.id = 0;
    this.ready = false;
    this.names = new Map();
  }
  async rpc(method, params, notification = false) {
    const token = process.env.TENCENT_DOCS_TOKEN;
    if (!token)
      throw Error("本地服务未读取到腾讯文档授权，请重启服务加载已配置的凭据。");
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      Authorization: token,
    };
    if (this.session) headers["Mcp-Session-Id"] = this.session;
    let response;
    try {
      response = await fetch("https://docs.qq.com/openapi/mcp", {
        method: "POST",
        headers,
        body: JSON.stringify({
          jsonrpc: "2.0",
          ...(notification ? {} : { id: ++this.id }),
          method,
          params,
        }),
        signal: AbortSignal.timeout(45000),
      });
    } catch {
      throw Error("腾讯文档连接超时或网络不可用，请稍后重试。");
    }
    if (!response.ok)
      throw Error(
        `腾讯文档连接失败（HTTP ${response.status}），请检查授权或网络。`,
      );
    this.session = response.headers.get("mcp-session-id") || this.session;
    const body = await response.text();
    if (notification || !body) return {};
    let data;
    try {
      data = JSON.parse(body);
    } catch {
      for (const line of body.split("\n"))
        if (line.startsWith("data:")) {
          try {
            const item = JSON.parse(line.slice(5));
            if (item.id === this.id) data = item;
          } catch {}
        }
    }
    if (!data || data.error)
      throw Error("腾讯文档接口调用失败，请检查 MCP 服务状态。");
    return data.result;
  }
  async init() {
    if (this.ready) return;
    await this.rpc("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "hotspot-workbench", version: "1.0" },
    });
    await this.rpc("notifications/initialized", {}, true);
    let cursor;
    do {
      const result = await this.rpc("tools/list", cursor ? { cursor } : {});
      for (const tool of result.tools || [])
        this.names.set(tool.name.replaceAll(".", "_"), tool.name);
      cursor = result.nextCursor;
    } while (cursor);
    this.ready = true;
  }
  async call(name, args) {
    await this.init();
    const actual = this.names.get(name);
    if (!actual) throw Error("腾讯文档缺少所需表格接口：" + name);
    const result = await this.rpc("tools/call", {
      name: actual,
      arguments: args,
    });
    if (result.isError) throw Error("腾讯文档操作失败，请检查访问权限。");
    let data = result.structuredContent;
    if (!data) {
      try {
        data = JSON.parse(result.content.find((c) => c.type === "text").text);
      } catch {
        throw Error("腾讯文档返回格式异常。");
      }
    }
    if (data.error)
      throw Error("腾讯文档操作未完成：" + String(data.error).slice(0, 160));
    return data;
  }
}
