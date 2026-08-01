export interface ControlPlanePlaceholder {
  readonly mode: "fixture-only";
  readonly liveCallbackEnabled: false;
}
export const CONTROL_STAGE0: ControlPlanePlaceholder = Object.freeze({
  mode: "fixture-only",
  liveCallbackEnabled: false,
});
// Live Nango callbacks/webhooks are deliberately absent until verification blockers are resolved.
