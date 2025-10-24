#include "unity.h"
#include "app/as7341.h"
#include "utils/test_harness.h"
#include "globals.h"

I2C_HandleTypeDef i2c_handle;

void setUp(void) {
    HAL_I2C_Init(&i2c_handle);
    PD_I2c_Init(&i2c_handle);
}

void tearDown(void) {
    HAL_I2C_DeInit(&i2c_handle);
}

void test_i2c_initialization(void) {
    PD_I2c_Init(&i2c_handle);
    TEST_ASSERT_EQUAL(&i2c_handle, get_i2c());
}

void test_device_power_on(void) {
    PD_Power_On();
    TEST_ASSERT_EQUAL(1, read_register(REG_ENABLE));
}

void test_device_power_off(void) {
    PD_Power_Off();
    TEST_ASSERT_EQUAL(0, read_register(REG_ENABLE));
}

void test_led_control(void) {
    PD_LED_On();
    TEST_ASSERT_EQUAL_HEX8(0b10000100, read_register(REG_LED));

    PD_LED_Off();
    TEST_ASSERT_EQUAL_HEX8(0b00000100, read_register(REG_LED));
}

void test_measurement_enable(void) {
    PD_Measurement_Enable();
    TEST_ASSERT_TRUE(PD_Measurement_Enabled());
}

void test_measurement_disable(void) {
    PD_Measurement_Disable();
    TEST_ASSERT_FALSE(PD_Measurement_Enabled());
}

void test_polling_mode_measurements(void) {
    PD_Measurement_Enable();
    HAL_Delay(5000);
    TEST_ASSERT_FALSE(PD_Get_LowInterrupt());
    TEST_ASSERT_FALSE(PD_Get_HighInterrupt());
}

void test_interrupt_mode_measurements(void) {
    PD_Set_LowThreshold(100);
    PD_Set_HighThreshold(1000);
    PD_Enable_Interrupt();

    wait_for_measurement();

    TEST_ASSERT_TRUE(PD_Get_LowInterrupt() || PD_Get_HighInterrupt());
}

void test_measurement_non_zero(void) {
    uint16_t measurement = PD_Get_Value();
    TEST_ASSERT_GREATER_THAN(0, measurement);
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_i2c_initialization);
    RUN_TEST(test_device_power_on);
    RUN_TEST(test_device_power_off);
    RUN_TEST(test_led_control);
    RUN_TEST(test_measurement_enable);
    RUN_TEST(test_measurement_disable);
    RUN_TEST(test_polling_mode_measurements);
    RUN_TEST(test_interrupt_mode_measurements);
    RUN_TEST(test_measurement_non_zero);
    return UNITY_END();
}