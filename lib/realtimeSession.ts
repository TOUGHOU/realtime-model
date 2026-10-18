/**
 * @file realtimeSession.ts
 * @description 浏览器端百炼 Qwen-Omni WebRTC 会话
 */

export type RealtimeServerEvent = {
  type: string;
  delta?: string;
  transcript?: string;
  text?: string;
  error?: unknown;
};

export type RealtimeHandlers = {
  onStatus: (status: string) => void;
  onEvent: (event: RealtimeServerEvent) => void;
  onReady: () => void;
  onError: (message: string) => void;
};

const OBJECT_INSTRUCTIONS = [
  "你是实时视觉识别助手。",
  "用户把摄像头对准物品并开口后，根据当前画面识别物品。",
  "用简短中文回答物品名称、数量、颜色或显著特征。",
  "不要寒暄，不要重复用户的问题。",
  "画面看不清时直接说看不清。",
].join("");

export function formatRealtimeError(event: RealtimeServerEvent): string {
  const { error } = event;
  if (typeof error === "string") return error;
  if (error && typeof error === "object" && "message" in error) {
    const message = error.message;
    if (typeof message === "string" && message) return message;
  }
  return "模型返回错误";
}

export type RealtimeSession = {
  disconnect: () => void;
  setMicEnabled: (enabled: boolean) => void;
  setVideoEnabled: (enabled: boolean) => void;
  flipCamera: () => Promise<void>;
};

export function connectRealtime(
  preview: HTMLVideoElement,
  handlers: RealtimeHandlers,
): RealtimeSession {
  let closed = false;
  let pc: RTCPeerConnection | null = null;
  let localStream: MediaStream | null = null;
  let sendCanvasStream: MediaStream | null = null;
  let sendRafId = 0;
  let remoteAudio: HTMLAudioElement | null = null;
  let configured = false;
  let micEnabled = true;
  let videoEnabled = true;
  let facingMode: "user" | "environment" = "environment";
  let outboundVideo: MediaStreamTrack | null = null;

  const disconnect = () => {
    if (closed) return;
    closed = true;
    if (sendRafId) cancelAnimationFrame(sendRafId);
    sendRafId = 0;
    sendCanvasStream?.getTracks().forEach((track) => track.stop());
    sendCanvasStream = null;
    localStream?.getTracks().forEach((track) => track.stop());
    localStream = null;
    preview.srcObject = null;
    if (remoteAudio) {
      remoteAudio.pause();
      remoteAudio.srcObject = null;
      remoteAudio.remove();
      remoteAudio = null;
    }
    pc?.close();
    pc = null;
  };

  const fail = (message: string) => {
    if (closed) return;
    handlers.onError(message);
    disconnect();
  };

  void start();

  return {
    disconnect,
    setMicEnabled(enabled) {
      micEnabled = enabled;
      if (!configured) return;
      localStream?.getAudioTracks().forEach((track) => {
        track.enabled = enabled;
      });
    },
    setVideoEnabled(enabled) {
      videoEnabled = enabled;
      if (outboundVideo) outboundVideo.enabled = enabled;
    },
    async flipCamera() {
      if (closed || !localStream) return;
      const nextFacing = facingMode === "environment" ? "user" : "environment";
      const nextStream = await navigator.mediaDevices.getUserMedia({
        video: {
          facingMode: { ideal: nextFacing },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      const nextTrack = nextStream.getVideoTracks()[0];
      if (!nextTrack || closed) {
        nextStream.getTracks().forEach((track) => track.stop());
        return;
      }
      localStream.getVideoTracks().forEach((track) => {
        localStream?.removeTrack(track);
        track.stop();
      });
      localStream.addTrack(nextTrack);
      facingMode = nextFacing;
      preview.srcObject = localStream;
      await preview.play().catch(() => undefined);
    },
  };

  async function start() {
    try {
      handlers.onStatus("正在打开摄像头和麦克风…");
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
        video: {
          facingMode: { ideal: "environment" },
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30, max: 30 },
        },
      });
      if (closed) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      localStream = stream;
      preview.srcObject = stream;
      preview.muted = true;
      await preview.play().catch(() => undefined);
      if (closed) return;

      const connection = new RTCPeerConnection({ iceServers: [] });
      if (closed) {
        connection.close();
        return;
      }
      pc = connection;

      connection.onconnectionstatechange = () => {
        if (closed || connection.connectionState !== "failed") return;
        fail("WebRTC 连接失败");
      };
      connection.ontrack = (event) => {
        const remoteStream = event.streams[0];
        if (!remoteStream || closed) return;
        if (!remoteAudio) {
          remoteAudio = document.createElement("audio");
          remoteAudio.autoplay = true;
          remoteAudio.setAttribute("playsinline", "true");
          document.body.appendChild(remoteAudio);
        }
        remoteAudio.srcObject = remoteStream;
        void remoteAudio.play().catch(() => undefined);
      };

      const audioTracks = stream.getAudioTracks();
      for (const track of audioTracks) connection.addTrack(track, stream);

      outboundVideo = attachLowFpsVideo(connection, stream);
      const audioSender = connection.getSenders().find((sender) => sender.track?.kind === "audio");
      const videoSender = connection.getSenders().find((sender) => sender.track?.kind === "video");
      const audioTrack = audioSender?.track ?? null;
      const videoTrack = videoSender?.track ?? outboundVideo;

      audioTracks.forEach((track) => {
        track.enabled = false;
      });
      if (outboundVideo) outboundVideo.enabled = false;
      await audioSender?.replaceTrack(null);
      if (videoSender && videoTrack) await videoSender.replaceTrack(null);
      if (closed) return;

      const localChannel = connection.createDataChannel("oai-events");
      localChannel.onmessage = (event) => {
        handleDcMessage(String(event.data), localChannel, {
          audioTracks,
          audioSender,
          audioTrack,
          videoSender,
          videoTrack,
          outboundVideo,
        });
      };
      connection.ondatachannel = (event) => {
        event.channel.onmessage = (message) => {
          handleDcMessage(String(message.data), event.channel, {
            audioTracks,
            audioSender,
            audioTrack,
            videoSender,
            videoTrack,
            outboundVideo,
          });
        };
      };

      handlers.onStatus("正在和模型协商连接…");
      const offer = await connection.createOffer();
      if (closed) return;
      await connection.setLocalDescription(offer);
      const offerSdp = await waitForLocalSdp(connection);
      if (closed) return;

      const response = await fetch("/api/webrtc", {
        method: "POST",
        headers: { "Content-Type": "application/sdp" },
        body: offerSdp,
      });
      const answerBody = await response.text();
      if (!response.ok) {
        throw new Error(formatApiError(answerBody) || `SDP 交换失败（${response.status}）`);
      }
      if (closed) return;
      await connection.setRemoteDescription({
        type: "answer",
        sdp: normalizeSdp(answerBody),
      });
      handlers.onStatus("正在建立媒体通道…");
    } catch (error) {
      const message = error instanceof Error ? error.message : "连接失败";
      fail(message);
    }
  }

  function attachLowFpsVideo(connection: RTCPeerConnection, stream: MediaStream) {
    const sourceTrack = stream.getVideoTracks()[0];
    if (!sourceTrack || !pc) return null;
    const settings = sourceTrack.getSettings();
    const canvas = document.createElement("canvas");
    canvas.width = settings.width || 640;
    canvas.height = settings.height || 480;
    const context = canvas.getContext("2d", { alpha: false });
    const canvasStream = canvas.captureStream(2);
    sendCanvasStream = canvasStream;
    const outbound = canvasStream.getVideoTracks()[0] ?? null;
    if (!outbound) return null;
    connection.addTrack(outbound, canvasStream);

    const pump = () => {
      if (closed || !context) return;
      try {
        context.drawImage(preview, 0, 0, canvas.width, canvas.height);
      } catch {
        // 预览还没出首帧时跳过这一帧
      }
      sendRafId = requestAnimationFrame(pump);
    };
    sendRafId = requestAnimationFrame(pump);
    return outbound;
  }

  function handleDcMessage(
    data: string,
    source: RTCDataChannel,
    media: {
      audioTracks: MediaStreamTrack[];
      audioSender: RTCRtpSender | undefined;
      audioTrack: MediaStreamTrack | null;
      videoSender: RTCRtpSender | undefined;
      videoTrack: MediaStreamTrack | null;
      outboundVideo: MediaStreamTrack | null;
    },
  ) {
    if (closed) return;
    let event: RealtimeServerEvent;
    try {
      event = JSON.parse(data) as RealtimeServerEvent;
    } catch {
      return;
    }
    handlers.onEvent(event);
    if (event.type === "error") {
      handlers.onStatus(formatRealtimeError(event));
      return;
    }
    if (event.type !== "session.created" || configured) return;

    configured = true;
    media.audioTracks.forEach((track) => {
      track.enabled = micEnabled;
    });
    if (media.outboundVideo) media.outboundVideo.enabled = videoEnabled;
    void media.audioSender?.replaceTrack(media.audioTrack);
    if (media.videoSender && media.videoTrack) {
      void media.videoSender.replaceTrack(media.videoTrack);
    }
    if (source.readyState === "open") {
      source.send(JSON.stringify(buildSessionUpdate()));
    }
    handlers.onStatus("已连接。把物品放进画面，说「这是什么」");
    handlers.onReady();
  }
}

