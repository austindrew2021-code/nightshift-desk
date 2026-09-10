import { useEffect, useState } from "react";
import { useDesk } from "@/lib/store";
import { Button } from "@/components/ui/button";

type BIP = Event & { prompt: () => Promise<void>; userChoice: Promise<{ outcome: string }> };

export function InstallHint() {
  const show = useDesk((s) => s.installedHint);
  const dismiss = useDesk((s) => s.dismissInstall);
  const [deferred, setDeferred] = useState<BIP | null>(null);
  const [standalone, setStandalone] = useState(false);

  useEffect(() => {
    const mq = window.matchMedia("(display-mode: standalone)");
    setStandalone(mq.matches);
    const onBip = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BIP);
    };
    window.addEventListener("beforeinstallprompt", onBip);
    return () => window.removeEventListener("beforeinstallprompt", onBip);
  }, []);

  if (!show || standalone) return null;

  async function install() {
    if (deferred) {
      await deferred.prompt();
      dismiss();
      return;
    }
    window.location.href = "/?install=1";
  }

  return (
    <div className="fixed inset-x-3 bottom-3 z-40 rounded-xl bg-surface-2 p-3 shadow-[0_0_0_1px_rgba(61,255,138,0.16)] md:left-4 md:right-auto md:w-80">
      <p className="font-sans text-sm text-fg">Install NIGHTSHIFT on this phone</p>
      <p className="mt-1 font-sans text-xs text-muted">
        Chrome on Galaxy: Add to Home screen. Book saves on this phone. Swiping off pauses ticks until you reopen.
      </p>
      <div className="mt-3 flex gap-2">
        <Button size="sm" onClick={() => void install()}>
          Install
        </Button>
        <Button size="sm" variant="ghost" onClick={dismiss}>
          Not now
        </Button>
      </div>
    </div>
  );
}
