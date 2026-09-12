import { createRootRoute, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import { AuthProvider } from "@/lib/auth/provider";
import { PreviewHostBridge } from "@/components/preview-host-bridge";
import { DeskRuntime } from "@/components/desk/runtime";
import appCss from "../styles.css?url";

const APP_NAME = "NIGHTSHIFT";
const BASE = import.meta.env.BASE_URL;

export const Route = createRootRoute({
  head: () => ({
    meta: [
      { charSet: "utf-8" },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1, viewport-fit=cover",
      },
      { title: APP_NAME },
      { name: "theme-color", content: "#070b09" },
      {
        name: "description",
        content:
          "Five Grok agents on a paper trading desk. Live backtest, ICT playbook, pump.fun pipeline.",
      },
      { name: "apple-mobile-web-app-capable", content: "yes" },
      { name: "apple-mobile-web-app-title", content: "NIGHTSHIFT" },
      { name: "theme-color", content: "#070b09" },
      { name: "apple-mobile-web-app-status-bar-style", content: "black-translucent" },
    ],
    links: [
      { rel: "icon", type: "image/svg+xml", href: `${BASE}favicon.svg` },
      { rel: "stylesheet", href: appCss },
      // Our own manifest, not the template's /__grok/ one: that is synthesised
      // per-request from the hostname, so off a *.grok.me host it names the
      // installed app "Grok App" and points at an icon that is not in this
      // repo (public/__grok/ is gitignored) — which makes the app
      // un-installable on Android. Relative URLs inside the manifest resolve
      // against the manifest itself, so this works on both "/" and
      // "/nightshift-desk/".
      { rel: "manifest", href: `${BASE}manifest.webmanifest` },
      { rel: "apple-touch-icon", sizes: "180x180", href: `${BASE}icon-180.png` },
      { rel: "preconnect", href: "https://fonts.googleapis.com" },
      { rel: "preconnect", href: "https://fonts.gstatic.com", crossOrigin: "anonymous" },
      {
        rel: "stylesheet",
        href: "https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500;600&family=IBM+Plex+Sans:wght@400;500;600&display=swap",
      },
    ],
  }),
  component: () => (
    <html lang="en" className="antialiased" suppressHydrationWarning>
      <head>
        <HeadContent />
      </head>
      <body className="bg-bg text-fg">
        <PreviewHostBridge />
        <AuthProvider>
          <DeskRuntime>
            <Outlet />
          </DeskRuntime>
        </AuthProvider>
        <Scripts />
      </body>
    </html>
  ),
});
