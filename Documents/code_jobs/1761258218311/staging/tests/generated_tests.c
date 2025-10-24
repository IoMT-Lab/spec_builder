#include "unity.h"
#include "app/as7341.h"
#include "globals.h"

void setUp(void) {
    PD_I2c_Init(get_i2c());
    PD_Power_On();
}

void tearDown(void) {
    PD_Power_Off();
}

void test_i2c_initialization(void) {
    TEST_ASSERT_EQUAL_INT32(HAL_OK, HAL_I2C_IsDeviceReady(get_i2c(), PD_DEVICE_ADDR, 3, 1000));
}

void test_power_on_device(void) {
    PD_Power_On();
    TEST_ASSERT_EQUAL_UINT8(1, read_register(0x80));
}

void test_identifiers_check(void) {
    TEST_ASSERT_TRUE(check_identifiers());
}

void test_led_control(void) {
    PD_Initialize_LED();
    PD_LED_On();
    TEST_ASSERT_EQUAL_UINT8(0b10000100, read_register(0x74));
    PD_LED_Off();
    TEST_ASSERT_EQUAL_UINT8(0b00000100, read_register(0x74));
}

void test_measurement_modes(void) {
    device_initialization(FALSE, 0, 0);
    TEST_ASSERT_TRUE(PD_Measurement_Enabled());
    PD_Enable_Interrupt();
    TEST_ASSERT_TRUE(PD_Interrupt_Enabled());

    // Testing polling mode
    pulse();
    TEST_ASSERT_EQUAL_UINT8(0, read_register(0xF9)); // Interrupt registers unset

    // Testing interrupt mode
    PD_Set_LowThreshold(200);
    PD_Set_HighThreshold(800);
    HAL_Delay(1000);
    TEST_ASSERT_TRUE(PD_Get_LowInterrupt() || PD_Get_HighInterrupt());
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_i2c_initialization);
    RUN_TEST(test_power_on_device);
    RUN_TEST(test_identifiers_check);
    RUN_TEST(test_led_control);
    RUN_TEST(test_measurement_modes);
    return UNITY_END();
}
