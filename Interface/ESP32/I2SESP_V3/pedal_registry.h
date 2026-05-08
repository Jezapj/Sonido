#ifndef PEDAL_REGISTRY_H
#define PEDAL_REGISTRY_H

#include <stdbool.h>
#include <stdint.h>

/*
 * pedal_registry — extensible function-pointer dispatch table.
 *
 * Adding a new pedal requires only:
 *   1. Create pedal_xyz.c / pedal_xyz.h next to I2SESP_V3.ino.
 *   2. Call pedal_xyz_init(PEDAL_XYZ_ID, sample_rate) from setup().
 *   3. Define PEDAL_XYZ_ID in I2SESP_V3.ino to match PEDAL_IDS[xyz] in
 *      PedalOverlay.tsx.
 *
 * The main .ino loop never needs to change.
 */

#define PEDAL_REGISTRY_MAX 8

/*
 * on_params  — called when a matching param packet arrives.
 *              n_params is the float count; validate it against your struct.
 * on_process — called each audio block if the slot is enabled.
 *              in/out buffers may overlap (in-place processing is safe).
 */
typedef void (*pedal_params_fn) (const float *params, uint8_t n_params);
typedef void (*pedal_process_fn)(float *in, float *out, int frames);

typedef struct {
    pedal_params_fn  on_params;
    pedal_process_fn on_process;
    bool             enabled;
    bool             registered;
} pedal_slot_t;

/*
 * Register a pedal at a specific slot index.
 * Call from each pedal's init function.
 */
void pedal_registry_register(uint8_t id,
                              pedal_params_fn  on_params,
                              pedal_process_fn on_process);

/*
 * Deliver a param packet to the appropriate slot.
 * Called by check_serial_params() in the .ino after a packet is verified.
 */
void pedal_dispatch_params(uint8_t id, bool enabled,
                           const float *params, uint8_t n_params);

/*
 * Run the full pedal chain: signal flows through all enabled, registered
 * slots in ascending slot-index order.
 *
 *   in    — read-only input samples  (BLOCK_SIZE floats)
 *   out   — final output samples     (BLOCK_SIZE floats)
 *   temp  — scratch buffer           (must be >= BLOCK_SIZE floats)
 *
 * If no pedals are active, `in` is copied to `out` unchanged.
 */
void pedal_process_chain(float *in, float *out, float *temp, int frames);

#endif /* PEDAL_REGISTRY_H */
