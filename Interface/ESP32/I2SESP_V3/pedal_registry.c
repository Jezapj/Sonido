#include "pedal_registry.h"
#include <string.h>

static pedal_slot_t s_slots[PEDAL_REGISTRY_MAX];

void pedal_registry_register(uint8_t id,
                              pedal_params_fn  on_params,
                              pedal_process_fn on_process)
{
    if (id >= PEDAL_REGISTRY_MAX) return;
    s_slots[id].on_params   = on_params;
    s_slots[id].on_process  = on_process;
    s_slots[id].enabled     = false;
    s_slots[id].registered  = true;
}

void pedal_dispatch_params(uint8_t id, bool enabled,
                           const float *params, uint8_t n_params)
{
    if (id >= PEDAL_REGISTRY_MAX)      return;
    if (!s_slots[id].registered)       return;

    s_slots[id].enabled = enabled;
    if (enabled && s_slots[id].on_params)
        s_slots[id].on_params(params, n_params);
}

void pedal_process_chain(float *in, float *out, float *temp, int frames)
{
    /* Count active pedals first so we know when we hit the last one. */
    int active = 0;
    for (int i = 0; i < PEDAL_REGISTRY_MAX; i++)
        if (s_slots[i].registered && s_slots[i].enabled) active++;

    if (active == 0) {
        /* Bypass: copy straight through. */
        memcpy(out, in, (size_t)frames * sizeof(float));
        return;
    }

    if (active == 1) {
        /* Single pedal: process in → out directly, no temp needed. */
        for (int i = 0; i < PEDAL_REGISTRY_MAX; i++) {
            if (s_slots[i].registered && s_slots[i].enabled) {
                s_slots[i].on_process(in, out, frames);
                return;
            }
        }
    }

    /*
     * Multiple pedals: use `temp` as a working buffer.
     * Signal path: in → temp → temp → ... → out
     *
     * All intermediate steps run in-place in `temp` which is safe because
     * dsp_chain_process_block reads input[i] before writing output[i] in
     * the same position.  The last pedal writes directly to `out`.
     */
    memcpy(temp, in, (size_t)frames * sizeof(float));

    int processed = 0;
    for (int i = 0; i < PEDAL_REGISTRY_MAX; i++) {
        if (!s_slots[i].registered || !s_slots[i].enabled) continue;
        processed++;

        if (processed == active)
            s_slots[i].on_process(temp, out,  frames); /* last: write to out  */
        else
            s_slots[i].on_process(temp, temp, frames); /* mid: in-place temp  */
    }
}
