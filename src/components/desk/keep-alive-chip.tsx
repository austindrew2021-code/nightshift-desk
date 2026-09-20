import { useEffect, useRef, useState } from "react";
import { startKeepAlive, stopKeepAlive, wantsKeepAlive } from "@/lib/keep-alive";
import { cn } from "@/lib/utils";

export function KeepAliveChip() {
  const ref = useRef<HTMLVideoElement>(null);
  const [on, setOn] = useState(false);
  const [note, setNote] = useState("");

  useEffect(() => {
    const v = ref.current;
    if (!v) return;
    const left = () => {
      setOn(false);
      setNote("mini player closed · optional — CLOUD still hunts");
    };
    v.addEventListener("leavepictureinpicture", left);
    return () => v.removeEventListener("leavepictureinpicture", left);
  }, []);

  async function toggle() {
    const v = ref.current;
    if (!v) return;
    if (on) {
      stopKeepAlive();
      setOn(false);
      setNote("");
      return;
    }
    try {
      const msg = await startKeepAlive(v);
      setOn(true);
      setNote(msg);
    } catch (e) {
      setOn(false);
      setNote(e instanceof Error ? e.message : "PiP blocked — tap again, then open YouTube");
    }
  }

  useEffect(() => {
    if (!wantsKeepAlive()) return;
    setNote("optional · CLOUD hunts while the phone sleeps");
  }, []);

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-2">
      <video
        ref={ref}
        className="h-9 w-16 shrink-0 rounded-sm bg-black object-cover"
        playsInline
        autoPlay
        controls={false}
      />
      <button
        type="button"
        onClick={() => void toggle()}
        className={cn(
          "h-11 shrink-0 rounded-md px-3 font-mono text-[11px] tracking-[0.12em] uppercase",
          on ? "bg-phosphor text-phosphor-ink" : "text-muted shadow-[0_0_0_1px_rgba(61,255,138,0.35)] hover:text-fg",
        )}
      >
        {on ? "keep alive on" : "keep alive"}
      </button>
      {note ? <span className="min-w-0 font-mono text-[10px] text-subtle">{note}</span> : null}
    </div>
  );
}
