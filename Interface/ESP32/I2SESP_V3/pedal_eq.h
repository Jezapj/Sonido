#ifndef PEDAL_EQ_H
#define PEDAL_EQ_H

#include <stdint.h>

/*
 * Initialise the EQ + Pre-Gain pedal and register it at `slot_id`.
 * Call once from setup() in I2SESP_V3.ino.
 *
 * slot_id     — must match PEDAL_EQ_PREGAIN in the .ino and
 *               PEDAL_IDS['Blurry Lights'] in PedalOverlay.tsx (= 0).
 * sample_rate — pass (float)SAMPLE_RATE.
 */
void pedal_eq_init(uint8_t slot_id, float sample_rate);

#endif /* PEDAL_EQ_H */
