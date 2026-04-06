#include <Arduino.h>
#include "driver/i2s_std.h"
#include <math.h>

#define SAMPLE_RATE 48000
#define BLOCK_SIZE  64

i2s_chan_handle_t tx_handle;
i2s_chan_handle_t rx_handle;

void setup()
{
    Serial.begin(115200);
    delay(2000);
    Serial.println("Starting Passthrough...");

    // ================= RX (FROM STM32 via I2S0 SLAVE - STEREO) =================
    i2s_chan_config_t rx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
    rx_cfg.dma_desc_num  = 32;
    rx_cfg.dma_frame_num = 128;

    ESP_ERROR_CHECK(i2s_new_channel(&rx_cfg, NULL, &rx_handle));

    i2s_std_config_t rx_std_cfg = {
        .clk_cfg  = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_STEREO   // FIXED: was MONO
                    ),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_15,
            .ws   = GPIO_NUM_16,
            .dout = I2S_GPIO_UNUSED,
            .din  = GPIO_NUM_17,
        },
    };

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(rx_handle, &rx_std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(rx_handle));

    // ================= TX (TO AMP via I2S1 MASTER - STEREO) =================
    i2s_chan_config_t tx_cfg = I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_1, I2S_ROLE_MASTER);
    tx_cfg.dma_desc_num  = 32;
    tx_cfg.dma_frame_num = 128;

    ESP_ERROR_CHECK(i2s_new_channel(&tx_cfg, &tx_handle, NULL));

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

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &tx_std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
    
    Serial.println("I2S Passthrough running");
}

void loop()
{
    // Buffer for 16-bit stereo input (L + R)
    int16_t rx_buf[BLOCK_SIZE * 2];

    // Buffer for 32-bit stereo output
    int32_t tx_buf[BLOCK_SIZE * 2];
    
    size_t bytes_read = 0;
    size_t bytes_written = 0;

    // 1. Read from RX
    esp_err_t err = i2s_channel_read(
        rx_handle,
        rx_buf,
        sizeof(rx_buf),
        &bytes_read,
        pdMS_TO_TICKS(100)
    );

    if (err == ESP_OK && bytes_read > 0) {
        // Number of stereo frames
        int frames_read = bytes_read / (sizeof(int16_t) * 2);

        // 2. Extract LEFT channel and duplicate to stereo 32-bit
        for (int i = 0; i < frames_read; i++) {
            int16_t left_sample = rx_buf[i * 2];  // LEFT slot

            int32_t sample_32 = (int32_t)left_sample << 16;

            tx_buf[i * 2]     = sample_32; // Left out
            tx_buf[i * 2 + 1] = sample_32; // Right out
        }

        // 3. Write to TX
        i2s_channel_write(
            tx_handle,
            tx_buf,
            frames_read * 2 * sizeof(int32_t),
            &bytes_written,
            pdMS_TO_TICKS(100)
        );
    }
}