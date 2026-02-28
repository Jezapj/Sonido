#include <Arduino.h>
#include "driver/i2s_std.h"
#include <math.h>

#define SAMPLE_RATE 48000
#define TONE_FREQ   440.0f

i2s_chan_handle_t tx_handle;

void setup()
{
    Serial.begin(115200);
    delay(2000);

    i2s_chan_config_t chan_cfg =
        I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_MASTER);

    ESP_ERROR_CHECK(i2s_new_channel(&chan_cfg, &tx_handle, NULL));

    i2s_std_config_t std_cfg = {
        .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(SAMPLE_RATE),
        .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
                        I2S_DATA_BIT_WIDTH_16BIT,
                        I2S_SLOT_MODE_MONO),
        .gpio_cfg = {
            .mclk = I2S_GPIO_UNUSED,
            .bclk = GPIO_NUM_10,
            .ws   = GPIO_NUM_11,
            .dout = GPIO_NUM_12,
            .din  = I2S_GPIO_UNUSED,
        },
    };

    ESP_ERROR_CHECK(i2s_channel_init_std_mode(tx_handle, &std_cfg));
    ESP_ERROR_CHECK(i2s_channel_enable(tx_handle));
}

void loop()
{
    static float phase = 0;
    int16_t samples[256];
    size_t bytes_written;

    for (int i = 0; i < 256; i++)
    {
        float s = sinf(phase);
        samples[i] = (int16_t)(s * 2000);  // softer level
        phase += 2.0f * M_PI * TONE_FREQ / SAMPLE_RATE;
        if (phase > 2.0f * M_PI)
            phase -= 2.0f * M_PI;
    }

    i2s_channel_write(tx_handle,
                      samples,
                      sizeof(samples),
                      &bytes_written,
                      portMAX_DELAY);
}