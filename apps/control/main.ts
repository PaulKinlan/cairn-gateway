export interface ControlPlanePlaceholder {
  readonly mode: "fixture-only";
  readonly liveCallbackEnabled: false;
}
export const CONTROL_STAGE0: ControlPlanePlaceholder = Object.freeze({
  mode: "fixture-only",
  liveCallbackEnabled: false,
});
export { R1OwnerUiSession, type R1OwnerView } from "./r1_ui.ts";
// Live Nango callbacks/webhooks are deliberately absent until verification blockers are resolved.
