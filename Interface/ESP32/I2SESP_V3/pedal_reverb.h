
#ifndef PEDAL_REVERB_H
#define PEDAL_REVERB_H

#include <stdint.h>

/*
 * Reverb pedal — feedback delay network style ambience effect.
 *
 * Suggested controls:
 *   float decay  [0, 1]  reverb tail length / feedback amount
 *   float tone   [0, 1]  0 = dark/warm reflections, 1 = bright reflections
 *   float level  [0, 1]  wet/dry mix amount
 *
 * To add this pedal to the firmware:
 *   1. #include "pedal_reverb.h" in I2SESP_V3.ino
 *   2. Call pedal_reverb_init(PEDAL_REVERB, (float)SAMPLE_RATE) in setup().
 *   3. Define PEDAL_REVERB in your pedal slot configuration.
 */
void pedal_reverb_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_REVERB_H */