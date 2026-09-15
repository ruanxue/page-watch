// A short-lived gate used only while the runner has verified that it can
// safely recycle itself. Workers check it before claiming another queue item;
// API requests may still enqueue work, which is then picked up immediately
// after the fresh runner starts.
let draining = false;

export function isExecutionEngineDraining() {
  return draining;
}

export function beginExecutionEngineDrain() {
  if (draining) return false;
  draining = true;
  return true;
}

export function cancelExecutionEngineDrain() {
  draining = false;
}
