#ifndef BIQUAD_H
#define BIQUAD_H

typedef struct {
    float b0, b1, b2;
    float a1, a2;
    float z1, z2;
} biquad_t;

void biquad_init(biquad_t *bq);

float biquad_process(biquad_t *bq, float x);

void biquad_set_peaking(biquad_t *bq,
                        float fs,
                        float freq,
                        float Q,
                        float gain_db);

                        
#endif
