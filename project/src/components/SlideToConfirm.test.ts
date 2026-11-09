import { describe, expect, it } from 'vitest';
import { advanceSlideConfirmation, finishSlideConfirmation, shouldPreventTrackJump, SLIDE_CONFIRMATION_THRESHOLD } from './slideConfirmation';

describe('slide-to-confirm interaction gate', () => {
  it('does not submit while the thumb is moving', () => {
    const result = advanceSlideConfirmation({ value: 0, submitted: false }, 99);
    expect(result.shouldConfirm).toBe(false);
    expect(result.state).toEqual({ value: 99, submitted: false });
  });

  it('confirms once on release after the thumb reaches the deliberate threshold', () => {
    expect(SLIDE_CONFIRMATION_THRESHOLD).toBe(95);
    const dragging = advanceSlideConfirmation({ value: 0, submitted: false }, 95);
    const result = finishSlideConfirmation(dragging.state);
    expect(result.shouldConfirm).toBe(true);
    expect(result.state).toEqual({ value: 100, submitted: true });
    expect(finishSlideConfirmation(result.state).shouldConfirm).toBe(false);
  });

  it('does not confirm when released before the near-end threshold', () => {
    const dragging = advanceSlideConfirmation({ value: 0, submitted: false }, 94);
    expect(finishSlideConfirmation(dragging.state)).toEqual({
      state: { value: 0, submitted: false },
      shouldConfirm: false,
    });
  });

  it('does not treat a pointer release without an active drag as confirmation', () => {
    expect(finishSlideConfirmation({ value: 100, submitted: false }, false, false)).toEqual({
      state: { value: 0, submitted: false },
      shouldConfirm: false,
    });
  });

  it('requires an active drag to reach the endpoint for Bridge confirmations', () => {
    const nearlyComplete = advanceSlideConfirmation({ value: 0, submitted: false }, 99);
    expect(finishSlideConfirmation(nearlyComplete.state, false, true, 100)).toEqual({
      state: { value: 0, submitted: false },
      shouldConfirm: false,
    });

    const atEndpoint = advanceSlideConfirmation({ value: 0, submitted: false }, 100);
    expect(finishSlideConfirmation(atEndpoint.state, false, true, 100).shouldConfirm).toBe(true);
    expect(finishSlideConfirmation(atEndpoint.state, false, false, 100).shouldConfirm).toBe(false);
  });

  it('resets early release without submitting', () => {
    const dragging = advanceSlideConfirmation({ value: 0, submitted: false }, 89);
    expect(finishSlideConfirmation(dragging.state)).toEqual({
      state: { value: 0, submitted: false },
      shouldConfirm: false,
    });
  });

  it('blocks disabled confirmation and clamps slider values', () => {
    expect(finishSlideConfirmation({ value: 100, submitted: false }, true).shouldConfirm).toBe(false);
    expect(advanceSlideConfirmation({ value: 0, submitted: false }, 101).state.value).toBe(100);
    expect(advanceSlideConfirmation({ value: 0, submitted: false }, -1).state.value).toBe(0);
  });

  it('allows only a deliberate retry after a failed attempt is reset', () => {
    const failedAttempt = finishSlideConfirmation(advanceSlideConfirmation({ value: 0, submitted: false }, 100).state);
    expect(finishSlideConfirmation(failedAttempt.state).shouldConfirm).toBe(false);
    expect(finishSlideConfirmation({ value: 0, submitted: false }).shouldConfirm).toBe(false);
    expect(finishSlideConfirmation(advanceSlideConfirmation({ value: 0, submitted: false }, 100).state).shouldConfirm).toBe(true);
  });

  it('allows a new deliberate confirmation after the reviewed details change', () => {
    const first = finishSlideConfirmation(advanceSlideConfirmation({ value: 0, submitted: false }, 100).state);
    const changedReview = { value: 0, submitted: false };
    expect(first.shouldConfirm).toBe(true);
    expect(finishSlideConfirmation(advanceSlideConfirmation(changedReview, 100).state).shouldConfirm).toBe(true);
  });

  it('requires pointer input to begin at the thumb instead of jumping to the track end', () => {
    expect(shouldPreventTrackJump(198, 0, 400, 0)).toBe(true);
    expect(shouldPreventTrackJump(22, 0, 400, 0)).toBe(false);
    expect(shouldPreventTrackJump(378, 0, 400, 100)).toBe(false);
  });
});
