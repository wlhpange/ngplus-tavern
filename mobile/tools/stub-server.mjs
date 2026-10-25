#!/usr/bin/env node
/**
 * 本地 OpenAI 兼容 stub（验收用，不参与 App 打包）。
 * 覆盖：chat 流式/非流式、function calling、翻译、锻造、复核、场景提炼、images/generations。
 * 运行：node tools/stub-server.mjs [port]
 */
import http from "node:http";

const PORT = Number(process.argv[2] || 8787);
const PNG_1x1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) });
  res.end(body);
}

function textOf(m) {
  if (typeof m.content === "string") return m.content;
  if (Array.isArray(m.content)) return m.content.map((x) => x.text || "").join("\n");
  return "";
}
function parseTool(m) {
  try {
    return JSON.parse(textOf(m));
  } catch {
    return {};
  }
}
function tool(name, args, id = `call_${Math.random().toString(36).slice(2)}`) {
  return { id, name, args };
}
function findQuestId(messages) {
  for (const m of [...messages].reverse()) {
    if (m.role !== "tool") continue;
    const s = textOf(m);
    const m1 = s.match(/"quest_id"\s*:\s*"([^"]+)"/);
    if (m1) return m1[1];
    const m2 = s.match(/"id"\s*:\s*"([^"]+)"/);
    if (m2) return m2[1];
  }
  return null;
}
function findActiveQuestId(messages) {
  for (const m of [...messages].reverse()) {
    if (m.role !== "tool") continue;
    const s = textOf(m);
    const active = s.match(/"id"\s*:\s*"([^"]+)"[^}]*?"status"\s*:\s*"active"/);
    if (active) return active[1];
    const any = s.match(/"quest_id"\s*:\s*"([^"]+)"/);
    if (any) return any[1];
  }
  return findQuestId(messages);
}
function lastUser(messages) {
  return [...messages].reverse().find((m) => m.role === "user")?.content?.toString() || "";
}
function systemOf(messages) {
  return messages.filter((m) => m.role === "system").map(textOf).join("\n");
}
function toolTexts(messages) {
  return messages.filter((m) => m.role === "tool").map(textOf);
}
function hasCreate(messages) {
  return toolTexts(messages).some((s) => s.includes('"quest_id"') && s.includes('"attr_reason"'));
}
function hasAccept(messages) {
  return toolTexts(messages).some((s) => s.includes('"quest_id"') && s.includes('"status":"active"'));
}
function hasSettle(messages) {
  return toolTexts(messages).some((s) => s.includes('"settlement_id"'));
}
/** 只认当前 quest id 的接受/结算回执，避免多轮循环被旧回执误判 */
function hasAcceptFor(messages, id) {
  if (!id) return false;
  return toolTexts(messages).some(
    (s) => s.includes(id) && s.includes('"status":"active"'),
  );
}
function hasSettleFor(messages, id) {
  if (!id) return false;
  return toolTexts(messages).some(
    (s) => s.includes(id) && s.includes('"settlement_id"'),
  );
}

