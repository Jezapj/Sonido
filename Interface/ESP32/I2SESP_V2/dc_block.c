#include "dc_block.h"

void dcblock_init(dcblock_t *dc, float R)
{
    dc->x1 = 0.0f;
    dc->y1 = 0.0f;
    dc->R  = R;
}

float dcblock_process(dcblock_t *dc, float x)
{
    float y = x - dc->x1 + dc->R * dc->y1;

    dc->x1 = x;
    dc->y1 = y;

    return y;
}
