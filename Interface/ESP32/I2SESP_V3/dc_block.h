#ifndef DC_BLOCK_H
#define DC_BLOCK_H

typedef struct {
    float x1;
    float y1;
    float R;
} dcblock_t;

void dcblock_init(dcblock_t *dc, float R);

float dcblock_process(dcblock_t *dc, float x);

#endif
