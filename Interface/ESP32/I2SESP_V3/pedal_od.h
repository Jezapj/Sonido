#ifndef PEDAL_OD_H
#define PEDAL_OD_H

#include <stdint.h>

/*
 * Overdrive pedal — soft-clip waveshaper with tone control.
 *
 * Matches the 'New York' entry in PEDAL_DEFS (PedalOverlay.tsx).
 * Parameter struct layout:
 *   float drive   [0, 1]  distortion amount
 *   float tone    [0, 1]  0 = warm/dark, 1 = bright/cutting
 *   float level   [0, 1]  output volume
 *
 * To add this pedal to the firmware:
 *   1. #include "pedal_od.h" in I2SESP_V3.ino
 *   2. Call pedal_od_init(PEDAL_OVERDRIVE, (float)SAMPLE_RATE) in setup().
 *   3. Uncomment #define PEDAL_OVERDRIVE 1 in I2SESP_V3.ino.
 */
void pedal_od_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_OD_H */
