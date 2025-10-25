#include "Inc/utils/serial.h"
#include "PD_driver.h"
#include <stdbool.h>

#define TIMEOUT 5000
#define POLL_SAMPLES 10
#define EXPECTED_SENSOR_ID 0x09
#define LOW_THRESHOLD 100
#define HIGH_THRESHOLD 200
#define IMPOSSIBLE_LOW 0xFFFF
#define IMPOSSIBLE_HIGH 0xFFFF

void test_PD_driver_integration(void) {
    UART_HandleTypeDef huart;
    Serial_Init(&huart);

    // Wait for readiness
    Ready_Wait();

    // Check sensor ID
    uint8_t id = 0;
    PD_ReadID(&id);
    if (id != EXPECTED_SENSOR_ID) {
        Send_Line("ID check failed");
        return;
    }

    // Configure thresholds
    PD_SetThresholds(LOW_THRESHOLD, HIGH_THRESHOLD);

    // Enable interrupts
    PD_EnableInterrupts();

    // Poll for interrupts
    for (int i = 0; i < POLL_SAMPLES; i++) {
        if (PD_Get_LowInterrupt() || PD_Get_HighInterrupt()) {
            Send_Line("Unexpected interrupt");
            return;
        }
    }

    // Check measurement validity
    if (PD_Get_Valid() == TRUE) {
        uint16_t measurement = 0;
        PD_ReadMeasurement(&measurement);
        Send_Line("Measurement valid");
    } else {
        Send_Line("Measurement invalid");
    }

    // Negative test: impossible thresholds
    PD_SetThresholds(IMPOSSIBLE_LOW, IMPOSSIBLE_HIGH);
    if (PD_Get_Valid() == TRUE) {
        Send_Line("Unexpected valid measurement");
    }
}

void test_PD_driver_error_handling(void) {
    // Simulate I2C NACK
    PD_SimulateNACK();
    if (PD_ReadID(NULL) != PD_ERROR_NACK) {
        Send_Line("NACK handling failed");
    }

    // Simulate bus error
    PD_SimulateBusError();
    if (PD_ReadID(NULL) != PD_ERROR_BUS) {
        Send_Line("Bus error handling failed");
    }

    // Simulate timeout
    PD_SimulateTimeout();
    if (PD_ReadID(NULL) != PD_ERROR_TIMEOUT) {
        Send_Line("Timeout handling failed");
    }
}

int main(void) {
    test_PD_driver_integration();
    test_PD_driver_error_handling();
    return 0;
}