function buildSessionUpdate() {
  return {
    event_id: `event_${Date.now()}`,
    type: "session.update",
    session: {
      modalities: ["text", "audio"],
      instructions: OBJECT_INSTRUCTIONS,
      audio: {
        input: { format: { type: "pcm", sample_rate: 16000 } },
        output: {
          voice: "Tina",
          format: { type: "pcm", sample_rate: 24000 },
        },
      },
      input_audio_transcription: { model: "qwen3-asr-flash-realtime" },
      smooth_output: false,
      turn_detection: {
        type: "server_vad",
        threshold: 0.5,
        prefix_padding_ms: 500,
        silence_duration_ms: 600,
      },
    },
  };
}

function waitForLocalSdp(pc: RTCPeerConnection): Promise<string> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      const sdp = pc.localDescription?.sdp;
      if (!sdp) {
        reject(new Error("没有生成 Offer SDP"));
        return;
      }
      resolve(sdp);
    };

    if (pc.iceGatheringState === "complete") {
      finish();
      return;
    }

    const timer = window.setTimeout(() => {
      pc.removeEventListener("icegatheringstatechange", onChange);
      finish();
    }, 2500);

    const onChange = () => {
      if (pc.iceGatheringState !== "complete") return;
      window.clearTimeout(timer);
      pc.removeEventListener("icegatheringstatechange", onChange);
      finish();
    };

    pc.addEventListener("icegatheringstatechange", onChange);
  });
}

function normalizeSdp(sdp: string) {
  const normalized = sdp.trim().replace(/\r?\n/g, "\r\n");
  return normalized.endsWith("\r\n") ? normalized : `${normalized}\r\n`;
}

function formatApiError(body: string) {
  try {
    const parsed = JSON.parse(body) as { error?: unknown };
    if (typeof parsed.error === "string") return parsed.error;
  } catch {
    // 上游可能返回纯文本
  }
  return body.slice(0, 500);
}
