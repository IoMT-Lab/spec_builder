#include "utils/test_harness.h"
#include "app/app.h"
#include "app/as7341.h"

#include "stm32wb0x_hal.h"
#include "globals.h"

#define EXPECTED_AUX_ID 0x0F
#define EXPECTED_REV_ID 0x01
#define EXPECTED_ID 0x02

static void setUp(void) {
    // Initialize I2C and GPIO here
}

static void tearDown(void) {
    // Clean up if necessary
}

TEST_ASSERT PD_Test_Check_Identifiers(void) {
    // Testing identifier check
    TEST_ASSERT_TRUE(check_identifiers());
}

TEST_ASSERT PD_Test_Read_Ids(void) {
    // Simulate valid readings
    HAL_I2C_SetValue(EXPECTED_AUX_ID, EXPECTED_REV_ID, EXPECTED_ID);
    TEST_ASSERT_EQUAL(EXPECTED_AUX_ID, PD_Get_AuxID());
    TEST_ASSERT_EQUAL(EXPECTED_REV_ID, PD_Get_RevID());
    TEST_ASSERT_EQUAL(EXPECTED_ID, PD_Get_ID());
}

TEST_ASSERT PD_Test_Device_Initialization(void) {
    device_initialization(TRUE, 1000, 10000);
    TEST_ASSERT_TRUE(PD_Measurement_Enabled());
    TEST_ASSERT_EQUAL(1000, PD_Get_LowThreshold());
    TEST_ASSERT_EQUAL(10000, PD_Get_HighThreshold());
}

TEST_ASSERT PD_Test_Polling_And_Interrupts(void) {
    PD_Measurement_Enable();
    HAL_Delay(5000);
    uint16_t measurement = get_measurement(TRUE);
    TEST_ASSERT_TRUE(measurement > 0);
}

TEST_ASSERT PD_Test_Pulse_LED(void) {
    pulse();
    // Confirm LED toggled - manual check needs to be implemented
}

TEST_ASSERT PD_Test_Error_Handling(void) {
    PD_Set_LowThreshold(0xFFFF); // Set impossible value
    TEST_ASSERT_FALSE(PD_Get_LowInterrupt());
}

void run_all_tests(void) {
    setUp();
    PD_Test_Check_Identifiers();
    PD_Test_Read_Ids();
    PD_Test_Device_Initialization();
    PD_Test_Polling_And_Interrupts();
    PD_Test_Pulse_LED();
    PD_Test_Error_Handling();
    tearDown();
}

int main(void) {
    run_all_tests();
    return 0;
}