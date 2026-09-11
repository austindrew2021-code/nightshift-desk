import { createRouter } from "@tanstack/react-router";
import { AppErrorComponent } from "@/lib/error-component";
import { routeTree } from "./routeTree.gen";

export function getRouter() {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return createRouter({
    routeTree,
    defaultErrorComponent: AppErrorComponent,
    ...(base && base !== "" ? { basepath: base } : {}),
  });
}