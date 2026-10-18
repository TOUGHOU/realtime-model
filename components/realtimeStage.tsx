/**
 * @file realtimeStage.tsx
 * @description 移动端全屏通话页：摄像头预览和物品识别
 */

"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  connectRealtime,
  formatRealtimeError,
  type RealtimeServerEvent,
  type RealtimeSession,
} from "@/lib/realtimeSession";

type Phase = "idle" | "connecting" | "live";

type RealtimeConfig = {
  configured: boolean;
  region: string;
  model: string;
  endpoint: "workspace" | "trial";
  error: string | null;
};

export function RealtimeStage() {
  const videoRef = useRef<HTMLVideoElement>(null);
  const sessionRef = useRef<RealtimeSession | null>(null);
  const mountedRef = useRef(true);
  const turnRef = useRef({ usingAudio: false, draft: "", committed: "" });

  const [phase, setPhase] = useState<Phase>("idle");
  const [line, setLine] = useState("你可以开始说话");
  const [statusText, setStatusText] = useState("还没开始");
  const [draft, setDraft] = useState("");
  const [userText, setUserText] = useState("");
  const [error, setError] = useState("");
  const [log, setLog] = useState<string[]>([]);
  const [config, setConfig] = useState<RealtimeConfig | null>(null);
  const [micOn, setMicOn] = useState(true);
  const [videoOn, setVideoOn] = useState(true);
  const [captionsOn, setCaptionsOn] = useState(true);
  const [resultOnly, setResultOnly] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      sessionRef.current?.disconnect();
      sessionRef.current = null;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    void fetch("/api/webrtc")
      .then((response) => response.json() as Promise<RealtimeConfig>)
      .then((data) => {
        if (!cancelled) setConfig(data);
      })
      .catch(() => {
        if (!cancelled) {
          setConfig({
            configured: false,
            region: "cn-beijing",
            model: "qwen3.8-omni-flash-realtime",
            endpoint: "trial",
            error: "读取服务端配置失败",
          });
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function applyEvent(event: RealtimeServerEvent) {
    setLog((current) => [event.type, ...current].slice(0, 12));

    if (event.type === "error") {
      setError(formatRealtimeError(event));
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      setUserText("");
      setLine("正在听…");
      return;
    }
    if (event.type === "input_audio_buffer.speech_stopped" || event.type === "response.created") {
      if (event.type === "response.created") {
        turnRef.current = { usingAudio: false, draft: "", committed: "" };
        setDraft("");
      }
      setLine("识别中…");
      return;
    }
    if (event.type === "response.audio_transcript.delta" && event.delta) {
      turnRef.current.usingAudio = true;
      turnRef.current.draft += event.delta;
      setDraft(turnRef.current.draft);
      return;
    }
    if (event.type === "response.text.delta" && event.delta && !turnRef.current.usingAudio) {
      turnRef.current.draft += event.delta;
      setDraft(turnRef.current.draft);
      return;
    }
    if (event.type === "response.audio_transcript.done") {
      commitResult(event.transcript || turnRef.current.draft);
      return;
    }
    if (event.type === "response.text.done" && !turnRef.current.usingAudio) {
      commitResult(event.text || turnRef.current.draft);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.delta" && event.delta) {
      setUserText((current) => current + event.delta);
      return;
    }
    if (event.type === "conversation.item.input_audio_transcription.completed" && event.transcript) {
      setUserText(event.transcript);
    }
  }

  function commitResult(text: string) {
    const trimmed = text.trim();
    if (!trimmed || trimmed === turnRef.current.committed) return;
    turnRef.current.committed = trimmed;
    turnRef.current.draft = trimmed;
    setDraft(trimmed);
    setLine("你可以开始说话");
  }

  function beginSession(sendVideo: boolean) {
    const preview = videoRef.current;
    if (!preview) return;
    if (!config?.configured) {
      setError(config?.error || "还没配好 API Key");
      setLine("连接失败");
      return;
    }
    setError("");
    setDraft("");
    setUserText("");
    setMicOn(true);
    setVideoOn(sendVideo);
    setPhase("connecting");
    setLine("正在连接…");
    setStatusText("正在连接…");
    const session = connectRealtime(preview, {
      onStatus: (status) => {
        if (mountedRef.current) setStatusText(status);
      },
      onReady: () => {
        if (!mountedRef.current) return;
        setPhase("live");
        setLine("你可以开始说话");
      },
      onError: (message) => {
        if (!mountedRef.current) return;
        setError(message);
        setPhase("idle");
        setLine("连接失败");
        setStatusText("连接失败");
        sessionRef.current = null;
      },
      onEvent: (event) => {
        if (mountedRef.current) applyEvent(event);
      },
    });
    session.setVideoEnabled(sendVideo);
    sessionRef.current = session;
  }

  function hangUp() {
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setPhase("idle");
    setLine("你可以开始说话");
    setStatusText("已结束");
    setMicOn(true);
    setVideoOn(true);
  }

  function onMic() {
    if (phase === "connecting") return;
    if (phase === "idle") {
      beginSession(videoOn);
      return;
    }
    setMicOn((current) => {
      sessionRef.current?.setMicEnabled(!current);
      return !current;
    });
  }

  function onCamera() {
    if (phase === "connecting") return;
    if (phase === "idle") {
      beginSession(true);
      return;
    }
    setVideoOn((current) => {
      sessionRef.current?.setVideoEnabled(!current);
      return !current;
    });
  }

  function onRefresh() {
    if (phase === "connecting") return;
    sessionRef.current?.disconnect();
    sessionRef.current = null;
    setDraft("");
    setUserText("");
    setLine("你可以开始说话");
    beginSession(videoOn);
  }

  const caption = captionsOn && !resultOnly ? draft || userText : "";
  const prompt = resultOnly && captionsOn ? draft || "等待识别" : line;

  return (
    <div className="mx-auto flex h-dvh w-full max-w-[430px] items-center justify-center bg-black">
      <section className="relative h-dvh w-full overflow-hidden bg-black text-white">
        <video
          ref={videoRef}
          className="absolute inset-0 h-full w-full object-cover"
          autoPlay
          playsInline
          muted
        />
        {phase === "idle" || !videoOn ? <div className="absolute inset-0 bg-black" /> : null}

        <header className="absolute inset-x-0 top-0 z-20 px-5 pt-[max(18px,env(safe-area-inset-top))]">
          <div className="relative h-14">
            <button
              type="button"
              aria-label="更多"
              onClick={() => setMenuOpen((open) => !open)}
              className="absolute left-0 top-1 flex gap-1 px-1 py-2"
            >
              <Dot />
              <Dot />
              <Dot />
            </button>
            <div className="absolute left-1/2 top-0 -translate-x-1/2">
              <Mark />
            </div>
            <div className="absolute right-0 top-1 flex items-center gap-4">
              <button
                type="button"
                aria-label="只看识别结果"
                aria-pressed={resultOnly}
                onClick={() => setResultOnly((on) => !on)}
                className={`p-1 text-white ${resultOnly ? "rounded-full bg-white/20" : ""}`}
              >
                <FilterIcon />
              </button>
              <button type="button" aria-label="重新连接" onClick={onRefresh} className="p-1">
                <RefreshIcon />
              </button>
              <button
                type="button"
                aria-label="字幕"
                aria-pressed={captionsOn}
                onClick={() => setCaptionsOn((on) => !on)}
                className={`px-0.5 text-[22px] leading-none ${captionsOn ? "text-white" : "text-white/40"}`}
              >
                字
              </button>
            </div>
          </div>
        </header>

        {menuOpen ? (
          <div className="absolute inset-x-4 top-24 z-20 rounded-2xl bg-black/70 p-4 text-sm leading-6 backdrop-blur-md">
            <p>{statusText}</p>
            {config ? (
              <p className="text-white/60">
                {config.model} · {config.region}
              </p>
            ) : null}
            {error ? <p className="text-red-200">{error}</p> : null}
            {config && !config.configured ? <p className="text-amber-100">{config.error}</p> : null}
            <ul className="mt-2 max-h-28 overflow-auto font-mono text-xs text-white/50">
              {log.length === 0 ? <li>还没有事件</li> : null}
              {log.map((item, index) => (
                <li key={`${item}-${index}`}>{item}</li>
              ))}
            </ul>
          </div>
        ) : null}

        <div className="absolute inset-x-0 bottom-0 z-20 px-7 pb-[max(18px,env(safe-area-inset-bottom))]">
          {caption ? (
            <p className="mb-4 text-center text-[15px] leading-6 text-white [text-shadow:0_1px_6px_rgba(0,0,0,0.7)]">
              {caption}
            </p>
          ) : null}
          <div className="mb-3 flex items-center justify-center gap-1.5" aria-hidden="true">
            <span className="size-[5px] rounded-full bg-white" />
            <span className="size-[5px] rounded-full bg-white" />
            <span className="size-[5px] rounded-full bg-white" />
          </div>
          <p className="mb-7 text-center text-[17px] text-white [text-shadow:0_1px_6px_rgba(0,0,0,0.65)]">
            {prompt}
          </p>
          <div className="flex items-center justify-between">
            <RoundButton label={micOn ? "关闭麦克风" : "打开麦克风"} tone={micOn ? "light" : "muted"} onClick={onMic}>
              <MicIcon slashed={!micOn} />
            </RoundButton>
            <RoundButton
              label={videoOn ? "关闭摄像头" : "打开摄像头"}
              tone={videoOn ? "light" : "muted"}
              onClick={onCamera}
            >
              {videoOn ? <VideoIcon /> : <VideoOffIcon />}
            </RoundButton>
            <RoundButton label="挂断" tone="hangup" onClick={hangUp}>
              <CloseIcon />
            </RoundButton>
          </div>
          <p className="mt-6 text-center text-[13px] text-white/90 [text-shadow:0_1px_4px_rgba(0,0,0,0.6)]">
            内容由 AI 生成
          </p>
        </div>
      </section>
    </div>
  );
}

function RoundButton({
  label,
  tone,
  pressed,
  onClick,
  children,
}: {
  label: string;
  tone: "light" | "muted" | "hangup";
  pressed?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  const background = tone === "light" ? "bg-white text-black" : tone === "hangup" ? "bg-[#d4d4d8] text-[#ff2d2d]" : "bg-[#8e8e93] text-white";
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={pressed}
      onClick={onClick}
      className={`flex size-[72px] items-center justify-center rounded-full ${background} ${pressed ? "ring-2 ring-white/80" : ""}`}
    >
      {children}
    </button>
  );
}

function Dot() {
  return <span className="size-[5px] rounded-full bg-white" />;
}

function Mark() {
  return (
    <svg viewBox="0 0 48 48" className="h-11 w-11" aria-hidden="true">
      <path
        d="M24 7 L40 16.5 V33 L24 42.5 L8 33 V16.5 Z"
        fill="none"
        stroke="white"
        strokeWidth="1.7"
        strokeLinejoin="round"
      />
      <path d="M24 7 V24.5 L40 33" fill="none" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
      <path d="M24 24.5 L8 33" fill="none" stroke="white" strokeWidth="1.7" strokeLinejoin="round" />
    </svg>
  );
}

function FilterIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M4 5h16l-6.2 7.4V19l-3.6-1.8v-4.8L4 5Z" strokeLinejoin="round" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
      <path d="M19.5 12a7.5 7.5 0 1 1-2-5.1" strokeLinecap="round" />
      <path d="M19.5 4.2V8.4H15.3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MicIcon({ slashed }: { slashed: boolean }) {
  return (
    <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden="true">
      <rect x="9" y="3" width="6" height="11" rx="3" />
      <path d="M7 11a5 5 0 0 0 10 0" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M12 16v4M9 20h6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
      {slashed ? <path d="M5 19 L19 5" stroke="#2a2a2e" strokeWidth="2.2" strokeLinecap="round" /> : null}
    </svg>
  );
}

function VideoIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" fill="currentColor" aria-hidden="true">
      <rect x="3" y="7" width="12" height="10" rx="2" />
      <path d="M15 10.5 L21 7.5 V16.5 L15 13.5 Z" />
    </svg>
  );
}

function VideoOffIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-8" fill="none" aria-hidden="true">
      <rect x="2.5" y="7" width="12" height="10" rx="2" fill="currentColor" />
      <path d="M14.5 10.4 L21 7.4 V16.6 L14.5 13.6 Z" fill="currentColor" />
      <path d="M4 20.5 L20.5 4" stroke="#2a2a2e" strokeWidth="2.2" strokeLinecap="round" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg viewBox="0 0 24 24" className="size-7" aria-hidden="true">
      <path d="M6 6 L18 18 M18 6 L6 18" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}
