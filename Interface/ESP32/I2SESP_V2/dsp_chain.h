#ifndef DSP_CHAIN_H
#define DSP_CHAIN_H

#include "biquad.h"
#include "dc_block.h"
#include "dsp_params.h"

typedef struct {
    float sample_rate;

    dcblock_t dc;

    biquad_t eq_low;
    biquad_t eq_mid;
    biquad_t eq_high;

} dsp_chain_t;

void dsp_chain_init(dsp_chain_t *dsp, float fs);

void dsp_chain_update_params(dsp_chain_t *dsp,
                             dsp_params_t *params);

float dsp_chain_process_sample(dsp_chain_t *dsp,
                               dsp_params_t *params,
                               float x);

void dsp_chain_process_block(dsp_chain_t *dsp,
                             dsp_params_t *params,
                             float *input,
                             float *output,
                             int block_size);

#endif
