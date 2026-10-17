// Lets components that handle their own taps (pedal picks, clef toggle…)
// tell the MagicBento card not to treat the same click as a "focus" click.

let handledAt = -Infinity;

export function markClickHandled(): void {
  handledAt = performance.now();
}

export function wasClickHandled(windowMs = 400): boolean {
  return performance.now() - handledAt < windowMs;
}
