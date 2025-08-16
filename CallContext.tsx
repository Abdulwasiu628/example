"use client";
import React, {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  useCallback,
} from "react";
import { socket } from "@/utils/socketArea";
import { playTone } from "@/utils/playTone";
import { usePeer } from "@/hooks/peers";
import { MediaConnection } from "peerjs";
import { v4 as uuidv4 } from "uuid";
import IncomingCall from "@/app/profile/[user]/chat/[chat]/calls/IncomingCall";
import FullScreenCall from "@/app/profile/[user]/chat/[chat]/calls/FullScreenCall";
import { useAuth } from "@/contexts/AuthContext";

interface CallContextType {
  startCall: (calleeId: string) => void;
  acceptCall: () => void;
  declineCall: () => void;
  endCall: () => void;
  toggleMute: () => void;
  isMuted: boolean;
  setCallType: (type: "audio" | "video") => void;
  callType: "audio" | "video";
  callStatus: "idle" | "ringing" | "connected" | "ended";
  callIncoming: string | null;
  callerPeerId: string | null;
  callStartTime: number | null;
  currentCallId: string | null;
}

const CallContext = createContext<CallContextType | any>(null);
export const useCall = () => useContext(CallContext);

const CallProvider: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  const { user } = useAuth();
  const peerRef = usePeer();
  const audioContextRef = useRef<AudioContext | null>(null);
  const [callIncoming, setCallIncoming] = useState<string | null>(null);
  const [callerPeerId, setCallerPeerId] = useState<string | null>(null);
  const [currentCallId, setCurrentCallId] = useState<string | null>(null);
  const [callStatus, setCallStatus] = useState<
    "idle" | "ringing" | "connected" | "ended"
  >("idle");
  const [callStartTime, setCallStartTime] = useState<number | null>(null);
  const [isMuted, setIsMuted] = useState(false);
  const [isFullScreenCall, setIsFullScreenCall] = useState(false);
  const localStreamRef = useRef<MediaStream | null>(null);
  const peerCallRef = useRef<MediaConnection | null>(null);
  const callTimeoutRef = useRef<NodeJS.Timeout | null>(null);
  const receiveToneRef = useRef<AudioBufferSourceNode | null>(null);
  const callToneRef = useRef<AudioBufferSourceNode | null>(null);
  const [callType, setCallType] = useState<"audio" | "video">("audio");
  const localVideoRef = useRef<HTMLVideoElement | null>(null);
  const remoteVideoRef = useRef<HTMLVideoElement | null>(null);
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);

  const getAudioContext = () => {
    if (!audioContextRef.current) {
      audioContextRef.current = new AudioContext();
    }
    return audioContextRef.current;
  };

  const stopTones = useCallback(() => {
    [receiveToneRef, callToneRef].forEach((ref) => {
      if (ref.current) {
        ref.current.stop();
        ref.current.disconnect();
        ref.current = null;
      }
    });
  }, []);

  const attachRemoteStream = (stream: MediaStream) => {
    setRemoteStream(stream);
    if (callType === "video" && remoteVideoRef.current) {
      const video = remoteVideoRef.current;
      if (video.srcObject !== stream) {
        video.pause();
        video.srcObject = stream;
      }
      const tryPlay = () => {
        video
          .play()
          .then(() => console.log("remote video playing"))
          .catch((err) => {
            console.warn("remote video play error", err);
            setTimeout(tryPlay, 300);
          });
      };
      requestAnimationFrame(tryPlay);
    } else {
      const audio = new Audio();
      audio.srcObject = stream;
      audio.autoplay = true;
      audio.play().catch((err) => console.warn("Audio play error", err));
    }
  };

  const cleanupCall = useCallback(() => {
    stopTones();
    if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);

    if (localStreamRef.current) {
      localStreamRef.current.getTracks().forEach((track) => track.stop());
      localStreamRef.current = null;
    }

    if (peerCallRef.current) {
      peerCallRef.current.close();
      peerCallRef.current.removeAllListeners();
      peerCallRef.current = null;
    }

    setIsFullScreenCall(false);
    setCallStatus("idle");
    setCallStartTime(null);
    setCurrentCallId(null);
    setCallIncoming(null);
    setIsMuted(false);
    setCallerPeerId(null);
  }, [stopTones]);

  const startCall = async (
    calleeId: string | any,
    callType: "audio" | "video"
  ) => {
    if (!calleeId || !peerRef.current || !user?.userId) return;

    setCallType(callType);

    if (peerCallRef.current) {
      peerCallRef.current.removeAllListeners();
    }
    await getAudioContext().resume();

    const constraints =
      callType === "video" ? { video: true, audio: true } : { audio: true };
    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;
    setLocalStream(stream);
    (window as any).localStream = stream;

    const callId = uuidv4();
    setCallStatus("ringing");
    setCurrentCallId(callId);
    setCallerPeerId(user?.userId);
    setIsFullScreenCall(true);

    const call = peerRef.current.call(calleeId, stream);

    if (!call) {
      console.error(
        "PeerJS call failed. User might be offline or unreachable."
      );
      cleanupCall();
      return;
    }
    peerCallRef.current = call;

    call.on("stream", attachRemoteStream);

    socket.emit("call-user", {
      from: user?.userId,
      to: calleeId,
      callId,
      callType,
    });

    const ctx = getAudioContext();
    playTone("/sounds/calling.mp3", ctx).then((tone) => {
      callToneRef.current = tone;
    });

    callTimeoutRef.current = setTimeout(() => {
      socket.emit("missed-call", {
        from: user?.userId,
        to: calleeId,
        callId,
      });
      cleanupCall();
    }, 30_000);
  };

  const acceptCall = async () => {
    stopTones();
    setCallStatus("connected");
    await getAudioContext().resume();

    const constraints =
      callType === "video" ? { video: true, audio: true } : { audio: true };

    const stream = await navigator.mediaDevices.getUserMedia(constraints);
    localStreamRef.current = stream;
    setLocalStream(stream);
    (window as any).localStream = stream;
    peerCallRef.current?.answer(stream);

    socket.emit("accept-call", {
      from: user?.userId,
      to: callIncoming,
      callId: currentCallId,
    });

    setIsFullScreenCall(true);
    setCallIncoming(null);
    setCallStartTime(Date.now());

    // attachRemoteStream(stream);
  };

  const declineCall = useCallback(() => {
    if (callIncoming && currentCallId) {
      socket.emit("decline-call", {
        from: user?.userId,
        to: callIncoming,
        callId: currentCallId,
      });
    }
    if (peerCallRef.current) {
      peerCallRef.current.close();
      peerCallRef.current = null;
    }
    cleanupCall();
  }, [callIncoming, currentCallId, user?.userId, cleanupCall]);

  const endCall = () => {
    const duration = callStartTime
      ? Math.floor((Date.now() - callStartTime) / 1000)
      : 0;

    socket.emit("end-call", {
      from: user?.userId,
      to: callIncoming || callerPeerId,
      callId: currentCallId,
      duration,
    });
    if (peerCallRef.current) {
      peerCallRef.current.close();
      peerCallRef.current = null;
    }
    cleanupCall();
  };

  const toggleMute = () => {
    const stream = localStreamRef.current;
    if (!stream) return;

    const audioTrack = stream.getAudioTracks()[0];
    if (!audioTrack) return;

    audioTrack.enabled = !audioTrack.enabled;
    setIsMuted(!audioTrack.enabled);
  };

  useEffect(() => {
    const unlock = () => {
      getAudioContext().resume().catch(console.error);
      document
        .querySelectorAll("video")
        .forEach((vid) =>
          vid.play().catch((err) => console.warn("Unlock video fail:", err))
        );
    };

    window.addEventListener("click", unlock, { once: true });
    return () => window.removeEventListener("click", unlock);
  }, []);

  useEffect(() => {
    if (!user?.userId) return;

    socket.on("incoming-call", async ({ from, callId, callType }) => {
      setCallIncoming(from);
      setCallerPeerId(from);
      setCurrentCallId(callId);
      setCallStatus("ringing");
      setCallType(callType);

      const ctx = getAudioContext();
      receiveToneRef.current = await playTone("/sounds/receiving.mp3", ctx);

      callTimeoutRef.current = setTimeout(() => {
        declineCall();
      }, 30_000);
    });

    socket.on("call-accepted", async () => {
      stopTones();
      if (callTimeoutRef.current) clearTimeout(callTimeoutRef.current);
      setCallStatus("connected");
      setCallStartTime(Date.now());
      setIsFullScreenCall(true);
      await getAudioContext().resume();
    });

    socket.on("call-declined", cleanupCall);
    socket.on("call-ended", cleanupCall);

    socket.on("call-stopped", ({ callId }) => {
      setCallStatus("ended");
      if (callId) {
        cleanupCall();
      }
    });

    return () => {
      socket.off("incoming-call");
      socket.off("call-accepted");
      socket.off("call-declined");
      socket.off("call-ended");
      socket.off("call-stopped");
    };
  }, [user?.userId, cleanupCall, stopTones, declineCall]);

  useEffect(() => {
    if (!peerRef.current) return;

    const peer = peerRef.current;

    peer.on("call", (call) => {
      peerCallRef.current = call;

      let remoteAttached = false;

      call.on("stream", (remoteStream) => {
        if (!remoteAttached) {
          attachRemoteStream(remoteStream);
          remoteAttached = true;
        }
        console.log(
          "Remote Stream Tracks:",
          remoteStream.getTracks().map((t) => ({
            kind: t.kind,
            enabled: t.enabled,
            readyState: t.readyState,
          }))
        );
      });

      call.on("close", () => {
        remoteAttached = false;
      });

      call.on("error", () => {
        remoteAttached = false;
      });
    });

    return () => {
      peer.off("call");
    };
  }, [peerRef]);

  return (
    <CallContext.Provider
      value={{
        callStatus,
        callIncoming,
        callerPeerId,
        currentCallId,
        callStartTime,
        isMuted,
        toggleMute,
        acceptCall,
        declineCall,
        endCall,
        startCall,
        callType,
        setCallType,
      }}
    >
      {children}
      {callIncoming && (
        <IncomingCall
          incomingUser={callIncoming}
          acceptCall={acceptCall}
          declineCall={declineCall}
          callType={callType}
        />
      )}
      {isFullScreenCall && (
        <FullScreenCall
          user={callIncoming || callerPeerId}
          endCall={endCall}
          callStartTime={callStartTime}
          remoteStream={remoteStream}
          callStatus={callStatus}
          isMuted={isMuted}
          toggleMute={toggleMute}
          localStream={localStream}
          callType={callType}
          localVideoRef={localVideoRef}
          remoteVideoRef={remoteVideoRef}
        />
      )}
    </CallContext.Provider>
  );
};

export default CallProvider;
