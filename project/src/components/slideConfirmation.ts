export interface SlideConfirmationState {
  value: number;
  submitted: boolean;
}

export const SLIDE_CONFIRMATION_THRESHOLD = 95;

export function shouldPreventTrackJump(clientX: number, left: number, width: number, value: number): boolean {
  const thumbCenter = 22 + (value / 100) * Math.max(0, width - 44);
  return Math.abs(clientX - left - thumbCenter) > 22;
}

export function advanceSlideConfirmation(
  state: SlideConfirmationState,
  value: number,
  disabled = false,
): { state: SlideConfirmationState; shouldConfirm: false } {
  if (disabled || state.submitted) return { state, shouldConfirm: false };
  const nextValue = Math.max(0, Math.min(100, Math.round(value)));
  return {
    state: { value: nextValue, submitted: false },
    shouldConfirm: false,
  };
}

export function finishSlideConfirmation(
  state: SlideConfirmationState,
  disabled = false,
  releaseAllowed = true,
  threshold = SLIDE_CONFIRMATION_THRESHOLD,
): { state: SlideConfirmationState; shouldConfirm: boolean } {
  if (disabled || state.submitted) return { state, shouldConfirm: false };
  if (!releaseAllowed || state.value < threshold) {
    return { state: { value: 0, submitted: false }, shouldConfirm: false };
  }
  return { state: { value: 100, submitted: true }, shouldConfirm: true };
}
