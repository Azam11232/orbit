import { useEffect, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { ArrowRight } from 'lucide-react';
import { advanceSlideConfirmation, finishSlideConfirmation, shouldPreventTrackJump, SLIDE_CONFIRMATION_THRESHOLD, type SlideConfirmationState } from './slideConfirmation';

type SlideConfirmationPhase =
  | 'idle'
  | 'submitting'
  | 'pending'
  | 'success'
  | 'rejected'
  | 'failed';

const initialState: SlideConfirmationState = { value: 0, submitted: false };

interface SlideStyle extends CSSProperties {
  '--slide-progress': string;
}

export function SlideToConfirm({
  label = 'Slide to confirm',
  phase = 'idle',
  disabled = false,
  confirmationKey,
  requirePointerDrag = false,
  onConfirm,
}: {
  label?: string;
  phase?: SlideConfirmationPhase;
  disabled?: boolean;
  confirmationKey: string;
  requirePointerDrag?: boolean;
  onConfirm: () => void | Promise<unknown>;
}) {
  const [slide, setSlide] = useState(initialState);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const slideRef = useRef(initialState);
  const phaseRef = useRef(phase);
  const pointerActiveRef = useRef(false);
  const submissionInFlightRef = useRef(false);

  phaseRef.current = phase;

  useEffect(() => {
    if (
      submissionInFlightRef.current ||
      phase === 'submitting' ||
      phase === 'pending' ||
      phase === 'success'
    ) return;
    const reset = () => {
      slideRef.current = initialState;
      setSlide(initialState);
      setLocalSubmitting(false);
      setSubmissionError(null);
      pointerActiveRef.current = false;
      submissionInFlightRef.current = false;
    };
    reset();
  }, [confirmationKey, phase]);

  useEffect(() => {
    if (phase !== 'failed' && phase !== 'rejected') return;
    slideRef.current = initialState;
    setSlide(initialState);
    setLocalSubmitting(false);
    pointerActiveRef.current = false;
    submissionInFlightRef.current = false;
  }, [phase]);

  const confirm = async () => {
    if (submissionInFlightRef.current) return;
    submissionInFlightRef.current = true;
    setLocalSubmitting(true);
    setSubmissionError(null);
    try {
      await onConfirm();
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : 'Unable to start this transaction.');
      if (phaseRef.current !== 'pending' && phaseRef.current !== 'success') {
        slideRef.current = initialState;
        setSlide(initialState);
      }
      setLocalSubmitting(false);
      pointerActiveRef.current = false;
    } finally {
      if (phaseRef.current === 'failed' || phaseRef.current === 'rejected') {
        slideRef.current = initialState;
        setSlide(initialState);
        setLocalSubmitting(false);
      }
      submissionInFlightRef.current = false;
    }
  };

  const preventTrackJump = (event: React.PointerEvent<HTMLInputElement>) => {
    if (disabled || slideRef.current.submitted) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    if (shouldPreventTrackJump(event.clientX, bounds.left, bounds.width, slideRef.current.value)) {
      event.preventDefault();
      return;
    }
    pointerActiveRef.current = true;
  };

  const finish = (pointerRelease = false) => {
    const pointerWasActive = pointerActiveRef.current;
    pointerActiveRef.current = false;
    const canStart = phase === 'idle' || phase === 'failed' || phase === 'rejected';
    const result = finishSlideConfirmation(
      slideRef.current,
      disabled || !canStart,
      !requirePointerDrag || (pointerRelease && pointerWasActive),
      requirePointerDrag ? 100 : undefined,
    );
    slideRef.current = result.state;
    setSlide(result.state);
    if (result.shouldConfirm) void confirm();
  };

  const updateValue = (value: number) => {
    const canStart = phase === 'idle' || phase === 'failed' || phase === 'rejected';
    const result = advanceSlideConfirmation(slideRef.current, value, disabled || !canStart);
    slideRef.current = result.state;
    setSlide(result.state);
    if (!requirePointerDrag && !pointerActiveRef.current && result.state.value >= SLIDE_CONFIRMATION_THRESHOLD) finish();
  };

  const resetIncompleteSlide = () => {
    pointerActiveRef.current = false;
    if (slideRef.current.submitted || submissionInFlightRef.current) return;
    slideRef.current = initialState;
    setSlide(initialState);
  };

  const isLocked = disabled
    || slide.submitted
    || phase === 'submitting'
    || phase === 'pending'
    || phase === 'success';
  const text = phase === 'submitting' || localSubmitting
    ? 'Submitting…'
    : phase === 'pending'
      ? 'Transaction pending'
      : phase === 'success'
        ? 'Confirmed'
        : phase === 'rejected'
          ? 'Rejected · slide to retry'
          : phase === 'failed'
            ? 'Failed · slide to retry'
            : disabled
              ? 'Confirmation unavailable'
              : slide.submitted
                ? 'Submitted'
                : slide.value > 0
                  ? 'Keep sliding to confirm'
                  : label;

  return (
    <div
      className={`slide-confirm ${isLocked ? 'is-locked' : ''} ${phase === 'success' ? 'is-success' : ''}`}
      style={{ '--slide-progress': `${slide.value}%` } as SlideStyle}
    >
      <span className="slide-confirm__instruction" aria-hidden="true">{text}</span>
      <span className="slide-confirm__thumb" aria-hidden="true"><ArrowRight size={18} strokeWidth={2.2} /></span>
      <input
        className="slide-confirm__input"
        type="range"
        min={0}
        max={100}
        step={1}
        value={slide.value}
        aria-label={label}
        aria-valuetext={text}
        aria-valuenow={slide.value}
        disabled={isLocked}
        onPointerDown={preventTrackJump}
        onPointerUp={() => finish(true)}
        onPointerCancel={resetIncompleteSlide}
        onBlur={resetIncompleteSlide}
        onChange={(event) => updateValue(Number(event.currentTarget.value))}
      />
      {submissionError && <p className="slide-confirm__error" role="alert">{submissionError}</p>}
    </div>
  );
}
