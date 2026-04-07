#include <Arduino.h>
#include "driver/i2s_std.h"

#define SAMPLE_RATE 47991
#define BLOCK_SIZE  64

i2s_chan_handle_t tx_handle;
i2s_chan_handle_t rx_handle;

void setup()
{
    // ================= RX (I2S0 SLAVE - STEREO) =================
    i2s_chan_config_t rx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    rx_cfg.dma_desc_num  = 8;
    rx_cfg.dma_frame_num = 64;

    i2s_new_channel(&rx_cfg, NULL, &rx_handle);

    i2s_std_config_t rx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO
                    ),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_15,
            .ws   = GPIO_NUM_16,
            .dout = I2S_GPIO_UNUSED,
            .din  = GPIO_NUM_17,
        },
    };

    i2s_channel_init_std_mode(rx_handle, &rx_std_cfg);
    i2s_channel_enable(rx_handle);

    // ================= TX (I2S1 MASTER - STEREO) =================
    i2s_chan_config_t tx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    tx_cfg.dma_desc_num  = 8;
    tx_cfg.dma_frame_num = 64;

    i2s_new_channel(&tx_cfg, &tx_handle, NULL);

    i2s_std_config_t tx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_32BIT,
                        I2S_SLOT_MODE_STEREO
                    ),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_10,
            .ws   = GPIO_NUM_11,
            .dout = GPIO_NUM_12,
            .din  = I2S_GPIO_UNUSED,
        },
    };

    i2s_channel_init_std_mode(tx_handle, &tx_std_cfg);
    i2s_channel_enable(tx_handle);
}

void loop()
{
    int16_t rx_buf[BLOCK_SIZE * 2];
    int32_t tx_buf[BLOCK_SIZE * 2];

    size_t bytes_read;
    size_t bytes_written;

    // Blocking read (no timeout → lowest jitter)
    i2s_channel_read(rx_handle, rx_buf, sizeof(rx_buf), &bytes_read, portMAX_DELAY);

    int frames = bytes_read >> 2; // (sizeof(int16_t)*2) = 4 bytes per frame

    for (int i = 0; i < frames; i++) {
        //int32_t s = ((int32_t)rx_buf[i * 2]) << 16; // LEFT channel
        int32_t s = ((int32_t)rx_buf[i * 2] + (int32_t)rx_buf[i * 2 + 1]) << 15;

        tx_buf[i * 2]     = s;
        tx_buf[i * 2 + 1] = s;
    }

    i2s_channel_write(tx_handle, tx_buf, frames * 2 * sizeof(int32_t), &bytes_written, portMAX_DELAY);
}