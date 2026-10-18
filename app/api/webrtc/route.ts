/**
 * @file route.ts
 * @description 把浏览器 Offer SDP 转发到百炼 WebRTC，API Key 只留在服务端
 */

import { connection } from "next/server";

const DEFAULT_REGION = "cn-beijing";
const DEFAULT_MODEL = "qwen3.8-omni-flash-realtime";

const REGION_HOST = {
  "cn-beijing": "cn-beijing",
  "ap-southeast-1": "ap-southeast-1",
} as const;

type Region = keyof typeof REGION_HOST;

type RealtimeConfig = {
  apiKey: string;
  workspaceId: string;
  region: Region;
  model: string;
};

function endpointHost(config: RealtimeConfig) {
  const regionHost = REGION_HOST[config.region];
  if (config.workspaceId) return `${config.workspaceId}.${regionHost}.maas.aliyuncs.com`;
  return `trial.${regionHost}.maas.aliyuncs.com`;
}

function readConfig(): { config: RealtimeConfig | null; error: string | null } {
  const apiKey = process.env.DASHSCOPE_API_KEY?.trim() ?? "";
  const workspaceId = process.env.WORKSPACE_ID?.trim() ?? "";
  const region = (process.env.DASHSCOPE_REGION?.trim() || DEFAULT_REGION) as Region;
  const model = process.env.REALTIME_MODEL?.trim() || DEFAULT_MODEL;

  if (!apiKey) {
    return { config: null, error: "缺少 DASHSCOPE_API_KEY，请写入 .env.local 后重启" };
  }
  if (!(region in REGION_HOST)) {
    return { config: null, error: "DASHSCOPE_REGION 只能是 cn-beijing 或 ap-southeast-1" };
  }
  if (workspaceId && !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(workspaceId)) {
    return { config: null, error: "WORKSPACE_ID 格式不正确" };
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(model)) {
    return { config: null, error: "REALTIME_MODEL 格式不正确" };
  }

  return { config: { apiKey, workspaceId, region, model }, error: null };
}

export async function GET() {
  await connection();
  const { config, error } = readConfig();
  return Response.json({
    configured: config !== null,
    region: config?.region ?? DEFAULT_REGION,
    model: config?.model ?? DEFAULT_MODEL,
    endpoint: config?.workspaceId ? "workspace" : "trial",
    error,
  });
}

export async function POST(request: Request) {
  await connection();
  const { config, error } = readConfig();
  if (!config) {
    return Response.json({ error }, { status: 500 });
  }

  const offerSdp = await request.text();
  if (offerSdp.length < 20 || offerSdp.length > 1_000_000 || !offerSdp.includes("v=0")) {
    return Response.json({ error: "Offer SDP 无效" }, { status: 400 });
  }

  const url = `https://${endpointHost(config)}/api/v1/webrtc/realtime?model=${encodeURIComponent(config.model)}`;

  let upstream: Response;
  try {
    upstream = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Authorization: `Bearer ${config.apiKey}`,
      },
      body: offerSdp,
      signal: AbortSignal.timeout(20_000),
      cache: "no-store",
    });
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : "请求百炼失败";
    return Response.json({ error: message }, { status: 502 });
  }

  const answer = await upstream.text();
  if (!upstream.ok) {
    return Response.json(
      { error: answer.slice(0, 1000) || `SDP 交换失败（${upstream.status}）` },
      { status: upstream.status },
    );
  }

  return new Response(answer, {
    status: 200,
    headers: { "Content-Type": "application/sdp", "Cache-Control": "no-store" },
  });
}
