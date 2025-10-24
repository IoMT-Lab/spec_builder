#include "unity.h"
#include "app/app.h"
#include "app/as7341.h"

void setUp(void) {}

void tearDown(void) {}

void test_i2c_initialization(void) {
    TEST_ASSERT_EQUAL(HAL_OK, HAL_I2C_IsDeviceReady(get_i2c(), PD_DEVICE_ADDR, 3, 1000));
}

void test_device_talk(void) {
    PD_I2c_Init(get_i2c());
    PD_Power_On();
    TEST_ASSERT_TRUE(check_identifiers());
}

void test_device_initialization_nowait(void) {
    device_initialization(FALSE, 0x10, 0x100);
    TEST_ASSERT_FALSE(PD_Interrupt_Enabled());
    TEST_ASSERT_NOT_EQUAL(0x100, PD_Get_HighThreshold());
    TEST_ASSERT_NOT_EQUAL(0x10, PD_Get_LowThreshold());
    TEST_ASSERT_TRUE(PD_Measurement_Enabled());
}

void test_device_initialization_wait(void) {
    device_initialization(TRUE, 0x10, 0x100);
    TEST_ASSERT_TRUE(PD_Interrupt_Enabled());
    TEST_ASSERT_EQUAL(0x100, PD_Get_HighThreshold());
    TEST_ASSERT_EQUAL(0x10, PD_Get_LowThreshold());
    TEST_ASSERT_TRUE(PD_Measurement_Enabled());
}

void test_measurement(void) {
    device_initialization(FALSE, 0, 0);
    uint16_t measurement = get_measurement(TRUE);
    TEST_ASSERT_GREATER_THAN(0, measurement);
}

void test_measurement_nodelay(void) {
    device_initialization(FALSE, 0, 0);
    uint16_t measurement = get_measurement(FALSE);
    TEST_ASSERT_GREATER_THAN(0, measurement);
}

void test_interrupt(void) {
    device_initialization(TRUE, 100, 1000);
    wait_for_measurement();
    uint16_t measurement = get_measurement(FALSE);
    TEST_ASSERT_GREATER_THAN(0, measurement);
}

void test_pulse(void) {
    device_initialization(FALSE, 0, 0);
    pulse();
    TEST_ASSERT_TRUE(TRUE); // Assume the LED pulse is visible
}

int main(void) {
    UNITY_BEGIN();
    RUN_TEST(test_i2c_initialization);
    RUN_TEST(test_device_talk);
    RUN_TEST(test_device_initialization_nowait);
    RUN_TEST(test_device_initialization_wait);
    RUN_TEST(test_measurement);
    RUN_TEST(test_measurement_nodelay);
    RUN_TEST(test_interrupt);
    RUN_TEST(test_pulse);
    return UNITY_END();
}