function decide(body) {
  const messages = body.messages || [];
  const sys = systemOf(messages);
  const user = lastUser(messages);
  const tools = body.tools || [];

  if (sys.includes("结算复核员")) {
    return {
      kind: "json",
      obj: {
        no_adjustment: true,
        xp_bonus_ratio: 0,
        bonus_allocations: [],
        reclassification: null,
        narrative_hint: "复核无误",
        confidence: 0.9,
      },
    };
  }
  if (sys.includes("记忆复核员")) {
    return { kind: "json", obj: { action: "keep", reason: "属实" } };
  }
  if (sys.includes("记忆整理员")) {
    return { kind: "json", obj: { memories: [{ category: "event", content: "冒险者完成了第一次委托" }] } };
  }
  if (sys.includes("人格锻造师") || sys.includes("人格锻造")) {
    return {
      kind: "json",
      obj: {
        name: "阿岚",
        self_intro: "我在协会守夜。",
        personality: ["冷静", "可靠"],
        description: "阿岚，协会的守夜人，话不多，但记得每个人的习惯。",
        scenario: "夜里的协会，灯还亮着。",
        first_mes: "进来吧，门外风大。",
        tags: ["守夜人"],
        backstory: "曾在边城做过信使。",
        mystery_hooks: ["她为何总在夜里"],
        alternate_greetings: ["灯还亮着，坐吧。"],
        relationship_stages: [
          { stage: 1, label: "初识", address: "你", tone_note: "克制" },
          { stage: 2, label: "熟络", address: "老朋友", tone_note: "放松" },
          { stage: 3, label: "挚友", address: "名字", tone_note: "温和" },
        ],
      },
    };
  }
  if (sys.includes("文学翻译")) {
    return { kind: "text", text: user.replace(/[A-Za-z]+/g, (w) => `译${w}`).slice(0, 2000) || "译文" };
  }
  if (sys.includes("分镜师") || sys.includes("画面描述")) {
    return { kind: "text", text: "暖灯下，会长坐在桌后抬眼看向门口" };
  }

  if (tools.length > 0) {
    const userWantsQuest = /委托|任务|跑步|读书|早起|健身|挂个|帮我记|quest|task|run|jog|read|gym/i.test(user);
    const userAccepts = /接受|接下|开始|accept|start/i.test(user);
    const userReports = /完成|跑了|做完|搞定|汇报|读完了|done|finished|ran|report/i.test(user);
    const userRemembers = /记住|记下|remember|memorize/i.test(user);
    const questId = findQuestId(messages) || findActiveQuestId(messages);
    const toolMsgs = messages.filter((m) => m.role === "tool");

    if (userRemembers && !toolMsgs.some((m) => textOf(m).includes('"memory_id"'))) {
      return {
        kind: "tool",
        tool: tool("add_memory", { category: "profile", content: "冒险者喜欢在夜里散步" }),
      };
    }

    if (userReports) {
      if (!questId) {
        return { kind: "tool", tool: tool("lookup_quests", { status: "active" }) };
      }
      if (!hasSettleFor(messages, questId)) {
        return {
          kind: "tool",
          tool: tool("settle_completion", {
            quest_id: questId,
            evidence: user,
            completion_ratio: 1,
            confidence: 0.95,
          }),
        };
      }
      return { kind: "text", text: "记上了。跑完这一趟，气色都不一样了。" };
    }
    if (userAccepts) {
      if (!questId) {
        return { kind: "tool", tool: tool("lookup_quests", { status: "proposed" }) };
      }
      if (!hasAcceptFor(messages, questId)) {
        return { kind: "tool", tool: tool("respond_to_quest", { quest_id: questId, action: "accept" }) };
      }
      return { kind: "text", text: "好，挂上了。别拖，明天我等你的消息。" };
    }
    if (userWantsQuest) {
      const isWeekly = /weekly|每周/i.test(user);
      const isOnce = /once|一次性/i.test(user);
      const wantsNew = /new|another|weekly|once|每周|一次性/i.test(user);
      if (!hasCreate(messages) || wantsNew) {
        return {
          kind: "tool",
          tool: tool("create_quest", {
            title: isWeekly ? "每周跑三次步" : isOnce ? "整理一次旧书箱" : "每天跑步 20 分钟",
            description: isWeekly ? "一周挑三天，绕协会跑一圈" : isOnce ? "把床底的旧书箱清一遍" : "晚饭后绕协会跑一圈",
            type: isWeekly ? "weekly" : isOnce ? "once" : "daily",
            category: isWeekly ? "长期习惯" : isOnce ? "生活整理" : "独自运动",
            primary_attr: "vitality",
            primary_weight: 0.8,
            secondary_attr: "willpower",
            secondary_weight: 0.2,
            attr_reason: "跑步主要练体魄，坚持靠意志",
            difficulty: 1,
            checkin: false,
          }),
        };
      }
      return { kind: "text", text: "先挂一张草稿。你看看要不要接。" };
    }
    if (toolMsgs.length > 0) {
      return { kind: "text", text: "嗯，我记下了。" };
    }
    return { kind: "text", text: "坐吧，茶刚沏上。今天想聊点什么？" };
  }

  return { kind: "text", text: "收到。今天也慢慢来，我在。" };
}

function streamText(res, text) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  const chars = [...text];
  for (let i = 0; i < chars.length; i += 4) {
    const chunk = chars.slice(i, i + 4).join("");
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: chunk }, index: 0 }] })}\n\n`);
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop", index: 0 }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

function streamTool(res, t) {
  res.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  res.write(
    `data: ${JSON.stringify({
      choices: [
        {
          delta: {
            tool_calls: [
              { index: 0, id: t.id, type: "function", function: { name: t.name, arguments: "" } },
            ],
          },
          index: 0,
        },
      ],
    })}\n\n`,
  );
  const arg = JSON.stringify(t.args);
  for (let i = 0; i < arg.length; i += 20) {
    res.write(
      `data: ${JSON.stringify({
        choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: arg.slice(i, i + 20) } }] }, index: 0 }],
      })}\n\n`,
    );
  }
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls", index: 0 }] })}\n\n`);
  res.write("data: [DONE]\n\n");
  res.end();
}

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/health") return json(res, 200, { ok: true });
  if (req.method === "POST" && req.url?.includes("/images/generations")) {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => json(res, 200, { created: Date.now(), data: [{ b64_json: PNG_1x1 }] }));
    return;
  }
  if (req.method === "POST" && req.url?.includes("/chat/completions")) {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      let body;
      try {
        body = JSON.parse(raw);
      } catch {
        return json(res, 400, { error: { message: "bad json" } });
      }
      const decision = decide(body);
      const stream = body.stream === true;
      if (decision.kind === "json") {
        const text = JSON.stringify(decision.obj);
        if (stream) return streamText(res, text);
        return json(res, 200, {
          choices: [{ message: { role: "assistant", content: text }, finish_reason: "stop", index: 0 }],
        });
      }
      if (decision.kind === "tool") {
        if (stream) return streamTool(res, decision.tool);
        return json(res, 200, {
          choices: [
            {
              message: {
                role: "assistant",
                content: null,
                tool_calls: [
                  {
                    id: decision.tool.id,
                    type: "function",
                    function: { name: decision.tool.name, arguments: JSON.stringify(decision.tool.args) },
                  },
                ],
              },
              finish_reason: "tool_calls",
              index: 0,
            },
          ],
        });
      }
      if (stream) return streamText(res, decision.text);
      return json(res, 200, {
        choices: [{ message: { role: "assistant", content: decision.text }, finish_reason: "stop", index: 0 }],
      });
    });
    return;
  }
  json(res, 404, { error: { message: "not found" } });
});

server.listen(PORT, "0.0.0.0", () => console.log(`stub listening on http://0.0.0.0:${PORT}`));
