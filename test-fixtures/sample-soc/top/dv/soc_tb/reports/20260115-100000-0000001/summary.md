# Run 20260115-100000-0000001

fail: 3/4 tests passed.

Example data for the RTL Diagram extension. Not a real simulation.

- SOC-IRQ-001 (error): Expected irq_o=1 the cycle after timer 0 expired with IRQ_EN[0]=1; irq_o stayed 0 for 8 cycles.
- SOC-TMR-002 (warning): Timer 1 in MODE_ONESHOT pulsed expired twice, 3 cycles apart; may be intended if LOAD was rewritten.
- SOC-EVT-003 (note): evt_count_o could not be bound: the design document names it but the DUT has no such port.
