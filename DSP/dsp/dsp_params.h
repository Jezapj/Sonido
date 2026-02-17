#ifndef DSP_PARAMS_H
#define DSP_PARAMS_H

typedef struct {
    float pre_gain;

    float eq_low_gain_db;
    float eq_mid_gain_db;
    float eq_high_gain_db;

    float eq_low_freq;
    float eq_mid_freq;
    float eq_high_freq;

    float eq_low_q;
    float eq_mid_q;
    float eq_high_q;

    float limiter_threshold;
} dsp_params_t;

#endif
